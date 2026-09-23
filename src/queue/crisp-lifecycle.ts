import { fetchCrispConversationState } from '../adapters/crisp/api';
import { closeTelegramTopic, reopenTelegramTopic } from '../adapters/telegram/api';
import { Env } from '../config/env';
import { Conversation, OutboundOperation } from '../core/domain';
import { RetryableProcessingError, SafeError } from '../core/errors';
import { CrispLifecycleEvent } from '../core/events';
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
  loadLegacyTopicLifecycleRoots,
  loadLatestTopicLifecycleOperation,
  loadTopicLifecycleLeaf,
  markExpiredStartedLifecycleAmbiguous,
  nextTopicLifecycleOperationId,
  supersedeLifecycleOperationBeforeSend,
  topicLifecycleTarget
} from '../core/topic-lifecycle-operations';

const MAX_RECONCILIATION_ROUNDS = 8;
const CRISP_LIFECYCLE_ACTOR = 'system:crisp-lifecycle';

export interface CrispLifecycleIdentity {
  websiteRef: string;
  sessionRef: string;
  eventId: string;
}

function isEffectivelyDelivered(operation: OutboundOperation): boolean {
  return operation.status === 'SENT' || (
    operation.status === 'AMBIGUOUS' &&
    (operation.reconciliation_status === 'CONFIRMED_SENT' ||
      operation.reconciliation_status === 'MANUAL_MARK_DELIVERED')
  );
}

export async function loadCrispConversation(
  env: Env,
  websiteRef: string,
  sessionRef: string
): Promise<Conversation | null> {
  return env.DB.prepare(
    `SELECT * FROM conversations
     WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?`
  ).bind('crisp', websiteRef, sessionRef).first<Conversation>();
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
  const current = await loadCrispConversation(
    env,
    conversation.helpdesk_account_ref,
    conversation.helpdesk_conversation_ref
  );
  if (!current) throw new Error('Crisp conversation disappeared during lifecycle reconciliation');
  return current;
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

export async function reconcileCrispLifecycleIdentity(
  identity: CrispLifecycleIdentity,
  env: Env
): Promise<void> {
  for (let round = 0; round < MAX_RECONCILIATION_ROUNDS; round += 1) {
    let conversation = await loadCrispConversation(env, identity.websiteRef, identity.sessionRef);
    if (!conversation?.operator_thread_ref) return;
    conversation = await settleLatestDeliveredOperation(env, conversation);
    if (!conversation.operator_thread_ref) return;

    const legacy = await loadLegacyTopicLifecycleRoots(env, conversation.id);
    if (legacy.length > 0) requireManualReconciliation();

    const providerState = await fetchCrispConversationState(
      env,
      identity.websiteRef,
      identity.sessionRef
    );
    const targetStatus = providerState === 'resolved' ? 'CLOSED' : 'OPEN';
    const latest = await loadLatestTopicLifecycleOperation(env, conversation.id);
    await env.hooks?.afterCrispLifecycleSnapshot?.(
      env,
      identity.eventId,
      targetStatus,
      latest?.id || null
    );
    const leaf = latest ? await loadTopicLifecycleLeaf(env, latest) : null;
    const leafDelivered = Boolean(leaf && isEffectivelyDelivered(leaf));
    if (leaf && leafDelivered) {
      await resolveOutboundDomainState(env, leaf.id);
      const repaired = await loadCrispConversation(env, identity.websiteRef, identity.sessionRef);
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
      if (conversation.operator_thread_status === targetStatus) return;
    }

    if (
      latest?.status === 'SENDING' && latest.request_started_at !== null &&
      (latest.lease_until === null || latest.lease_until <= Math.floor(Date.now() / 1000))
    ) {
      await markExpiredStartedLifecycleAmbiguous(env, latest, CRISP_LIFECYCLE_ACTOR);
      requireManualReconciliation();
    }

    if (latest && ['PENDING', 'SENDING', 'FAILED_RETRYABLE'].includes(latest.status)) {
      if (topicLifecycleTarget(latest) !== targetStatus) {
        if (await supersedeLifecycleOperationBeforeSend(env, latest, CRISP_LIFECYCLE_ACTOR)) continue;
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

    if (conversation.operator_thread_status === targetStatus) return;

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
          targetEvidence: buildTelegramTargetEvidence(
            env,
            env.BOT_GROUP_ID,
            conversation.operator_thread_ref,
            lifecycleMethod(targetStatus)
          )
        }
      );
      if (!prepared) requireManualReconciliation();
    } catch (error) {
      if (error instanceof OutboundOperationIdentityCollisionError && error.operationId === id) continue;
      throw error;
    }
  }

  throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 5, {
    provider: 'CRISP',
    stage: 'RECONCILE'
  });
}

export async function reconcileCrispLifecycle(
  event: CrispLifecycleEvent,
  env: Env
): Promise<void> {
  return reconcileCrispLifecycleIdentity({
    websiteRef: event.payload.websiteRef,
    sessionRef: event.payload.sessionRef,
    eventId: event.eventId
  }, env);
}
