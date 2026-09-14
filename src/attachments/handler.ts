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
import { RetryableProcessingError } from '../core/errors';
import { AttachmentTransferEvent } from '../core/events';
import { executeOutboundOperation } from '../core/outbound-operations';
import { deliverAttachmentToChatwoot, deliverAttachmentToTelegram, loadAttachmentBuffer } from './delivery';
import { AttachmentProcessingError, downloadChatwootAttachment, downloadTelegramAttachment, storeAttachmentStream } from './source';

export async function processAttachmentTransfer(event: AttachmentTransferEvent, env: Env): Promise<void> {
  const config = getAttachmentConfig(env);
  const existing = await getAttachment(env, event.payload.attachmentId);
  if (!existing || existing.status === 'DELIVERED' || existing.status === 'FAILED_FINAL') return;
  const tokenHash = await hashAttachmentToken(event.payload.accessToken);
  if (tokenHash !== existing.access_token_hash) {
    throw new RetryableProcessingError('Attachment job token was superseded', 1);
  }
  let row = existing;
  if (existing.status !== 'STORED') {
    const claim = await claimAttachment(env, event.payload.attachmentId);
    if (claim.outcome === 'EXHAUSTED') {
      await markAttachmentFailure(
        env,
        claim.row.id,
        false,
        claim.row.last_error || 'ATTACHMENT_ATTEMPTS_EXHAUSTED',
        config
      );
      return;
    }
    if (claim.outcome === 'NOT_CLAIMED') {
      if (!claim.row || claim.row.status === 'DELIVERED' || claim.row.status === 'FAILED_FINAL') return;
      if (claim.row.status !== 'STORED') {
        throw new RetryableProcessingError('Attachment source claim was not acquired', 2);
      }
      row = claim.row;
    } else {
      row = claim.row;
    }
  }
  if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
    await markAttachmentFailure(env, row.id, false, 'EXPIRED', config);
    return;
  }
  try {
    if (row.status !== 'STORED') {
      if (event.payload.locator.provider !== row.source_provider) {
        throw new AttachmentProcessingError('INVALID_METADATA', false);
      }
      const source = event.payload.locator.provider === 'telegram'
        ? await downloadTelegramAttachment(env, event.payload.locator.fileId, row.size_bytes, config)
        : await downloadChatwootAttachment(env, event.payload.locator.dataUrl, config);
      let size: number;
      try {
        size = await storeAttachmentStream(env.ATTACHMENTS_BUCKET, row, source.body, config.maxBytes);
      } finally {
        source.finish();
      }
      const stored = await markAttachmentStored(env, row.id, size, config);
      if (!stored) throw new RetryableProcessingError('Attachment storage result was not persisted', 2);
      row = { ...row, status: 'STORED', size_bytes: size };
    }

    const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
      .bind(row.conversation_id).first<any>();
    if (!conversation) throw new AttachmentProcessingError('INVALID_METADATA', false);
    if (row.destination_provider === 'telegram' && !conversation.operator_thread_ref) {
      throw new AttachmentProcessingError('INVALID_METADATA', false);
    }
    if (
      row.destination_provider === 'chatwoot' &&
      (!conversation.helpdesk_account_ref || !conversation.helpdesk_conversation_ref)
    ) {
      throw new AttachmentProcessingError('INVALID_METADATA', false);
    }
    const bytes = await loadAttachmentBuffer(env.ATTACHMENTS_BUCKET, row, config.maxBytes);
    const operationId = `attachment_${row.destination_provider}:${row.id}`;
    const result = await executeOutboundOperation(
      env,
      row.conversation_id,
      row.destination_provider,
      'SEND_ATTACHMENT',
      async opId => row.destination_provider === 'chatwoot'
        ? deliverAttachmentToChatwoot(
            env, config, row, conversation.helpdesk_account_ref,
            conversation.helpdesk_conversation_ref, opId, bytes
          )
        : deliverAttachmentToTelegram(env, config, row, conversation.operator_thread_ref, bytes),
      operationId,
      { leaseSeconds: config.outboundLeaseSeconds }
    );

    if (result.status === 'SENT') {
      const delivered = await markAttachmentDelivered(env, row.id, result.providerMessageRef);
      if (!delivered) throw new RetryableProcessingError('Attachment delivery result was not persisted', 2);
    } else if (result.status === 'AMBIGUOUS' || result.status === 'FAILED_FINAL') {
      await markAttachmentFailure(env, row.id, false, `DESTINATION_${result.status}`, config);
    }
  } catch (error) {
    if (error instanceof RetryableProcessingError) throw error;
    if (error instanceof AttachmentProcessingError) {
      const failureStatus = await markAttachmentFailure(env, row.id, error.retryable, error.code, config);
      if (failureStatus === 'FAILED_RETRYABLE') throw new RetryableProcessingError(error.code, 2);
      return;
    }
    const code = error instanceof Error && ['R2_GET_FAILED', 'R2_OBJECT_MISSING', 'R2_OBJECT_TOO_LARGE'].includes(error.message)
      ? error.message
      : 'ATTACHMENT_PROCESSING_FAILED';
    if (code === 'R2_GET_FAILED' && row.status === 'STORED') {
      await recordStoredAttachmentError(env, row.id, code);
      throw new RetryableProcessingError(code, 2);
    }
    await markAttachmentFailure(env, row.id, false, code, config);
  }
}
