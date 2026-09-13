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
    // Phase 1 only processes incoming (customer) or outgoing (human operator)
    if (payload.message_type !== 'incoming' && payload.message_type !== 'outgoing') {
      return;
    }

    const isOutgoing = payload.message_type === 'outgoing';

    // Verify it's a real human outgoing message
    if (isOutgoing) {
      if (payload.private) return; // Don't forward private notes
      
      const senderType = payload.sender?.type;
      if (senderType === 'agent_bot' || senderType === 'system') return; // Don't forward bot/system
      
      const sourceId = payload.source_id;
      if (sourceId && String(sourceId).startsWith('cz2128:')) return; // CZ2128 echo
    }

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
    const role = isOutgoing ? 'OPERATOR' : 'CUSTOMER';

    await insertMessage(
      env,
      conv.id,
      'chatwoot',
      messageId,
      isOutgoing ? 'OUTBOUND' : 'INBOUND',
      role,
      'TEXT',
      content
    );

    let threadRef = conv.operator_thread_ref;

    // We only create topics on first message (which would normally be INCOMING).
    if (!threadRef) {
      const topicRes = await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'UPDATE_STATUS',
        async () => {
          const res = await createTelegramTopic(env, env.BOT_GROUP_ID, `Chatwoot #${conversationId}`);
          return { providerMessageRef: String((res as any).messageThreadId || (res as any).message_thread_id) };
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
        return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
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
