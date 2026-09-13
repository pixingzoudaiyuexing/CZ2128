import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { insertMessage } from '../core/conversation-service';
import { executeOutboundOperation } from '../core/outbound-operations';
import { createChatwootMessage } from '../adapters/chatwoot/api';

export async function processTelegramEvent(event: SupportEvent, env: Env): Promise<void> {
  const payload = event.payload;

  if (event.type === 'message_created') {
    const message = payload.message || payload.edited_message;
    if (!message) return;

    const threadRef = String(message.message_thread_id || message.message_id);
    const text = message.text || message.caption;
    
    if (!text) return; 

    const conv = await env.DB.prepare(
      'SELECT * FROM conversations WHERE operator_channel = ? AND operator_thread_ref = ?'
    ).bind('telegram', threadRef).first<any>();

    if (!conv) {
      return;
    }

    const messageId = String(message.message_id);
    
    await insertMessage(
      env,
      conv.id,
      'telegram',
      messageId,
      'INBOUND',
      'OPERATOR',
      'TEXT',
      text
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
          text,
          opId
        );
        return { providerMessageRef: res.messageId };
      },
      `send_chatwoot_${messageId}`
    );
    
    await env.DB.prepare(
      'UPDATE conversations SET last_operator_reply_at = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), conv.id).run();
  }
}
