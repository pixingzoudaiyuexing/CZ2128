import { Env } from '../config/env';
import { TelegramMessageEvent } from '../core/events';
import { insertMessage } from '../core/conversation-service';
import { executeOutboundOperation } from '../core/outbound-operations';
import { createChatwootMessage } from '../adapters/chatwoot/api';

export async function processTelegramEvent(event: TelegramMessageEvent, env: Env): Promise<void> {
  const payload = event.payload;
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE operator_channel = ? AND operator_thread_ref = ?'
  ).bind('telegram', payload.threadRef).first<any>();

  if (!conv) return;

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

  await env.DB.prepare(
    'UPDATE conversations SET last_operator_reply_at = ? WHERE id = ?'
  ).bind(Math.floor(Date.now() / 1000), conv.id).run();
}
