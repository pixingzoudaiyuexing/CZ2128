import { createChatwootMessage } from '../adapters/chatwoot/api';
import { createCrispMessage } from '../adapters/crisp/api';
import { sendTelegramMessage } from '../adapters/telegram/api';
import { getAIConfig } from '../config/ai';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { applyTelegramOperatorAction } from '../core/ai-state';
import { insertMessage } from '../core/conversation-service';
import { TelegramMessageEvent } from '../core/events';
import { executeOutboundOperation, markOutboundOperationFinal } from '../core/outbound-operations';
import { enqueueAttachmentJobs } from '../core/attachment-repository';
import { buildChatwootTargetEvidence, buildCrispTargetEvidence, buildTelegramTargetEvidence } from '../core/outbound-evidence';

export async function processTelegramEvent(event: TelegramMessageEvent, env: Env): Promise<void> {
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

  const humanAction = await applyTelegramOperatorAction(
    env, conv.id, supportProfileVersion, payload.updateRef, 'HUMAN_REPLY'
  );
  if (humanAction === 'STALE_PROFILE') return;
  if (content) {
    const destinationProvider = conv.helpdesk_provider === 'crisp' ? 'crisp' : 'chatwoot';
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
        const res = destinationProvider === 'crisp'
          ? await createCrispMessage(
              env, conv.helpdesk_account_ref, conv.helpdesk_conversation_ref, content, String(opId), lifecycle
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
            )
      }
    );
  }

  await enqueueAttachmentJobs(
    env,
    getAttachmentConfig(env),
    conv.id,
    'telegram',
    scopedMessageRef,
    attachments
  );
}
