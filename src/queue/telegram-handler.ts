import { createChatwootMessage } from '../adapters/chatwoot/api';
import { sendTelegramMessage } from '../adapters/telegram/api';
import { getAIConfig } from '../config/ai';
import { Env } from '../config/env';
import { pauseManual, pauseOperator, resumeManual } from '../core/ai-state';
import { insertMessage } from '../core/conversation-service';
import { TelegramMessageEvent } from '../core/events';
import { executeOutboundOperation } from '../core/outbound-operations';

export async function processTelegramEvent(event: TelegramMessageEvent, env: Env): Promise<void> {
  const payload = event.payload;
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE operator_channel = ? AND operator_thread_ref = ?'
  ).bind('telegram', payload.threadRef).first<any>();

  if (!conv) return;

  const command = payload.content.trim();
  if (command === '/ai_off' || command === '/ai_on') {
    if (command === '/ai_off') {
      await pauseManual(env, conv.id);
    } else {
      await resumeManual(env, conv.id);
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
      async () => {
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, payload.threadRef, acknowledgement);
        return { providerMessageRef: res.messageId };
      },
      `${command === '/ai_off' ? 'ai_off' : 'ai_on'}_ack:${payload.messageRef}`
    );
    return;
  }

  await pauseOperator(env, conv.id);
  await insertMessage(
    env,
    conv.id,
    'telegram',
    payload.messageRef,
    'INBOUND',
    'OPERATOR',
    'TEXT',
    payload.content
  );

  await executeOutboundOperation(
    env,
    conv.id,
    'chatwoot',
    'SEND_MESSAGE',
    async (opId) => {
      const res = await createChatwootMessage(
        env,
        conv.helpdesk_account_ref,
        conv.helpdesk_conversation_ref,
        payload.content,
        opId
      );
      return { providerMessageRef: res.messageId };
    },
    `send_chatwoot_${payload.messageRef}`
  );
}
