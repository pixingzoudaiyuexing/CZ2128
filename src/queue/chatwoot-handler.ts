import { createTelegramTopic, sendTelegramMessage, closeTelegramTopic, reopenTelegramTopic } from '../adapters/telegram/api';
import { Env } from '../config/env';
import { pauseOperator } from '../core/ai-state';
import {
  getOrCreateConversation,
  insertMessage,
  updateOperatorThreadRef,
  updateOperatorThreadStatus
} from '../core/conversation-service';
import { ChatwootEvent } from '../core/events';
import { executeOutboundOperation } from '../core/outbound-operations';
import { logger } from '../observability/logger';

export async function processChatwootEvent(event: ChatwootEvent, env: Env): Promise<void> {
  if (event.type === 'message_created') {
    const payload = event.payload;
    const conv = await getOrCreateConversation(
      env,
      'chatwoot',
      payload.accountRef,
      payload.conversationRef,
      payload.customerRef
    );

    const isOperator = payload.actorRole === 'OPERATOR';
    if (isOperator) {
      await pauseOperator(env, conv.id);
    }

    await insertMessage(
      env,
      conv.id,
      'chatwoot',
      payload.messageRef,
      isOperator ? 'OUTBOUND' : 'INBOUND',
      payload.actorRole,
      'TEXT',
      payload.content
    );

    let threadRef = conv.operator_thread_ref;
    if (!threadRef) {
      const topicRes = await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'CREATE_TOPIC',
        async () => {
          const customerLabel = payload.customerName || `Customer ${payload.customerRef}`;
          const topicName = `${customerLabel} | Chatwoot #${payload.conversationRef}`.slice(0, 128);
          const res = await createTelegramTopic(env, env.BOT_GROUP_ID, topicName);
          return { providerMessageRef: res.messageThreadId };
        },
        `create_topic_${conv.id}`
      );

      if (topicRes.status === 'SENT' && topicRes.providerMessageRef) {
        threadRef = await updateOperatorThreadRef(env, conv.id, topicRes.providerMessageRef);
      } else {
        logger.warn('Topic creation not SENT; message awaits manual reconciliation', { conversation_id: conv.id });
        return;
      }
    }

    await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'SEND_MESSAGE',
      async () => {
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, payload.content);
        return { providerMessageRef: res.messageId };
      },
      `send_tg_${payload.messageRef}`
    );

    if (!isOperator) {
      await env.QUEUE.send({
        version: 1,
        source: 'internal',
        type: 'ai_trigger',
        eventId: `ai_trigger:${conv.id}:${payload.messageRef}`,
        payload: {
          convId: conv.id,
          messageId: payload.messageRef
        }
      });
    }
    return;
  }

  const payload = event.payload;
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?'
  ).bind('chatwoot', payload.accountRef, payload.conversationRef).first<any>();

  if (!conv?.operator_thread_ref) return;
  const currentStatus = conv.operator_thread_status || 'OPEN';
  const nextStatus = payload.status === 'resolved' ? 'CLOSED' : 'OPEN';
  if (currentStatus === nextStatus) return;

  const operationId = `${nextStatus === 'CLOSED' ? 'close' : 'reopen'}_topic_${conv.id}_${conv.version}`;
  if (payload.status === 'resolved') {
    const result = await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'CLOSE_TOPIC',
      async () => {
        await closeTelegramTopic(env, env.BOT_GROUP_ID, conv.operator_thread_ref);
        return {};
      },
      operationId
    );
    if (result.status === 'SENT') {
      await updateOperatorThreadStatus(env, conv.id, conv.version, 'OPEN', 'CLOSED');
    }
  } else {
    const result = await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'REOPEN_TOPIC',
      async () => {
        await reopenTelegramTopic(env, env.BOT_GROUP_ID, conv.operator_thread_ref);
        return {};
      },
      operationId
    );
    if (result.status === 'SENT') {
      await updateOperatorThreadStatus(env, conv.id, conv.version, 'CLOSED', 'OPEN');
    }
  }
}
