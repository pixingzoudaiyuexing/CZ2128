import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { getOrCreateConversation, insertMessage, updateOperatorThreadRef } from '../core/conversation-service';
import { executeOutboundOperation } from '../core/outbound-operations';
import { createTelegramTopic, sendTelegramMessage, closeTelegramTopic, reopenTelegramTopic } from '../adapters/telegram/api';

export async function processChatwootEvent(event: SupportEvent, env: Env): Promise<void> {
  const payload = event.payload;

  if (event.type === 'message_created') {
    const accountId = String(payload.account?.id || payload.account_id);
    const conversationId = String(payload.conversation?.id || payload.conversation_id);
    const customerId = String(payload.sender?.id || payload.contact?.id);
    const messageId = String(payload.id);

    // Get or Create Conversation
    const conv = await getOrCreateConversation(
      env,
      'chatwoot',
      accountId,
      conversationId,
      customerId
    );

    let actorRole = 'SYSTEM';
    if (payload.sender?.type === 'contact') actorRole = 'CUSTOMER';
    else if (payload.sender?.type === 'user') actorRole = 'OPERATOR';

    await insertMessage(
      env,
      conv.id,
      'chatwoot',
      messageId,
      'INBOUND',
      actorRole,
      'TEXT',
      payload.content || ''
    );

    if (actorRole === 'CUSTOMER' || actorRole === 'OPERATOR') {
      let threadRef = conv.operator_thread_ref;

      // 1 Chatwoot Conversation = 1 Telegram Forum Topic
      if (!threadRef) {
        // Create topic
        const topicName = `CW-${conversationId} ${payload.sender?.name || 'Customer'}`;
        
        await executeOutboundOperation(
          env,
          conv.id,
          'telegram',
          'CREATE_TOPIC',
          async (opId) => {
            const res = await createTelegramTopic(env, env.BOT_GROUP_ID, topicName);
            threadRef = res.messageThreadId;
            return { providerMessageRef: threadRef };
          },
          `create_topic_${conv.id}`
        );

        if (threadRef) {
          await updateOperatorThreadRef(env, conv.id, threadRef);
        }
      }

      if (threadRef && payload.content) {
        // Forward message to Telegram
        let text = payload.content;
        if (actorRole === 'CUSTOMER') {
          text = `👤 **Customer**: ${payload.content}`;
        } else if (actorRole === 'OPERATOR') {
          text = `🧑‍💻 **Agent** (${payload.sender?.name || 'Unknown'}): ${payload.content}`;
        }

        await executeOutboundOperation(
          env,
          conv.id,
          'telegram',
          'SEND_MESSAGE',
          async (opId) => {
            const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, text);
            return { providerMessageRef: res.messageId };
          },
          `send_telegram_${messageId}`
        );
      }
    }
  } else if (event.type === 'conversation_resolved' || event.type === 'conversation_opened') {
    const accountId = String(payload.account?.id || payload.account_id);
    const conversationId = String(payload.id); // In these events, payload is conversation

    const conv = await env.DB.prepare(
      'SELECT * FROM conversations WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?'
    ).bind('chatwoot', accountId, conversationId).first<any>();

    if (conv && conv.operator_thread_ref) {
      if (event.type === 'conversation_resolved') {
        await executeOutboundOperation(
          env,
          conv.id,
          'telegram',
          'CLOSE_TOPIC',
          async (opId) => {
            await closeTelegramTopic(env, env.BOT_GROUP_ID, conv.operator_thread_ref);
            return {};
          },
          `close_topic_${conversationId}_${event.eventId}`
        );
      } else if (event.type === 'conversation_opened') {
        await executeOutboundOperation(
          env,
          conv.id,
          'telegram',
          'REOPEN_TOPIC',
          async (opId) => {
            await reopenTelegramTopic(env, env.BOT_GROUP_ID, conv.operator_thread_ref);
            return {};
          },
          `reopen_topic_${conversationId}_${event.eventId}`
        );
      }
    }
  }
}
