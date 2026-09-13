import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { insertMessage } from '../core/conversation-service';
import { executeOutboundOperation } from '../core/outbound-operations';
import { createChatwootMessage } from '../adapters/chatwoot/api';
import { pauseOperator, pauseManual, resumeManual } from '../core/ai-state';
import { sendTelegramMessage } from '../adapters/telegram/api';

export async function processTelegramEvent(event: SupportEvent, env: Env): Promise<void> {
  const payload = event.payload;

  if (payload.message) {
    const threadRef = String(payload.message.message_thread_id || payload.message.message_id);
    const content = payload.message.text || '';
    const messageId = String(payload.message.message_id);

    const conv = await env.DB.prepare(
      'SELECT * FROM conversations WHERE operator_channel = ? AND operator_thread_ref = ?'
    ).bind('telegram', threadRef).first<any>();

    if (!conv) return;

    if (content.trim() === '/ai_off') {
      await pauseManual(env, conv.id);
      await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'SEND_MESSAGE',
        async () => {
          const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, 'AI 已关闭，后续由人工客服处理。');
          return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
        },
        `ai_off_ack:${messageId}`
      );
      return;
    }

    if (content.trim() === '/ai_on') {
      await resumeManual(env, conv.id);
      await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'SEND_MESSAGE',
        async () => {
          const msg = (env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL) 
                      ? 'AI 已开启。' 
                      : 'AI 已允许，但当前 AI Provider 未配置。';
          const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, msg);
          return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
        },
        `ai_on_ack:${messageId}`
      );
      return;
    }

    await pauseOperator(env, conv.id);

    await insertMessage(
      env,
      conv.id,
      'telegram',
      messageId,
      'OUTBOUND',
      'OPERATOR',
      'TEXT',
      content
    );

    await executeOutboundOperation(
      env,
      conv.id,
      'chatwoot',
      'SEND_MESSAGE',
      async (opId) => {
        const res = await createChatwootMessage(env, conv.helpdesk_account_ref, conv.helpdesk_conversation_ref, content, String(opId));
        return { providerMessageRef: String((res as any).messageId || (res as any).message_id || (res as any).id) };
      },
      `send_chatwoot_${messageId}`
    );
  }
}
