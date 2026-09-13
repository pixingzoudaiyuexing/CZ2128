import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { getOrCreateConversation, insertMessage, updateOperatorThreadRef } from '../core/conversation-service';
import { executeOutboundOperation } from '../core/outbound-operations';
import { createTelegramTopic, sendTelegramMessage, closeTelegramTopic, reopenTelegramTopic } from '../adapters/telegram/api';
import { logger } from '../observability/logger';

export async function processChatwootEvent(event: SupportEvent, env: Env): Promise<void> {
  const payload = event.payload;
  const accountId = String(payload.account?.id);
  const conversationId = String(payload.conversation?.id || payload.id);

  if (event.type === 'message_created') {
    if (payload.message_type !== 0) return; // Only process incoming messages (0)

    const customerRef = String(payload.sender?.id);
    const conv = await getOrCreateConversation(
      env,
      'chatwoot',
      accountId,
      conversationId,
      customerRef
    );

    const messageId = String(payload.id);
    const content = payload.content;

    await insertMessage(
      env,
      conv.id,
      'chatwoot',
      messageId,
      'INBOUND',
      'CUSTOMER',
      'TEXT',
      content
    );

    let threadRef = conv.operator_thread_ref;

    if (!threadRef) {
      const topicRes = await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'UPDATE_STATUS',
        async () => {
          const res = await createTelegramTopic(env, env.BOT_GROUP_ID, `Chatwoot #${conversationId}`);
          return { providerMessageRef: String(res.messageThreadId) };
        },
        `create_topic_${conv.id}`
      );

      if (topicRes.status === 'SENT' && topicRes.providerMessageRef) {
        threadRef = topicRes.providerMessageRef;
        await updateOperatorThreadRef(env, conv.id, threadRef);
      } else {
        logger.warn('Topic creation not yet SENT, skipping message relay for now', { conversation_id: conv.id });
        return; 
      }
    }

    await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'SEND_MESSAGE',
      async () => {
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef!, content);
        return { providerMessageRef: String(res.messageId) };
      },
      `send_tg_${messageId}`
    );
  }

  if (event.type === 'conversation_status_changed') {
    const status = payload.status;
    const conv = await env.DB.prepare(
      'SELECT * FROM conversations WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?'
    ).bind('chatwoot', accountId, conversationId).first<any>();

    if (conv && conv.operator_thread_ref) {
      if (status === 'resolved') {
        await executeOutboundOperation(
          env,
          conv.id,
          'telegram',
          'CLOSE_TOPIC',
          async () => {
            await closeTelegramTopic(env, env.BOT_GROUP_ID, conv.operator_thread_ref);
            return {};
          },
          `close_topic_${conversationId}_${event.eventId}`
        );
      } else if (status === 'open') {
        await executeOutboundOperation(
          env,
          conv.id,
          'telegram',
          'REOPEN_TOPIC',
          async () => {
            await reopenTelegramTopic(env, env.BOT_GROUP_ID, conv.operator_thread_ref);
            return {};
          },
          `reopen_topic_${conversationId}_${event.eventId}`
        );
      }
    }
  }
}
