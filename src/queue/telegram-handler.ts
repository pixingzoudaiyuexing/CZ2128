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

    // AI Handoff commands
    if (content.trim() === '/ai_off') {
      await pauseManual(env, conv.id);
      await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, 'AI 已关闭，后续由人工客服处理。');
      return;
    }

    if (content.trim() === '/ai_on') {
      await resumeManual(env, conv.id);
      await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, 'AI 已开启。');
      return;
    }

    // Normal operator reply
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
        return { providerMessageRef: String(res.messageId) };
      },
      `send_chatwoot_${messageId}`
    );
  }
}
