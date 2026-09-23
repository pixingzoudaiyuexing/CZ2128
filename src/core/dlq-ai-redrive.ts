import { getAIConfig } from '../config/ai';
import { isAiConversationAllowed } from '../config/ai-test-scope';
import { Env } from '../config/env';
import { AiRun, Conversation, EventReceipt, OutboundOperation } from './domain';
import { AiTriggerEvent } from './events';
import {
  buildChatwootTargetEvidence,
  buildCrispTargetEvidence,
  buildTelegramTargetEvidence,
  parseTargetEvidence,
  targetEvidenceMatches
} from './outbound-evidence';
import { MAX_OUTBOUND_ATTEMPTS } from './outbound-operations';
import {
  auditAfterPreviousChange,
  d1Changed,
  insertReliabilityAuditOnce
} from './reliability-audit';
import { RetryableProcessingError, SafeError } from './errors';
import { MAX_AI_GENERATION_ATTEMPTS } from './ai-state';
import { resolveQueueIdentities } from '../config/queue-identities';

const MAX_IDENTITY_BYTES = 256;

export type DlqAiRedriveReason =
  | 'ELIGIBLE'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_RESOLVED'
  | 'NOT_AI_TRIGGER'
  | 'RECEIPT_MALFORMED'
  | 'EVENT_ID_INVALID'
  | 'CONVERSATION_MISSING'
  | 'MESSAGE_MISSING'
  | 'STALE_TRIGGER'
  | 'AI_RUN_MISSING'
  | 'AI_RUN_IDENTITY_MISMATCH'
  | 'AI_RUN_STATE_INELIGIBLE'
  | 'AI_RETRY_NOT_DUE'
  | 'AI_ATTEMPTS_EXHAUSTED'
  | 'AI_PAUSED'
  | 'AI_SCOPE_DENIED'
  | 'HANDOFF_EPOCH_CHANGED'
  | 'ACTIVE_GENERATION'
  | 'EVENT_RECEIPT_MISSING'
  | 'EVENT_RECEIPT_ACTIVE'
  | 'EVENT_RECEIPT_PROCESSED'
  | 'EVENT_RECEIPT_INCONSISTENT'
  | 'OUTBOUND_EVIDENCE_MISSING'
  | 'OUTBOUND_ACTIVE'
  | 'OUTBOUND_RETRY_NOT_DUE'
  | 'OUTBOUND_ATTEMPTS_EXHAUSTED'
  | 'OUTBOUND_AMBIGUOUS'
  | 'OUTBOUND_FINAL'
  | 'OUTBOUND_INCONSISTENT';

type DlqAiRedriveIneligibleReason = Exclude<DlqAiRedriveReason, 'ELIGIBLE'>;

export interface DlqAiRedriveEligibility {
  eligible: boolean;
  reason: DlqAiRedriveReason;
  event?: AiTriggerEvent;
  aiRunStatus?: 'FAILED_RETRYABLE' | 'SUCCESS';
}

export interface DlqAiRedriveRequestResult {
  status: 'ENQUEUED' | 'ALREADY_REQUESTED' | 'NOT_ELIGIBLE';
  eligibility: DlqAiRedriveEligibility;
}

interface DlqReceiptRow {
  id: string;
  queue_name: string;
  event_source: string | null;
  source_event_ref: string | null;
  event_type: string | null;
  conversation_id: string | null;
  status: 'OPEN' | 'RESOLVED';
}

interface DurableMessageRow {
  durable_rowid: number;
  id: string;
  provider_message_ref: string;
}

export type AiOutboundAbandonmentReason =
  | 'DISCARDED_STALE'
  | 'CANCELLED_BY_HANDOFF'
  | 'AI_SCOPE_DENIED';

interface AbandonedOutboundPlan {
  operation: OutboundOperation;
  statement: D1PreparedStatement;
  audit: D1PreparedStatement;
}

function ineligible(reason: DlqAiRedriveIneligibleReason): DlqAiRedriveEligibility {
  return { eligible: false, reason };
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    new TextEncoder().encode(value).length <= MAX_IDENTITY_BYTES;
}

function reconstructMessageId(eventId: string, conversationId: string): string | null {
  const prefix = `ai_trigger:${conversationId}:`;
  if (!eventId.startsWith(prefix)) return null;
  const messageId = eventId.slice(prefix.length);
  return boundedIdentity(messageId) ? messageId : null;
}

function validateAbandonedOperationIdentity(
  operation: OutboundOperation,
  event: AiTriggerEvent,
  conversation: Conversation,
  kind: 'HELPDESK' | 'TELEGRAM'
): boolean {
  const expectedId = kind === 'HELPDESK'
    ? `ai_reply:${event.eventId}`
    : `ai_tg_mirror:${event.eventId}`;
  const expectedProvider = kind === 'HELPDESK' ? conversation.helpdesk_provider : 'telegram';
  if (kind === 'HELPDESK' && !['chatwoot', 'crisp'].includes(expectedProvider)) return false;
  if (
    operation.id !== expectedId ||
    operation.conversation_id !== event.payload.convId ||
    operation.destination_provider !== expectedProvider ||
    operation.operation_type !== 'SEND_MESSAGE' ||
    operation.subject_type !== 'AI_RUN' ||
    operation.subject_ref !== event.eventId ||
    !operation.target_evidence_json
  ) return false;
  try {
    const evidence = parseTargetEvidence(operation.target_evidence_json);
    if (kind === 'HELPDESK') {
      if (expectedProvider === 'crisp') {
        return evidence.provider === 'crisp' &&
          boundedIdentity(evidence.websiteRef) &&
          boundedIdentity(evidence.sessionRef);
      }
      return evidence.provider === 'chatwoot' &&
        boundedIdentity(evidence.accountRef) &&
        boundedIdentity(evidence.conversationRef) &&
        evidence.sourceId === `cz2128:${expectedId}`;
    }
    return evidence.provider === 'telegram' &&
      evidence.method === 'sendMessage' &&
      boundedIdentity(evidence.groupRef) &&
      boundedIdentity(evidence.threadRef);
  } catch {
    return false;
  }
}

function staleTerminationIsSafe(operation: OutboundOperation): boolean {
  if (
    operation.provider_message_ref !== null ||
    operation.lease_until !== null ||
    operation.lease_token !== null ||
    operation.reconciliation_status !== 'NOT_REQUIRED'
  ) return false;
  if (operation.status === 'PENDING') {
    return operation.request_started_at === null &&
      operation.response_observed_at === null &&
      operation.response_http_status === null;
  }
  return operation.status === 'FAILED_RETRYABLE' &&
    Number.isSafeInteger(operation.request_started_at) &&
    Number.isSafeInteger(operation.response_observed_at) &&
    operation.response_http_status === 429 &&
    operation.last_error === 'OUTBOUND_RATE_LIMITED' &&
    Number.isSafeInteger(operation.next_retry_at);
}

function sentDeliveryEvidenceIsValid(operation: OutboundOperation): boolean {
  return operation.status === 'SENT' && boundedIdentity(operation.provider_message_ref);
}

function abandonmentAuditAction(reason: AiOutboundAbandonmentReason): string {
  if (reason === 'DISCARDED_STALE') return 'HISTORICAL_AI_STALE_DISCARDED';
  if (reason === 'CANCELLED_BY_HANDOFF') return 'AI_HANDOFF_CANCELLED';
  return 'AI_SCOPE_CANCELLED';
}

async function abandonmentAuditId(
  operationId: string,
  oldState: string,
  reason: AiOutboundAbandonmentReason
): Promise<string> {
  return `abandoned-ai:${await sha256Hex(JSON.stringify([operationId, oldState, reason]))}`;
}

function abandonedUpdateStatement(
  env: Pick<Env, 'DB'>,
  operation: OutboundOperation,
  now: number,
  reason: AiOutboundAbandonmentReason
): D1PreparedStatement {
  const common = `UPDATE outbound_operations
     SET status = 'FAILED_FINAL', last_error = ?,
         lease_until = NULL, lease_token = NULL,
         retry_after_seconds = NULL, next_retry_at = NULL, updated_at = ?
     WHERE id = ? AND conversation_id = ? AND destination_provider = ?
       AND operation_type = 'SEND_MESSAGE' AND subject_type = 'AI_RUN'
       AND subject_ref = ? AND target_evidence_json = ? AND status = ?
       AND provider_message_ref IS NULL AND lease_until IS NULL AND lease_token IS NULL
       AND reconciliation_status = 'NOT_REQUIRED'`;
  const stateFence = operation.status === 'PENDING'
    ? ` AND request_started_at IS NULL AND response_observed_at IS NULL
        AND response_http_status IS NULL`
    : ` AND request_started_at IS NOT NULL AND response_observed_at IS NOT NULL
        AND response_http_status = 429 AND last_error = 'OUTBOUND_RATE_LIMITED'
        AND next_retry_at IS NOT NULL`;
  return env.DB.prepare(common + stateFence).bind(
    reason,
    now,
    operation.id,
    operation.conversation_id,
    operation.destination_provider,
    operation.subject_ref,
    operation.target_evidence_json,
    operation.status
  );
}

export async function convergeAbandonedAiOutboundOperations(
  env: Env,
  event: AiTriggerEvent,
  reason: AiOutboundAbandonmentReason
): Promise<{ changed: number }> {
  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
    .bind(event.payload.convId).first<Conversation>();
  if (!conversation) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  const helpdeskId = `ai_reply:${event.eventId}`;
  const telegramId = `ai_tg_mirror:${event.eventId}`;
  const result = await env.DB.prepare(
    'SELECT * FROM outbound_operations WHERE id IN (?, ?)'
  ).bind(helpdeskId, telegramId).all<OutboundOperation>();
  const operations = result.results || [];
  if (!operations.some(operation => operation.id === helpdeskId)) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
  const plans: AbandonedOutboundPlan[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const operation of operations) {
    const kind = operation.id === helpdeskId
      ? 'HELPDESK'
      : operation.id === telegramId
        ? 'TELEGRAM'
        : null;
    if (!kind || !validateAbandonedOperationIdentity(operation, event, conversation, kind)) {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
    if (operation.status === 'SENT') {
      if (!sentDeliveryEvidenceIsValid(operation)) {
        throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      }
      continue;
    }
    if (operation.status === 'FAILED_FINAL') continue;
    if (!staleTerminationIsSafe(operation)) {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
    plans.push({
      operation,
      statement: abandonedUpdateStatement(env, operation, now, reason),
      audit: auditAfterPreviousChange(env, {
        id: await abandonmentAuditId(operation.id, operation.status, reason),
        entityType: 'OUTBOUND_OPERATION',
        entityId: operation.id,
        action: abandonmentAuditAction(reason),
        actorType: 'SYSTEM',
        actorRef: 'system:ai-handler',
        oldState: operation.status,
        newState: 'FAILED_FINAL',
        reasonCode: reason,
        createdAt: now
      })
    });
  }

  if (env.hooks?.beforeAbandonedOutboundConvergence) {
    await env.hooks.beforeAbandonedOutboundConvergence(env, event.eventId, reason);
  }
  if (reason === 'DISCARDED_STALE' && env.hooks?.beforeStaleOutboundConvergence) {
    await env.hooks.beforeStaleOutboundConvergence(env, event.eventId);
  }
  if (plans.length === 0) return { changed: 0 };

  const statements = plans.flatMap(plan => [plan.statement, plan.audit]);
  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 5);
  }

  let changed = 0;
  for (let index = 0; index < plans.length; index += 1) {
    const updateChanged = d1Changed(results[index * 2]);
    const auditChanged = d1Changed(results[index * 2 + 1]);
    if (updateChanged !== auditChanged) {
      throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 5);
    }
    if (updateChanged) {
      changed += 1;
      continue;
    }
    const current = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
      .bind(plans[index].operation.id).first<OutboundOperation>();
    if (!current || !validateAbandonedOperationIdentity(
      current,
      event,
      conversation,
      current.id === helpdeskId ? 'HELPDESK' : 'TELEGRAM'
    )) {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
    if (current.status === 'SENT') {
      if (!sentDeliveryEvidenceIsValid(current)) {
        throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      }
      continue;
    }
    if (current.status === 'FAILED_FINAL') continue;
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
  return { changed };
}

export async function convergeStaleAiOutboundOperations(
  env: Env,
  event: AiTriggerEvent
): Promise<{ changed: number }> {
  return convergeAbandonedAiOutboundOperations(env, event, 'DISCARDED_STALE');
}

function activeGenerationReason(
  conversation: Conversation,
  now: number,
  leaseSeconds: number
): DlqAiRedriveIneligibleReason | null {
  if (conversation.ai_generation_id === null && conversation.ai_generation_started_at === null) {
    return null;
  }
  if (
    !boundedIdentity(conversation.ai_generation_id) ||
    !Number.isSafeInteger(conversation.ai_generation_started_at)
  ) return 'ACTIVE_GENERATION';
  return Number(conversation.ai_generation_started_at) >= now - leaseSeconds
    ? 'ACTIVE_GENERATION'
    : null;
}

async function validateOutboundOperation(
  env: Env,
  operation: OutboundOperation,
  conversation: Conversation,
  eventId: string,
  kind: 'HELPDESK' | 'TELEGRAM',
  now: number,
  allowTargetDriftAsSafeSkip = false
): Promise<DlqAiRedriveIneligibleReason | null> {
  const expectedId = kind === 'HELPDESK' ? `ai_reply:${eventId}` : `ai_tg_mirror:${eventId}`;
  const expectedProvider = kind === 'HELPDESK' ? conversation.helpdesk_provider : 'telegram';
  if (kind === 'HELPDESK' && !['chatwoot', 'crisp'].includes(expectedProvider)) {
    return 'OUTBOUND_INCONSISTENT';
  }
  if (
    operation.id !== expectedId ||
    operation.conversation_id !== conversation.id ||
    operation.destination_provider !== expectedProvider ||
    operation.operation_type !== 'SEND_MESSAGE' ||
    operation.subject_type !== 'AI_RUN' ||
    operation.subject_ref !== eventId ||
    !operation.target_evidence_json
  ) return 'OUTBOUND_INCONSISTENT';
  if (!Number.isSafeInteger(operation.attempt_count) || operation.attempt_count < 0) {
    return 'OUTBOUND_INCONSISTENT';
  }
  if (operation.status !== 'AMBIGUOUS' && operation.reconciliation_status !== 'NOT_REQUIRED') {
    return 'OUTBOUND_INCONSISTENT';
  }

  try {
    const storedEvidence = parseTargetEvidence(operation.target_evidence_json);
    if (kind === 'HELPDESK') {
      if (expectedProvider === 'crisp') {
        if (
          storedEvidence.provider !== 'crisp' ||
          storedEvidence.websiteRef !== conversation.helpdesk_account_ref ||
          storedEvidence.sessionRef !== conversation.helpdesk_conversation_ref
        ) return 'OUTBOUND_INCONSISTENT';
      } else if (
        storedEvidence.provider !== 'chatwoot' ||
        storedEvidence.accountRef !== conversation.helpdesk_account_ref ||
        storedEvidence.conversationRef !== conversation.helpdesk_conversation_ref ||
        storedEvidence.sourceId !== `cz2128:${expectedId}`
      ) return 'OUTBOUND_INCONSISTENT';
    } else if (storedEvidence.provider !== 'telegram' || storedEvidence.method !== 'sendMessage') {
      return 'OUTBOUND_INCONSISTENT';
    }
  } catch {
    return 'OUTBOUND_INCONSISTENT';
  }

  if (operation.status === 'SENDING') return 'OUTBOUND_ACTIVE';
  if (operation.status === 'AMBIGUOUS') return 'OUTBOUND_AMBIGUOUS';
  if (operation.status === 'FAILED_FINAL') return 'OUTBOUND_FINAL';
  if (operation.status === 'SENT') {
    return boundedIdentity(operation.provider_message_ref) ? null : 'OUTBOUND_INCONSISTENT';
  }
  if (operation.attempt_count >= MAX_OUTBOUND_ATTEMPTS) return 'OUTBOUND_ATTEMPTS_EXHAUSTED';
  if (operation.status === 'FAILED_RETRYABLE') {
    if (!Number.isSafeInteger(operation.next_retry_at)) return 'OUTBOUND_INCONSISTENT';
    if (Number(operation.next_retry_at) > now) return 'OUTBOUND_RETRY_NOT_DUE';
  } else if (operation.status !== 'PENDING') {
    return 'OUTBOUND_INCONSISTENT';
  }

  try {
    const expectedEvidence = kind === 'HELPDESK'
      ? expectedProvider === 'crisp'
        ? buildCrispTargetEvidence(
          conversation.helpdesk_account_ref,
          conversation.helpdesk_conversation_ref
        )
        : await buildChatwootTargetEvidence(
          env,
          conversation.helpdesk_account_ref,
          conversation.helpdesk_conversation_ref,
          expectedId
        )
      : buildTelegramTargetEvidence(
        env,
        env.BOT_GROUP_ID,
        conversation.operator_thread_ref,
        'sendMessage'
      );
    if (targetEvidenceMatches(operation.target_evidence_json, expectedEvidence)) return null;
    return allowTargetDriftAsSafeSkip ? null : 'OUTBOUND_INCONSISTENT';
  } catch {
    return 'OUTBOUND_INCONSISTENT';
  }
}

async function outboundEligibility(
  env: Env,
  conversation: Conversation,
  eventId: string,
  aiRunStatus: AiRun['status'],
  now: number
): Promise<DlqAiRedriveIneligibleReason | null> {
  const helpdeskId = `ai_reply:${eventId}`;
  const telegramId = `ai_tg_mirror:${eventId}`;
  const rows = await env.DB.prepare(
    'SELECT * FROM outbound_operations WHERE id IN (?, ?)'
  ).bind(helpdeskId, telegramId).all<OutboundOperation>();
  const helpdesk = rows.results.find(row => row.id === helpdeskId);
  const telegram = rows.results.find(row => row.id === telegramId);

  if (!helpdesk) return 'OUTBOUND_EVIDENCE_MISSING';
  const helpdeskReason = await validateOutboundOperation(
    env,
    helpdesk,
    conversation,
    eventId,
    'HELPDESK',
    now
  );
  if (helpdeskReason) return helpdeskReason;

  if (aiRunStatus === 'FAILED_RETRYABLE' && helpdesk.status !== 'PENDING') {
    return 'OUTBOUND_INCONSISTENT';
  }
  if (telegram) {
    if (aiRunStatus === 'FAILED_RETRYABLE' && telegram.status !== 'PENDING') {
      return 'OUTBOUND_INCONSISTENT';
    }
    if (telegram.status === 'SENT' && helpdesk.status !== 'SENT') return 'OUTBOUND_INCONSISTENT';
    const reason = await validateOutboundOperation(
      env,
      telegram,
      conversation,
      eventId,
      'TELEGRAM',
      now,
      helpdesk.status === 'SENT'
    );
    if (reason) return reason;
  }
  return null;
}

export async function hasConfirmedAiDelivery(
  env: Env,
  event: AiTriggerEvent,
  conversation?: Conversation,
  run?: AiRun,
  now = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const canonicalConversation = conversation || await env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(event.payload.convId).first<Conversation>();
  const canonicalRun = run || await env.DB.prepare(
    'SELECT * FROM ai_runs WHERE trigger_event_ref = ?'
  ).bind(event.eventId).first<AiRun>();
  if (
    !canonicalConversation ||
    !canonicalRun ||
    canonicalRun.status !== 'SUCCESS' ||
    canonicalRun.response_text === null ||
    canonicalRun.conversation_id !== event.payload.convId ||
    canonicalRun.trigger_message_ref !== event.payload.messageId ||
    Number(canonicalRun.handoff_epoch) !== Number(canonicalConversation.ai_handoff_epoch)
  ) return false;

  const operation = await env.DB.prepare(
    'SELECT * FROM outbound_operations WHERE id = ?'
  ).bind(`ai_reply:${event.eventId}`).first<OutboundOperation>();
  if (!operation || operation.status !== 'SENT') return false;
  return await validateOutboundOperation(
    env,
    operation,
    canonicalConversation,
    event.eventId,
    'HELPDESK',
    now
  ) === null;
}

export const hasConfirmedChatwootAiDelivery = hasConfirmedAiDelivery;

export async function isOpenDlqAiRecoveryEvent(
  env: Pick<Env, 'DB' | 'EXPECTED_MAIN_QUEUE_NAME' | 'EXPECTED_DLQ_QUEUE_NAME'>,
  event: AiTriggerEvent
): Promise<boolean> {
  const queueIdentities = resolveQueueIdentities(env);
  const receipt = await env.DB.prepare(
    `SELECT id FROM dlq_receipts
     WHERE queue_name = ? AND event_source = 'internal' AND source_event_ref = ?
       AND event_type = 'ai_trigger' AND conversation_id = ? AND status = 'OPEN'
     LIMIT 1`
  ).bind(queueIdentities.dlq, event.eventId, event.payload.convId).first<{ id: string }>();
  return boundedIdentity(receipt?.id);
}

export async function getDlqAiRedriveEligibility(
  env: Env,
  receiptId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<DlqAiRedriveEligibility> {
  if (!boundedIdentity(receiptId)) return ineligible('RECEIPT_MALFORMED');
  const queueIdentities = resolveQueueIdentities(env);
  const receipt = await env.DB.prepare(
    `SELECT id, queue_name, event_source, source_event_ref, event_type, conversation_id, status
     FROM dlq_receipts WHERE id = ?`
  ).bind(receiptId).first<DlqReceiptRow>();
  if (!receipt) return ineligible('RECEIPT_NOT_FOUND');
  if (receipt.status !== 'OPEN') return ineligible('RECEIPT_RESOLVED');
  if (
    receipt.queue_name !== queueIdentities.dlq ||
    receipt.event_source !== 'internal' ||
    receipt.event_type !== 'ai_trigger'
  ) return ineligible('NOT_AI_TRIGGER');
  if (!boundedIdentity(receipt.source_event_ref) || !boundedIdentity(receipt.conversation_id)) {
    return ineligible('RECEIPT_MALFORMED');
  }

  const eventId = receipt.source_event_ref;
  const conversationId = receipt.conversation_id;
  const messageId = reconstructMessageId(eventId, conversationId);
  if (!messageId) return ineligible('EVENT_ID_INVALID');

  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
    .bind(conversationId).first<Conversation>();
  if (!conversation) return ineligible('CONVERSATION_MISSING');
  const scopeAllowed = isAiConversationAllowed(env, conversationId);
  if (conversation.ai_mode !== 'ENABLED') return ineligible('AI_PAUSED');
  const event: AiTriggerEvent = {
    version: 1,
    source: 'internal',
    type: 'ai_trigger',
    eventId,
    payload: { convId: conversationId, messageId }
  };
  if (
    !scopeAllowed &&
    !await hasConfirmedAiDelivery(env, event, conversation, undefined, now)
  ) return ineligible('AI_SCOPE_DENIED');

  const generationReason = activeGenerationReason(
    conversation,
    now,
    getAIConfig(env).generationLeaseSeconds
  );
  if (generationReason) return ineligible(generationReason);

  const targetMessage = await env.DB.prepare(
    `SELECT rowid AS durable_rowid, id, provider_message_ref
     FROM messages
     WHERE conversation_id = ? AND provider = ? AND provider_message_ref = ?
       AND direction = 'INBOUND' AND actor_role = 'CUSTOMER'
       AND message_type = 'TEXT' AND text_content IS NOT NULL`
  ).bind(conversationId, conversation.helpdesk_provider, messageId).first<DurableMessageRow>();
  if (!targetMessage) return ineligible('MESSAGE_MISSING');

  const latestMessage = await env.DB.prepare(
    `SELECT rowid AS durable_rowid, id, provider_message_ref
     FROM messages
     WHERE conversation_id = ? AND actor_role = 'CUSTOMER'
       AND message_type = 'TEXT' AND text_content IS NOT NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(conversationId).first<DurableMessageRow>();
  if (!latestMessage || latestMessage.durable_rowid !== targetMessage.durable_rowid) {
    return ineligible('STALE_TRIGGER');
  }

  const run = await env.DB.prepare('SELECT * FROM ai_runs WHERE trigger_event_ref = ?')
    .bind(eventId).first<AiRun>();
  if (!run) return ineligible('AI_RUN_MISSING');
  if (run.conversation_id !== conversationId || run.trigger_message_ref !== messageId) {
    return ineligible('AI_RUN_IDENTITY_MISMATCH');
  }
  if (Number(run.handoff_epoch) !== Number(conversation.ai_handoff_epoch)) {
    return ineligible('HANDOFF_EPOCH_CHANGED');
  }

  if (run.status === 'FAILED_RETRYABLE') {
    if (
      !Number.isSafeInteger(run.attempt_count) ||
      run.attempt_count < 0 ||
      run.attempt_count >= MAX_AI_GENERATION_ATTEMPTS
    ) {
      return ineligible('AI_ATTEMPTS_EXHAUSTED');
    }
    if (!Number.isSafeInteger(run.next_retry_at)) return ineligible('AI_RUN_STATE_INELIGIBLE');
    if (Number(run.next_retry_at) > now) return ineligible('AI_RETRY_NOT_DUE');
  } else if (run.status === 'SUCCESS') {
    if (run.response_text === null) return ineligible('AI_RUN_STATE_INELIGIBLE');
  } else {
    return ineligible('AI_RUN_STATE_INELIGIBLE');
  }

  const eventReceipt = await env.DB.prepare(
    `SELECT * FROM event_receipts WHERE source = 'internal' AND source_event_ref = ?`
  ).bind(eventId).first<EventReceipt>();
  if (!eventReceipt) return ineligible('EVENT_RECEIPT_MISSING');
  if (
    (eventReceipt.event_type !== null && eventReceipt.event_type !== 'ai_trigger') ||
    (eventReceipt.conversation_id !== null && eventReceipt.conversation_id !== conversationId)
  ) return ineligible('EVENT_RECEIPT_INCONSISTENT');
  if (eventReceipt.status === 'PROCESSED') return ineligible('EVENT_RECEIPT_PROCESSED');
  if (eventReceipt.status === 'PROCESSING') {
    if (!Number.isSafeInteger(eventReceipt.lease_until)) return ineligible('EVENT_RECEIPT_INCONSISTENT');
    if (Number(eventReceipt.lease_until) > now) return ineligible('EVENT_RECEIPT_ACTIVE');
  } else if (eventReceipt.status !== 'FAILED') {
    return ineligible('EVENT_RECEIPT_INCONSISTENT');
  }

  const outboundReason = await outboundEligibility(env, conversation, eventId, run.status, now);
  if (outboundReason) return ineligible(outboundReason);

  return {
    eligible: true,
    reason: 'ELIGIBLE',
    aiRunStatus: run.status,
    event
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function requestDlqAiRedrive(
  env: Env,
  receiptId: string,
  actorRef: string,
  commandId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<DlqAiRedriveRequestResult> {
  if (!/^[1-9]\d{0,19}$/.test(actorRef) || !/^\d{1,20}$/.test(commandId)) {
    throw new SafeError('ADMIN_INPUT_INVALID');
  }
  const eligibility = await getDlqAiRedriveEligibility(env, receiptId, now);
  if (!eligibility.eligible || !eligibility.event) {
    return { status: 'NOT_ELIGIBLE', eligibility };
  }

  const auditId = `dlq-redrive:v1:${await sha256Hex(
    `cz2128-dlq-redrive:v1\nreceipt=${receiptId}\ncommand=${commandId}`
  )}`;
  const created = await insertReliabilityAuditOnce(env, {
    id: auditId,
    entityType: 'DLQ_RECEIPT',
    entityId: receiptId,
    action: 'DLQ_REDRIVE_REQUESTED',
    actorType: 'ADMIN',
    actorRef,
    oldState: 'OPEN',
    newState: 'OPEN',
    reasonCode: 'OPERATOR_REQUESTED_REDRIVE',
    createdAt: now
  });
  if (!created) return { status: 'ALREADY_REQUESTED', eligibility };

  try {
    await env.QUEUE.send(eligibility.event);
  } catch {
    throw new SafeError('QUEUE_ENQUEUE_FAILED');
  }
  return { status: 'ENQUEUED', eligibility };
}
