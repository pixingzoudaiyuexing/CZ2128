import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import {
  claimAttachment,
  getAttachment,
  markAttachmentDelivered,
  markAttachmentFailure,
  markAttachmentStored,
  recordStoredAttachmentError
} from '../core/attachment-repository';
import { hashAttachmentToken } from '../core/attachments';
import { RetryableProcessingError, SafeError, safeErrorCode } from '../core/errors';
import { AttachmentTransferEvent } from '../core/events';
import { executeOutboundOperation } from '../core/outbound-operations';
import {
  deliverAttachmentToChatwoot,
  deliverAttachmentToCrisp,
  deliverAttachmentToTelegram,
  loadAttachmentBuffer,
  prepareCrispAttachmentContent,
  prepareTelegramUploadNotification,
  deliverUploadNotificationToTelegram,
  telegramAttachmentMethod
} from './delivery';
import {
  AttachmentProcessingError,
  AttachmentSourceTelemetryContext,
  downloadChatwootAttachment,
  downloadCrispAttachment,
  downloadTelegramAttachment,
  storeAttachmentStream
} from './source';
import { buildChatwootTargetEvidence, buildCrispTargetEvidence, buildTelegramTargetEvidence } from '../core/outbound-evidence';
import { parseTelegramCustomerRequestOptions } from '../config/telegram-customer-ux';
import { crispIdentityRequestOptions, parseCrispIdentityRequestOptions } from '../config/crisp-identities';

export async function processAttachmentTransfer(event: AttachmentTransferEvent, env: Env): Promise<void> {
  const config = getAttachmentConfig(env);
  const existing = await getAttachment(env, event.payload.attachmentId);
  if (!existing || existing.status === 'DELIVERED' || existing.status === 'FAILED_FINAL') return;
  const tokenHash = await hashAttachmentToken(event.payload.accessToken);
  if (tokenHash !== existing.access_token_hash) {
    throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 1);
  }
  let row = existing;
  if (existing.status !== 'STORED') {
    const claim = await claimAttachment(env, event.payload.attachmentId);
    if (claim.outcome === 'EXHAUSTED') {
      await markAttachmentFailure(
        env,
        claim.row.id,
        false,
        'ATTACHMENT_RETRY_EXHAUSTED',
        config
      );
      return;
    }
    if (claim.outcome === 'NOT_CLAIMED') {
      if (!claim.row || claim.row.status === 'DELIVERED' || claim.row.status === 'FAILED_FINAL') return;
      if (claim.row.status !== 'STORED') {
        throw new RetryableProcessingError('QUEUE_EVENT_CLAIM_CONTENDED', 2);
      }
      row = claim.row;
    } else {
      row = claim.row;
    }
  }
  if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
    await markAttachmentFailure(env, row.id, false, 'ATTACHMENT_EXPIRED', config);
    return;
  }
  try {
    if (row.status !== 'STORED') {
      if (event.payload.locator.provider !== row.source_provider) {
        throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
      }
      let sourceTelemetry: AttachmentSourceTelemetryContext | undefined = event.payload.locator.provider === 'telegram'
        ? { attachmentId: row.id, attempt: row.attempt_count }
        : undefined;
      let source: { body: ReadableStream<Uint8Array>; finish: () => void };
      if (event.payload.locator.provider === 'telegram') {
        const telegramSource = await downloadTelegramAttachment(
          env,
          event.payload.locator.fileId,
          row.size_bytes,
          config,
          sourceTelemetry
        );
        source = telegramSource;
        if (sourceTelemetry) {
          sourceTelemetry = { ...sourceTelemetry, didTimeout: telegramSource.didTimeout };
        }
      } else if (event.payload.locator.provider === 'crisp') {
        source = await downloadCrispAttachment(event.payload.locator.dataUrl, config);
      } else if (event.payload.locator.provider === 'chatwoot') {
        source = await downloadChatwootAttachment(env, event.payload.locator.dataUrl, config);
      } else {
        throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
      }
      let size: number;
      try {
        size = await storeAttachmentStream(
          env.ATTACHMENTS_BUCKET,
          row,
          source.body,
          config.maxBytes,
          sourceTelemetry
        );
      } finally {
        source.finish();
      }
      const stored = await markAttachmentStored(env, row.id, size, config);
      if (!stored) throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 2);
      row = { ...row, status: 'STORED', size_bytes: size };
    }

    const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
      .bind(row.conversation_id).first<any>();
    if (!conversation) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
    if (row.destination_provider === 'telegram' && !conversation.operator_thread_ref) {
      throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
    }
    if (
      (row.destination_provider === 'chatwoot' || row.destination_provider === 'crisp') &&
      (conversation.helpdesk_provider !== row.destination_provider ||
       !conversation.helpdesk_account_ref || !conversation.helpdesk_conversation_ref)
    ) {
      throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
    }
    const uploadNotification = row.source_provider === 'upload' && row.destination_provider === 'telegram';
    const bytes = row.destination_provider === 'crisp' || uploadNotification
      ? undefined
      : await loadAttachmentBuffer(env.ATTACHMENTS_BUCKET, row, config.maxBytes);
    const crispContent = row.destination_provider === 'crisp'
      ? await prepareCrispAttachmentContent(
          env, row, event.payload.accessToken, event.payload.publicOrigin, config.maxBytes
        )
      : undefined;
    const telegramUploadContent = uploadNotification
      ? await prepareTelegramUploadNotification(
          env, row, event.payload.accessToken, event.payload.publicOrigin, config.maxBytes
        )
      : undefined;
    const operationId = `attachment_${row.destination_provider}:${row.id}`;
    const telegramUx = row.destination_provider === 'telegram'
      ? parseTelegramCustomerRequestOptions(row.request_options_json)
      : null;
    const crispIdentity = row.destination_provider === 'crisp'
      ? parseCrispIdentityRequestOptions(row.request_options_json)
      : null;
    const frozenRequestOptions = telegramUx
      ? telegramUx
      : crispIdentity
        ? crispIdentityRequestOptions(crispIdentity)
        : undefined;
    const targetEvidence = row.destination_provider === 'chatwoot'
      ? await buildChatwootTargetEvidence(
          env,
          conversation.helpdesk_account_ref,
          conversation.helpdesk_conversation_ref,
          operationId
        )
      : row.destination_provider === 'crisp'
        ? buildCrispTargetEvidence(
            conversation.helpdesk_account_ref,
            conversation.helpdesk_conversation_ref
          )
        : buildTelegramTargetEvidence(
            env,
            env.BOT_GROUP_ID,
            conversation.operator_thread_ref,
            uploadNotification ? 'sendMessage' : telegramAttachmentMethod(row).method
          );
    const result = await executeOutboundOperation(
      env,
      row.conversation_id,
      row.destination_provider,
      'SEND_ATTACHMENT',
      async (opId, lifecycle) => row.destination_provider === 'chatwoot'
        ? deliverAttachmentToChatwoot(
            env, config, row, conversation.helpdesk_account_ref,
            conversation.helpdesk_conversation_ref, opId, bytes!, lifecycle
          )
        : row.destination_provider === 'crisp'
          ? deliverAttachmentToCrisp(
              env, conversation.helpdesk_account_ref, conversation.helpdesk_conversation_ref,
              opId, crispContent!, lifecycle,
              parseCrispIdentityRequestOptions(lifecycle.requestOptionsJson) || undefined
            )
          : uploadNotification
            ? deliverUploadNotificationToTelegram(
                env, conversation.operator_thread_ref, telegramUploadContent!, lifecycle
              )
            : deliverAttachmentToTelegram(
                env, config, row, conversation.operator_thread_ref, bytes!, lifecycle,
                (() => {
                  const frozen = parseTelegramCustomerRequestOptions(lifecycle.requestOptionsJson);
                  return frozen ? { disableNotification: frozen.disableNotification } : undefined;
                })()
              ),
      operationId,
      {
        leaseSeconds: config.outboundLeaseSeconds,
        subject: { type: 'ATTACHMENT', ref: row.id },
        targetEvidence,
        ...(frozenRequestOptions ? { requestOptions: frozenRequestOptions } : {})
      }
    );

    if (result.status === 'SENT') {
      const delivered = await markAttachmentDelivered(env, row.id, result.providerMessageRef);
      if (!delivered) throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 2);
    } else if (result.status === 'AMBIGUOUS' || result.status === 'FAILED_FINAL') {
      await markAttachmentFailure(
        env,
        row.id,
        false,
        result.status === 'AMBIGUOUS' ? 'ATTACHMENT_DELIVERY_AMBIGUOUS' : 'ATTACHMENT_DELIVERY_FINAL',
        config
      );
    }
  } catch (error) {
    if (error instanceof RetryableProcessingError) throw error;
    if (error instanceof AttachmentProcessingError) {
      const failureStatus = await markAttachmentFailure(env, row.id, error.retryable, error.code, config);
      if (failureStatus === 'FAILED_RETRYABLE') {
        throw new RetryableProcessingError(error.code, error.retryAfterSeconds ?? 2, {
          provider: error.provider,
          stage: error.stage,
          httpStatus: error.httpStatus
        });
      }
      return;
    }
    const code = safeErrorCode(error);
    if (error instanceof SafeError && code === 'R2_READ_TRANSIENT' && row.status === 'STORED') {
      await recordStoredAttachmentError(env, row.id, code);
      throw new RetryableProcessingError(code, 2);
    }
    await markAttachmentFailure(env, row.id, false, code, config);
  }
}
