import { fetchChatwootConversationStatus } from '../adapters/chatwoot/api';
import { closeTelegramTopic, reopenTelegramTopic } from '../adapters/telegram/api';
import { Env } from '../config/env';
import { Conversation, OutboundOperation } from '../core/domain';
import { RetryableProcessingError, SafeError } from '../core/errors';
import { ChatwootLifecycleEvent } from '../core/events';
import { resolveOutboundDomainState } from '../core/outbound-domain-resolution';
import { buildTelegramTargetEvidence } from '../core/outbound-evidence';
import {
  executeOutboundOperation,
  OutboundOperationIdentityCollisionError,
  prepareOutboundOperation
} from '../core/outbound-operations';
import {
  lifecycleOperationDefinitelyDidNotSend,
  lifecycleOperationWasSuperseded,
  isManagedTopicLifecycleOperation,
  loadLegacyTopicLifecycleRoots,
  loadLatestTopicLifecycleOperation,
  loadTopicLifecycleLeaf,
  markExpiredStartedLifecycleAmbiguous,
  nextTopicLifecycleOperationId,
  supersedeLifecycleOperationBeforeSend,
  topicLifecycleTarget
} from '../core/topic-lifecycle-operations';

const MAX_RECONCILIATION_ROUNDS = 8;

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

interface LegacyCoordinationResult {
  conversation: Conversation;
  compensationParent: OutboundOperation | null;
}

async function coordinateLegacyOperations(
  env: Env,
  conversation: Conversation,
  targetStatus: 'OPEN' | 'CLOSED',
  latestManaged: OutboundOperation | null
): Promise<LegacyCoordinationResult> {
  const roots = await loadLegacyTopicLifecycleRoots(env, conversation.id);
  let current = conversation;
  let deliveredTarget: 'OPEN' | 'CLOSED' | null = null;
  for (const root of roots) {
    const leaf = await loadTopicLifecycleLeaf(env, root);
    if (isManagedTopicLifecycleOperation(leaf)) continue;

    if (isEffectivelyDelivered(leaf)) {
      if (latestManaged || (deliveredTarget !== null && deliveredTarget !== topicLifecycleTarget(leaf))) {
        return { conversation: current, compensationParent: leaf };
      }
      await resolveOutboundDomainState(env, leaf.id);
      const repaired = await loadConversation(env, {
        accountRef: current.helpdesk_account_ref,
        conversationRef: current.helpdesk_conversation_ref,
        status: 'open'
      });
      if (!repaired?.operator_thread_ref) requireManualReconciliation();
      current = repaired;
      deliveredTarget = topicLifecycleTarget(leaf);
      continue;
    }

    if (leaf.status === 'PENDING' || leaf.status === 'FAILED_RETRYABLE' ||
      (leaf.status === 'SENDING' && leaf.request_started_at === null)) {
      if (latestManaged || topicLifecycleTarget(leaf) !== targetStatus) {
        if (await supersedeLifecycleOperationBeforeSend(env, leaf)) continue;
        throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 5);
      }
      const status = await executeLifecycleOperation(env, current, leaf);
      if (status === 'SENT') {
        await resolveOutboundDomainState(env, leaf.id);
        const repaired = await loadConversation(env, {
          accountRef: current.helpdesk_account_ref,
          conversationRef: current.helpdesk_conversation_ref,
          status: 'open'
        });
        if (!repaired?.operator_thread_ref) requireManualReconciliation();
        current = repaired;
        deliveredTarget = topicLifecycleTarget(leaf);
        continue;
      }
      if (status === 'AMBIGUOUS') requireManualReconciliation();
      if (status === 'FAILED_FINAL') requireFinalIntervention();
      continue;
    }

    if (leaf.status === 'SENDING') {
      const now = Math.floor(Date.now() / 1000);
      if (leaf.lease_until !== null && leaf.lease_until > now) {
        throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', leaf.lease_until - now);
      }
      await markExpiredStartedLifecycleAmbiguous(env, leaf);
      requireManualReconciliation();
    }

    if (leaf.status === 'AMBIGUOUS') requireManualReconciliation();
    if (leaf.status === 'FAILED_FINAL') {
      if (lifecycleOperationWasSuperseded(leaf)) continue;
      if (!lifecycleOperationDefinitelyDidNotSend(leaf)) requireFinalIntervention();
      if (
        !latestManaged && topicLifecycleTarget(leaf) === targetStatus &&
        current.operator_thread_status !== targetStatus
      ) {
        requireFinalIntervention();
      }
    }
  }
  return { conversation: current, compensationParent: null };
}

function lifecycleMethod(targetStatus: 'OPEN' | 'CLOSED'): 'closeForumTopic' | 'reopenForumTopic' {
  return targetStatus === 'CLOSED' ? 'closeForumTopic' : 'reopenForumTopic';
}

async function executeLifecycleOperation(
  env: Env,
  conversation: Conversation,
  operation: OutboundOperation
): Promise<string> {
  const targetStatus = topicLifecycleTarget(operation);
  const threadRef = conversation.operator_thread_ref;
  if (!threadRef) throw new SafeError('TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED');
  const result = await executeOutboundOperation(
    env,
    conversation.id,
    'telegram',
    operation.operation_type,
    async (_operationId, lifecycle) => {
      if (targetStatus === 'CLOSED') {
        await closeTelegramTopic(env, env.BOT_GROUP_ID, threadRef, lifecycle);
      } else {
        await reopenTelegramTopic(env, env.BOT_GROUP_ID, threadRef, lifecycle);
      }
      return {};
    },
    operation.id,
    {
      allowCreate: false,
      subject: { type: 'CONVERSATION', ref: conversation.id },
      targetEvidence: buildTelegramTargetEvidence(
        env,
        env.BOT_GROUP_ID,
        threadRef,
        lifecycleMethod(targetStatus)
      )
    }
  );
  return result.status;
}

function requireManualReconciliation(): never {
  throw new SafeError('TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED', {
    provider: 'TELEGRAM',
    stage: 'RECONCILE'
  });
}

function requireFinalIntervention(): never {
  throw new SafeError('TOPIC_LIFECYCLE_FINAL_BLOCKED', {
    provider: 'TELEGRAM',
    stage: 'RECONCILE'
  });
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
    const latest = await loadLatestTopicLifecycleOperation(env, conversation.id);
    await env.hooks?.afterChatwootLifecycleSnapshot?.(
      env,
      event.eventId,
      targetStatus,
      latest?.id || null
    );
    const legacy = await coordinateLegacyOperations(env, conversation, targetStatus, latest);
    conversation = legacy.conversation;
    const compensationParent = legacy.compensationParent;
    const leaf = latest ? await loadTopicLifecycleLeaf(env, latest) : null;
    const leafDelivered = Boolean(leaf && isEffectivelyDelivered(leaf));
    if (leaf && leafDelivered) {
      await resolveOutboundDomainState(env, leaf.id);
      const repaired = await loadConversation(env, event.payload);
      if (!repaired?.operator_thread_ref) return;
      conversation = repaired;
    }
    if (leaf && leaf.id !== latest?.id && !isEffectivelyDelivered(leaf)) {
      if (leaf.status === 'FAILED_FINAL') requireFinalIntervention();
      requireManualReconciliation();
    }

    if (!leafDelivered && latest?.status === 'AMBIGUOUS') requireManualReconciliation();
    if (!leafDelivered && latest?.status === 'FAILED_FINAL') {
      const safeOppositeState = lifecycleOperationWasSuperseded(latest) || (
        lifecycleOperationDefinitelyDidNotSend(latest) &&
        topicLifecycleTarget(latest) !== targetStatus
      );
      if (!safeOppositeState) requireFinalIntervention();
      if (conversation.operator_thread_status === targetStatus && !compensationParent) return;
    }

    if (latest && ['PENDING', 'SENDING', 'FAILED_RETRYABLE'].includes(latest.status)) {
      if (topicLifecycleTarget(latest) !== targetStatus) {
        if (await supersedeLifecycleOperationBeforeSend(env, latest)) continue;
        if (latest.status === 'SENDING') {
          const status = await executeLifecycleOperation(env, conversation, latest);
          if (status === 'AMBIGUOUS') requireManualReconciliation();
          if (status === 'FAILED_FINAL') requireFinalIntervention();
          continue;
        }
        continue;
      }

      const status = await executeLifecycleOperation(env, conversation, latest);
      if (status === 'SENT') {
        await resolveOutboundDomainState(env, latest.id);
        continue;
      }
      if (status === 'AMBIGUOUS') requireManualReconciliation();
      if (status === 'FAILED_FINAL') requireFinalIntervention();
      continue;
    }

    if (conversation.operator_thread_status === targetStatus && !compensationParent) return;

    const id = nextTopicLifecycleOperationId(conversation.id, latest);
    const operationType = targetStatus === 'CLOSED' ? 'CLOSE_TOPIC' : 'REOPEN_TOPIC';
    try {
      const prepared = await prepareOutboundOperation(
        env,
        conversation.id,
        'telegram',
        operationType,
        id,
        {
          subject: { type: 'CONVERSATION', ref: conversation.id },
          ...(compensationParent ? { parentOperationId: compensationParent.id } : {}),
          targetEvidence: buildTelegramTargetEvidence(
            env,
            env.BOT_GROUP_ID,
            conversation.operator_thread_ref,
            lifecycleMethod(targetStatus)
          )
        }
      );
      if (!prepared) throw new SafeError('TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED');
    } catch (error) {
      if (error instanceof OutboundOperationIdentityCollisionError && error.operationId === id) continue;
      throw error;
    }
  }

  throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 5, {
    provider: 'CHATWOOT',
    stage: 'RECONCILE'
  });
}
