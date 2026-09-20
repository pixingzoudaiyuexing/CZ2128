import { createTelegramTopic, sendTelegramMessage } from '../adapters/telegram/api';
import { Env } from '../config/env';
import { pauseOperator } from '../core/ai-state';
import {
  getOrCreateConversation,
  insertMessage,
  updateOperatorThreadRef
} from '../core/conversation-service';
import { ChatwootEvent } from '../core/events';
import { executeOutboundOperation } from '../core/outbound-operations';
import { buildTelegramTargetEvidence } from '../core/outbound-evidence';
import { logger } from '../observability/logger';
import { getAttachmentConfig } from '../config/attachments';
import { enqueueAttachmentJobs } from '../core/attachment-repository';
import { reconcileChatwootLifecycle } from './chatwoot-lifecycle';

export async function processChatwootEvent(event: ChatwootEvent, env: Env): Promise<void> {
  if (event.type === 'message_created') {
    const payload = event.payload;
    const content = payload.content || '';
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

    if (content) {
      await insertMessage(
        env,
        conv.id,
        'chatwoot',
        payload.messageRef,
        isOperator ? 'OUTBOUND' : 'INBOUND',
        payload.actorRole,
        'TEXT',
        content
      );
    }

    let threadRef = conv.operator_thread_ref;
    if (!threadRef) {
      const operationId = `create_topic_${conv.id}`;
      const topicRes = await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'CREATE_TOPIC',
        async (opId, lifecycle) => {
          const customerLabel = payload.customerName || `Customer ${payload.customerRef}`;
          const topicName = `${customerLabel} | Chatwoot #${payload.conversationRef}`.slice(0, 128);
          const res = await createTelegramTopic(env, env.BOT_GROUP_ID, topicName, lifecycle);
          return { providerMessageRef: res.messageThreadId };
        },
        operationId,
        {
          subject: { type: 'CONVERSATION', ref: conv.id },
          targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, null, 'createForumTopic')
        }
      );

      if (topicRes.status === 'SENT' && topicRes.providerMessageRef) {
        threadRef = await updateOperatorThreadRef(env, conv.id, topicRes.providerMessageRef);
      } else {
        logger.warn('Topic creation not SENT; message awaits manual reconciliation', { conversation_id: conv.id });
        return;
      }
    }

    await enqueueAttachmentJobs(
      env,
      getAttachmentConfig(env),
      conv.id,
      'chatwoot',
      payload.messageRef,
      payload.attachments || []
    );

    if (content) {
      const operationId = `send_tg_${payload.messageRef}`;
      await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'SEND_MESSAGE',
        async (opId, lifecycle) => {
          const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, content, lifecycle);
          return { providerMessageRef: res.messageId };
        },
        operationId,
        {
          subject: { type: 'MESSAGE', ref: `chatwoot:${payload.messageRef}` },
          targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, threadRef, 'sendMessage')
        }
      );
    }

    if (!isOperator && content) {
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

  await reconcileChatwootLifecycle(event, env);
}
