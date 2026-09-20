import { fetchChatwootConversationStatus } from '../adapters/chatwoot/api';
import { closeTelegramTopic, reopenTelegramTopic } from '../adapters/telegram/api';
import { Env } from '../config/env';
import { Conversation, OutboundOperation } from '../core/domain';
import { RetryableProcessingError } from '../core/errors';
import { ChatwootLifecycleEvent } from '../core/events';
import { resolveOutboundDomainState } from '../core/outbound-domain-resolution';
import { buildTelegramTargetEvidence } from '../core/outbound-evidence';
import { executeOutboundOperation } from '../core/outbound-operations';
import {
  loadLatestTopicLifecycleOperation,
  loadTopicLifecycleLeaf,
  nextTopicLifecycleOperationId,
  topicLifecycleTarget
} from '../core/topic-lifecycle-operations';

const MAX_RECONCILIATION_ROUNDS = 4;

function isEffectivelyDelivered(operation: OutboundOperation): boolean {
  return operation.status === 'SENT' || (
    operation.status === 'AMBIGUOUS' &&
    (operation.reconciliation_status === 'CONFIRMED_SENT' ||
      operation.reconciliation_status === 'MANUAL_MARK_DELIVERED')
  );
}

async function loadConversation(env: Env, payload: ChatwootLifecycleEvent['payload']): Promise<Conversation | null> {
  return env.DB.prepare(
    `SELECT * FROM conversations
     WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?`
  ).bind('chatwoot', payload.accountRef, payload.conversationRef).first<Conversation>();
}

async function settleLatestDeliveredOperation(
  env: Env,
  conversation: Conversation
): Promise<Conversation> {
  const latest = await loadLatestTopicLifecycleOperation(env, conversation.id);
  if (!latest) return conversation;
  const leaf = await loadTopicLifecycleLeaf(env, latest);
  if (!isEffectivelyDelivered(leaf)) return conversation;

  await resolveOutboundDomainState(env, leaf.id);
  const current = await loadConversation(env, {
    accountRef: conversation.helpdesk_account_ref,
    conversationRef: conversation.helpdesk_conversation_ref,
    status: 'open'
  });
  if (!current) throw new Error('Conversation disappeared during lifecycle reconciliation');
  return current;
}

export async function reconcileChatwootLifecycle(
  event: ChatwootLifecycleEvent,
  env: Env
): Promise<void> {
  for (let round = 0; round < MAX_RECONCILIATION_ROUNDS; round += 1) {
    let conversation = await loadConversation(env, event.payload);
    if (!conversation?.operator_thread_ref) return;
    conversation = await settleLatestDeliveredOperation(env, conversation);
    if (!conversation.operator_thread_ref) return;

    const providerStatus = await fetchChatwootConversationStatus(
      env,
      event.payload.accountRef,
      event.payload.conversationRef
    );
    const targetStatus = providerStatus === 'resolved' ? 'CLOSED' : 'OPEN';
    if (conversation.operator_thread_status === targetStatus) return;

    const latest = await loadLatestTopicLifecycleOperation(env, conversation.id);
    const samePendingTransition = latest && topicLifecycleTarget(latest) === targetStatus;
    const id = samePendingTransition
      ? latest.id
      : nextTopicLifecycleOperationId(conversation.id, latest, targetStatus);
    const operationType = targetStatus === 'CLOSED' ? 'CLOSE_TOPIC' : 'REOPEN_TOPIC';
    const method = targetStatus === 'CLOSED' ? 'closeForumTopic' : 'reopenForumTopic';
    const threadRef = conversation.operator_thread_ref;

    const result = await executeOutboundOperation(
      env,
      conversation.id,
      'telegram',
      operationType,
      async (_operationId, lifecycle) => {
        if (targetStatus === 'CLOSED') {
          await closeTelegramTopic(env, env.BOT_GROUP_ID, threadRef, lifecycle);
        } else {
          await reopenTelegramTopic(env, env.BOT_GROUP_ID, threadRef, lifecycle);
        }
        return {};
      },
      id,
      {
        subject: { type: 'CONVERSATION', ref: conversation.id },
        targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, threadRef, method)
      }
    );

    if (result.status !== 'SENT') return;
    await resolveOutboundDomainState(env, id);
  }

  throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 5, {
    provider: 'CHATWOOT',
    stage: 'RECONCILE'
  });
}
