import { createChatwootMessage } from '../adapters/chatwoot/api';
import { createCrispMessage } from '../adapters/crisp/api';
import { answerTelegramCallbackQuery, sendTelegramMessage } from '../adapters/telegram/api';
import { getAIConfig } from '../config/ai';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { crispIdentityRequestOptions, crispOperatorIdentity, parseCrispIdentityRequestOptions } from '../config/crisp-identities';
import { parseTelegramCustomerRequestOptions } from '../config/telegram-customer-ux';
import { applyTelegramOperatorAction } from '../core/ai-state';
import { insertMessage } from '../core/conversation-service';
import { TelegramEvent } from '../core/events';
import { executeOutboundOperation, markOutboundOperationFinal } from '../core/outbound-operations';
import { enqueueAttachmentJobs } from '../core/attachment-repository';
import { buildChatwootTargetEvidence, buildCrispTargetEvidence, buildTelegramTargetEvidence, targetEvidenceMatches } from '../core/outbound-evidence';
import { createAndSendUploadInvite, revokeUploadInviteFromTelegram } from '../uploads/service';

function isAuthorizedUploadOperator(env: Env, operatorRef: string | undefined): operatorRef is string {
  if (!operatorRef || !/^[1-9]\d{0,19}$/.test(operatorRef)) return false;
  const allowed = (env.ADMIN_TELEGRAM_USER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^[1-9]\d{0,19}$/.test(value));
  return allowed.includes(operatorRef);
}

async function processTelegramControlEvent(event: Extract<TelegramEvent, { type: 'control_action' }>, env: Env): Promise<void> {
  const payload = event.payload;
  const matches = await env.DB.prepare(
    `SELECT o.conversation_id, o.request_options_json, o.target_evidence_json
     FROM outbound_operations o
     JOIN conversations c ON c.id = o.conversation_id
     WHERE o.destination_provider = 'telegram'
       AND o.operation_type = 'SEND_MESSAGE'
       AND o.status = 'SENT'
       AND o.provider_message_ref = ?
       AND o.subject_type = 'MESSAGE'
       AND o.subject_ref LIKE 'crisp:%'
       AND c.helpdesk_provider = 'crisp'
       AND c.operator_channel = 'telegram'
       AND c.operator_thread_ref = ?`
  ).bind(payload.messageRef, payload.threadRef).all<{
    conversation_id: string;
    request_options_json: string | null;
    target_evidence_json: string | null;
  }>();
  const rows = matches.results || [];
  const frozen = rows.length === 1 ? parseTelegramCustomerRequestOptions(rows[0].request_options_json) : null;
  const currentTarget = buildTelegramTargetEvidence(
    env,
    env.BOT_GROUP_ID,
    payload.threadRef,
    'sendMessage'
  );
  const targetMatches = rows.length === 1 && !!rows[0].target_evidence_json &&
    targetEvidenceMatches(rows[0].target_evidence_json, currentTarget);
  if (rows.length !== 1 || frozen?.controls !== 'AI_TOGGLE_V1' || !targetMatches) {
    await answerTelegramCallbackQuery(env, payload.callbackQueryRef, '按钮已失效，请使用最新客户消息上的按钮。');
    return;
  }

  const state = await applyTelegramOperatorAction(
    env,
    rows[0].conversation_id,
    payload.supportProfileVersion,
    payload.updateRef,
    payload.action
  );
  if (state === 'STALE' || state === 'STALE_PROFILE') {
    await answerTelegramCallbackQuery(env, payload.callbackQueryRef, '操作已失效，请使用最新客户消息上的按钮。');
    return;
  }
  const message = payload.action === 'AI_OFF'
    ? 'AI 已关闭，后续由人工客服处理。'
    : getAIConfig(env).enabled
      ? 'AI 已开启。'
      : 'AI 已允许，但当前 AI Provider 未配置。';
  await answerTelegramCallbackQuery(env, payload.callbackQueryRef, message);
}

export async function processTelegramEvent(event: TelegramEvent, env: Env): Promise<void> {
  if (event.type === 'control_action') {
    await processTelegramControlEvent(event, env);
    return;
  }
  const payload = event.payload;
  const supportProfileVersion = payload.supportProfileVersion ?? 0;
  const scopedMessageRef = `${supportProfileVersion}:${payload.messageRef}`;
  const content = payload.content || '';
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE operator_channel = ? AND operator_thread_ref = ?'
  ).bind('telegram', payload.threadRef).first<any>();

  if (!conv) return;

  const command = content.trim();
  const attachments = payload.attachments || [];
  if (attachments.length === 0 && (command === '/ai_off' || command === '/ai_on')) {
    const operationId = `${command === '/ai_off' ? 'ai_off' : 'ai_on'}_ack:${scopedMessageRef}`;
    const commandState = await applyTelegramOperatorAction(
      env,
      conv.id,
      supportProfileVersion,
      payload.updateRef,
      command === '/ai_off' ? 'AI_OFF' : 'AI_ON'
    );
    if (commandState === 'STALE' || commandState === 'STALE_PROFILE') {
      await markOutboundOperationFinal(env, operationId, 'STALE_AI_COMMAND');
      return;
    }

    const acknowledgement = command === '/ai_off'
      ? 'AI 已关闭，后续由人工客服处理。'
      : getAIConfig(env).enabled
        ? 'AI 已开启。'
        : 'AI 已允许，但当前 AI Provider 未配置。';
    await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'SEND_MESSAGE',
      async (opId, lifecycle) => {
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, payload.threadRef, acknowledgement, lifecycle);
        return { providerMessageRef: res.messageId };
      },
      operationId,
      {
        subject: { type: 'CONTROL_ACK', ref: `telegram:${supportProfileVersion}:${payload.updateRef}` },
        targetEvidence: buildTelegramTargetEvidence(
          env, env.BOT_GROUP_ID, payload.threadRef, 'sendMessage'
        )
      }
    );
    return;
  }

  if (attachments.length === 0 && (command === '/upload' || command === '/upload_revoke')) {
    if (
      conv.helpdesk_provider !== 'crisp' ||
      !isAuthorizedUploadOperator(env, payload.operatorRef) ||
      !payload.publicOrigin
    ) return;
    const commandState = await applyTelegramOperatorAction(
      env, conv.id, supportProfileVersion, payload.updateRef, 'HUMAN_REPLY'
    );
    if (commandState === 'STALE' || commandState === 'STALE_PROFILE') return;
    const uploadCommand = {
      supportProfileVersion,
      updateRef: payload.updateRef,
      operatorRef: payload.operatorRef,
      publicOrigin: payload.publicOrigin,
      threadRef: payload.threadRef
    };
    if (command === '/upload') {
      await createAndSendUploadInvite(env, conv, uploadCommand);
    } else {
      await revokeUploadInviteFromTelegram(env, conv, uploadCommand);
    }
    return;
  }

  const humanAction = await applyTelegramOperatorAction(
    env, conv.id, supportProfileVersion, payload.updateRef, 'HUMAN_REPLY'
  );
  if (humanAction === 'STALE_PROFILE') return;
  const destinationProvider = conv.helpdesk_provider === 'crisp' ? 'crisp' : 'chatwoot';
  const operatorIdentity = destinationProvider === 'crisp' ? crispOperatorIdentity(env) : null;
  const operatorRequestOptions = operatorIdentity ? crispIdentityRequestOptions(operatorIdentity) : undefined;
  if (content) {
    const operationId = `send_${destinationProvider}_${scopedMessageRef}`;
    await insertMessage(
      env,
      conv.id,
      'telegram',
      scopedMessageRef,
      'INBOUND',
      'OPERATOR',
      'TEXT',
      content
    );

    await executeOutboundOperation(
      env,
      conv.id,
      destinationProvider,
      'SEND_MESSAGE',
      async (opId, lifecycle) => {
        const frozenIdentity = parseCrispIdentityRequestOptions(lifecycle.requestOptionsJson);
        const res = destinationProvider === 'crisp'
          ? await createCrispMessage(
              env, conv.helpdesk_account_ref, conv.helpdesk_conversation_ref, content, String(opId), lifecycle,
              frozenIdentity ? { identity: frozenIdentity, automated: true } : undefined
            )
          : await createChatwootMessage(
              env,
              conv.helpdesk_account_ref,
              conv.helpdesk_conversation_ref,
              content,
              opId,
              lifecycle
            );
        return { providerMessageRef: res.messageId };
      },
      operationId,
      {
        subject: { type: 'MESSAGE', ref: `telegram:${scopedMessageRef}` },
        targetEvidence: destinationProvider === 'crisp'
          ? buildCrispTargetEvidence(conv.helpdesk_account_ref, conv.helpdesk_conversation_ref)
          : await buildChatwootTargetEvidence(
              env, conv.helpdesk_account_ref, conv.helpdesk_conversation_ref, operationId
            ),
        ...(operatorRequestOptions ? { requestOptions: operatorRequestOptions } : {})
      }
    );
  }

  await enqueueAttachmentJobs(
    env,
    getAttachmentConfig(env),
    conv.id,
    'telegram',
    scopedMessageRef,
    attachments,
    destinationProvider,
    destinationProvider === 'crisp' ? payload.publicOrigin : undefined,
    operatorRequestOptions ? JSON.stringify(operatorRequestOptions) : undefined
  );
}
