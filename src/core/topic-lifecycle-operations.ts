import { DatabaseEnv } from './database';
import { OutboundOperation } from './domain';
import { RetryableProcessingError } from './errors';
import { auditAfterPreviousChange, d1Changed } from './reliability-audit';

export const TOPIC_LIFECYCLE_OPERATION_PREFIX = 'topic_lifecycle_v2_';

export function topicLifecyclePrefix(conversationId: string): string {
  return `${TOPIC_LIFECYCLE_OPERATION_PREFIX}${conversationId}_`;
}

export function isManagedTopicLifecycleOperation(operation: OutboundOperation): boolean {
  return operation.id.startsWith(topicLifecyclePrefix(operation.conversation_id)) &&
    (operation.operation_type === 'CLOSE_TOPIC' || operation.operation_type === 'REOPEN_TOPIC');
}

export function topicLifecycleTarget(operation: OutboundOperation): 'OPEN' | 'CLOSED' {
  return operation.operation_type === 'CLOSE_TOPIC' ? 'CLOSED' : 'OPEN';
}

export async function loadLatestTopicLifecycleOperation(
  env: DatabaseEnv,
  conversationId: string
): Promise<OutboundOperation | null> {
  return env.DB.prepare(
    `SELECT * FROM outbound_operations
     WHERE conversation_id = ? AND subject_type = 'CONVERSATION' AND instr(id, ?) = 1
       AND operation_type IN ('CLOSE_TOPIC', 'REOPEN_TOPIC')
     ORDER BY id DESC LIMIT 1`
  ).bind(conversationId, topicLifecyclePrefix(conversationId)).first<OutboundOperation>();
}

export async function loadLegacyTopicLifecycleRoots(
  env: DatabaseEnv,
  conversationId: string
): Promise<OutboundOperation[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM outbound_operations
     WHERE conversation_id = ? AND subject_type = 'CONVERSATION'
       AND operation_type IN ('CLOSE_TOPIC', 'REOPEN_TOPIC')
       AND parent_operation_id IS NULL AND instr(id, ?) != 1
     ORDER BY created_at, id`
  ).bind(conversationId, topicLifecyclePrefix(conversationId)).all<OutboundOperation>();
  return rows.results || [];
}

export async function findManagedTopicLifecycleRoot(
  env: DatabaseEnv,
  operation: OutboundOperation
): Promise<OutboundOperation | null> {
  let current = operation;
  const visited = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (visited.has(current.id)) throw new Error('Topic lifecycle operation ancestry cycle');
    visited.add(current.id);
    if (isManagedTopicLifecycleOperation(current)) return current;
    if (!current.parent_operation_id) return null;
    const parent = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
      .bind(current.parent_operation_id).first<OutboundOperation>();
    if (!parent) throw new Error('Topic lifecycle operation parent missing');
    current = parent;
  }
  throw new Error('Topic lifecycle operation ancestry too deep');
}

export async function loadTopicLifecycleLeaf(
  env: DatabaseEnv,
  root: OutboundOperation
): Promise<OutboundOperation> {
  let current = root;
  const visited = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (visited.has(current.id)) throw new Error('Topic lifecycle operation descendant cycle');
    visited.add(current.id);
    const children = await env.DB.prepare(
      'SELECT * FROM outbound_operations WHERE parent_operation_id = ? ORDER BY id'
    ).bind(current.id).all<OutboundOperation>();
    if (children.results.length === 0) return current;
    if (children.results.length !== 1) throw new Error('Topic lifecycle operation has multiple direct children');
    current = children.results[0];
  }
  throw new Error('Topic lifecycle operation descendants too deep');
}

export async function isLatestTopicLifecycleRoot(
  env: DatabaseEnv,
  root: OutboundOperation
): Promise<boolean> {
  const latest = await loadLatestTopicLifecycleOperation(env, root.conversation_id);
  return latest?.id === root.id;
}

export function nextTopicLifecycleOperationId(
  conversationId: string,
  latest: OutboundOperation | null
): string {
  let sequence = 1;
  if (latest) {
    const suffix = latest.id.slice(topicLifecyclePrefix(conversationId).length);
    const current = Number(suffix.slice(0, 8));
    if (!Number.isSafeInteger(current) || current < 1 || current >= 99_999_999) {
      throw new Error('Invalid lifecycle operation sequence');
    }
    sequence = current + 1;
  }
  return `${topicLifecyclePrefix(conversationId)}${String(sequence).padStart(8, '0')}`;
}

export function lifecycleOperationDefinitelyDidNotSend(operation: OutboundOperation): boolean {
  if (operation.request_started_at === null) return true;
  if (operation.response_observed_at === null) return false;
  return operation.response_http_status === 429 ||
    operation.last_error === 'OUTBOUND_RATE_LIMITED' ||
    operation.last_error === 'OUTBOUND_RETRY_EXHAUSTED' ||
    operation.last_error === 'OUTBOUND_PROVIDER_4XX_FINAL';
}

export function lifecycleOperationWasSuperseded(operation: OutboundOperation): boolean {
  return operation.status === 'FAILED_FINAL' &&
    operation.last_error === 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND' &&
    operation.request_started_at === null;
}

export function lifecycleOperationCanBeSuperseded(operation: OutboundOperation): boolean {
  if (operation.status === 'PENDING') {
    return operation.attempt_count === 0 && operation.request_started_at === null;
  }
  if (operation.status === 'SENDING') {
    return operation.request_started_at === null;
  }
  return operation.status === 'FAILED_RETRYABLE' &&
    lifecycleOperationDefinitelyDidNotSend(operation);
}

export async function supersedeLifecycleOperationBeforeSend(
  env: DatabaseEnv,
  operation: OutboundOperation,
  actorRef = 'system:chatwoot-lifecycle'
): Promise<boolean> {
  if (!lifecycleOperationCanBeSuperseded(operation)) return false;
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbound_operations
       SET status = 'FAILED_FINAL', last_error = 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND',
           lease_until = NULL, lease_token = NULL, next_retry_at = NULL,
           retry_after_seconds = NULL, updated_at = ?
       WHERE id = ? AND status = ? AND attempt_count = ?
         AND request_started_at IS ? AND response_observed_at IS ?`
    ).bind(
      now,
      operation.id,
      operation.status,
      operation.attempt_count,
      operation.request_started_at,
      operation.response_observed_at
    ),
    auditAfterPreviousChange(env, {
      id: `topic-lifecycle-superseded:${operation.id}`,
      entityType: 'OUTBOUND_OPERATION',
      entityId: operation.id,
      action: 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND',
      actorType: 'SYSTEM',
      actorRef,
      oldState: operation.status,
      newState: 'FAILED_FINAL',
      reasonCode: 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND',
      createdAt: now
    })
  ]);
  if (d1Changed(results[0]) !== d1Changed(results[1])) {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 5);
  }
  return d1Changed(results[0]);
}

export async function markExpiredStartedLifecycleAmbiguous(
  env: DatabaseEnv,
  operation: OutboundOperation,
  actorRef = 'system:chatwoot-lifecycle'
): Promise<boolean> {
  if (
    operation.status !== 'SENDING' || operation.request_started_at === null ||
    (operation.lease_until !== null && operation.lease_until > Math.floor(Date.now() / 1000))
  ) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbound_operations
       SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING',
           last_error = 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED',
           lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND request_started_at = ?
         AND (lease_until IS NULL OR lease_until <= ?)`
    ).bind(now, operation.id, operation.request_started_at, now),
    auditAfterPreviousChange(env, {
      id: `topic-lifecycle-expired:${operation.id}`,
      entityType: 'OUTBOUND_OPERATION',
      entityId: operation.id,
      action: 'TOPIC_LIFECYCLE_STARTED_REQUEST_EXPIRED',
      actorType: 'SYSTEM',
      actorRef,
      oldState: 'SENDING',
      newState: 'AMBIGUOUS',
      reasonCode: 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED',
      createdAt: now
    })
  ]);
  if (d1Changed(results[0]) !== d1Changed(results[1])) {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 5);
  }
  return d1Changed(results[0]);
}
