import { Env } from '../config/env';
import { resolveRetryAfterSeconds, retryAfterHeader } from './retry';
import { OutboundOperation } from './domain';
import { RetryableProcessingError, SafeError } from './errors';
import {
  OutboundTargetEvidence,
  parseTargetEvidence,
  targetEvidenceMatches
} from './outbound-evidence';
import { auditAfterPreviousChange, d1Changed } from './reliability-audit';

const CHATWOOT_MAX_PAGES = 5;
const CHATWOOT_MAX_MESSAGES = 500;
const CHATWOOT_MAX_PAGE_BYTES = 1024 * 1024;
const CHATWOOT_RECONCILIATION_RUNTIME_MS = 10_000;

export const MANUAL_DELIVERED_REASONS = [
  'PROVIDER_CONFIRMED_OUT_OF_BAND',
  'OPERATOR_CONFIRMED_DELIVERY'
] as const;

export const MANUAL_CANCEL_REASONS = [
  'OPERATOR_CANCELLED',
  'TARGET_RETIRED',
  'DUPLICATE_OPERATION'
] as const;

export type ManualDeliveredReason = typeof MANUAL_DELIVERED_REASONS[number];
export type ManualCancelReason = typeof MANUAL_CANCEL_REASONS[number];

export interface ManualResolutionActor {
  type: 'ADMIN';
  ref: string;
}

export interface ReconciliationResult {
  operationStatus: OutboundOperation['status'];
  reconciliationStatus: OutboundOperation['reconciliation_status'];
  providerMessageRef?: string;
  changed: boolean;
}

async function loadOperation(env: Env, operationId: string): Promise<OutboundOperation> {
  const operation = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
    .bind(operationId).first<OutboundOperation>();
  if (!operation) throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  return operation;
}

function result(operation: OutboundOperation, changed = false): ReconciliationResult {
  return {
    operationStatus: operation.status,
    reconciliationStatus: operation.reconciliation_status,
    ...(operation.provider_message_ref ? { providerMessageRef: operation.provider_message_ref } : {}),
    changed
  };
}

function isUnresolved(operation: OutboundOperation): boolean {
  return operation.status === 'AMBIGUOUS' &&
    (operation.reconciliation_status === 'PENDING' || operation.reconciliation_status === 'STILL_AMBIGUOUS');
}

function boundedActorRef(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  }
  return normalized;
}

async function transition(
  env: Env,
  operation: OutboundOperation,
  nextStatus: 'CONFIRMED_SENT' | 'STILL_AMBIGUOUS' | 'MANUAL_MARK_DELIVERED' | 'MANUAL_CANCELLED',
  action: string,
  actorType: 'SYSTEM' | 'ADMIN',
  actorRef: string,
  reasonCode: string,
  providerMessageRef?: string
): Promise<ReconciliationResult> {
  if (!isUnresolved(operation)) return result(operation);
  const now = Math.floor(Date.now() / 1000);
  const isResolved = nextStatus !== 'STILL_AMBIGUOUS';
  const resolvedBy = isResolved ? `${actorType.toLowerCase()}:${actorRef}` : null;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbound_operations
       SET reconciliation_status = ?,
           provider_message_ref = COALESCE(?, provider_message_ref),
           resolved_by = ?, resolved_at = ?, resolution_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'AMBIGUOUS' AND reconciliation_status = ?`
    ).bind(
      nextStatus,
      providerMessageRef || null,
      resolvedBy,
      isResolved ? now : null,
      reasonCode,
      now,
      operation.id,
      operation.reconciliation_status
    ),
    auditAfterPreviousChange(env, {
      id: crypto.randomUUID(),
      entityType: 'OUTBOUND_OPERATION',
      entityId: operation.id,
      action,
      actorType,
      actorRef,
      oldState: operation.reconciliation_status,
      newState: nextStatus,
      reasonCode,
      createdAt: now
    })
  ]);
  if (d1Changed(results[0]) !== d1Changed(results[1])) {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 5);
  }
  const current = await loadOperation(env, operation.id);
  return result(current, d1Changed(results[0]));
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SafeError('RECONCILIATION_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CHATWOOT_MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new SafeError('RECONCILIATION_INVALID_RESPONSE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SafeError('RECONCILIATION_INVALID_RESPONSE');
  }
}

function pageMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { payload?: unknown }).payload)) {
    return (value as { payload: unknown[] }).payload;
  }
  throw new SafeError('RECONCILIATION_INVALID_RESPONSE');
}

async function getChatwootPage(env: Env, url: string, remainingMs: number): Promise<unknown[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(remainingMs, 3_000)));
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'api_access_token': env.CHATWOOT_API_TOKEN },
      signal: controller.signal
    });
  } catch {
    throw new RetryableProcessingError('RECONCILIATION_PROVIDER_UNAVAILABLE', 5, {
      provider: 'CHATWOOT', stage: 'RECONCILE'
    });
  }
  try {
    if (!response.ok) {
      if (response.status === 429) {
        throw new RetryableProcessingError(
          'RECONCILIATION_RATE_LIMITED',
          resolveRetryAfterSeconds({ httpRetryAfter: retryAfterHeader(response), jitter: false }),
          { provider: 'CHATWOOT', stage: 'RECONCILE', httpStatus: response.status }
        );
      }
      if (response.status >= 500) {
        throw new RetryableProcessingError('RECONCILIATION_PROVIDER_UNAVAILABLE', 5, {
          provider: 'CHATWOOT', stage: 'RECONCILE', httpStatus: response.status
        });
      }
      throw new SafeError('RECONCILIATION_PROVIDER_REJECTED', {
        provider: 'CHATWOOT', stage: 'RECONCILE', httpStatus: response.status
      });
    }
    try {
      return pageMessages(await readBoundedJson(response));
    } catch (error) {
      if (error instanceof SafeError || error instanceof RetryableProcessingError) throw error;
      throw new RetryableProcessingError('RECONCILIATION_PROVIDER_UNAVAILABLE', 5, {
        provider: 'CHATWOOT', stage: 'RECONCILE'
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function reconcileChatwoot(
  env: Env,
  operation: OutboundOperation,
  evidence: Extract<OutboundTargetEvidence, { provider: 'chatwoot' }>
): Promise<ReconciliationResult> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) {
    throw new SafeError('RECONCILIATION_PROVIDER_REJECTED', { provider: 'CHATWOOT', stage: 'RECONCILE' });
  }
  const deadline = Date.now() + CHATWOOT_RECONCILIATION_RUNTIME_MS;
  const matchedIds = new Set<string>();
  let exactMatchesWithoutId = 0;
  let inspected = 0;
  for (let page = 1; page <= CHATWOOT_MAX_PAGES && inspected < CHATWOOT_MAX_MESSAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new RetryableProcessingError('RECONCILIATION_PROVIDER_UNAVAILABLE', 5, {
        provider: 'CHATWOOT', stage: 'RECONCILE'
      });
    }
    const baseUrl = env.CHATWOOT_API_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/api/v1/accounts/${encodeURIComponent(evidence.accountRef)}` +
      `/conversations/${encodeURIComponent(evidence.conversationRef)}/messages?page=${page}`;
    const messages = await getChatwootPage(env, url, remaining);
    if (messages.length === 0) break;
    for (const message of messages) {
      if (inspected >= CHATWOOT_MAX_MESSAGES) break;
      inspected += 1;
      if (!message || typeof message !== 'object') continue;
      const candidate = message as { id?: unknown; source_id?: unknown };
      if (candidate.source_id !== evidence.sourceId) continue;
      if (candidate.id === undefined || candidate.id === null) {
        exactMatchesWithoutId += 1;
      } else {
        matchedIds.add(String(candidate.id));
      }
    }
  }

  if (matchedIds.size === 1 && exactMatchesWithoutId === 0) {
    return transition(
      env,
      operation,
      'CONFIRMED_SENT',
      'RECONCILIATION_CONFIRMED_SENT',
      'SYSTEM',
      'chatwoot-source-id',
      'CHATWOOT_SOURCE_ID_UNIQUE_MATCH',
      [...matchedIds][0]
    );
  }
  const reason = matchedIds.size + exactMatchesWithoutId > 1
    ? 'CHATWOOT_SOURCE_ID_DUPLICATE'
    : exactMatchesWithoutId === 1
      ? 'CHATWOOT_SOURCE_ID_INVALID_MATCH'
      : 'CHATWOOT_SOURCE_ID_NOT_FOUND_BOUNDED';
  return transition(
    env,
    operation,
    'STILL_AMBIGUOUS',
    'RECONCILIATION_STILL_AMBIGUOUS',
    'SYSTEM',
    'chatwoot-source-id',
    reason
  );
}

export async function reconcileOutboundOperation(
  env: Env,
  operationId: string,
  currentTargetEvidence: OutboundTargetEvidence
): Promise<ReconciliationResult> {
  const operation = await loadOperation(env, operationId);
  if (!isUnresolved(operation)) {
    if (operation.status === 'AMBIGUOUS') return result(operation);
    throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  }
  if (!operation.target_evidence_json || !targetEvidenceMatches(operation.target_evidence_json, currentTargetEvidence)) {
    return transition(
      env,
      operation,
      'STILL_AMBIGUOUS',
      'TARGET_IDENTITY_REJECTED',
      'SYSTEM',
      'outbound-reconciliation',
      'TARGET_IDENTITY_CHANGED'
    );
  }

  let evidence: OutboundTargetEvidence;
  try {
    evidence = parseTargetEvidence(operation.target_evidence_json);
  } catch {
    return transition(
      env,
      operation,
      'STILL_AMBIGUOUS',
      'RECONCILIATION_STILL_AMBIGUOUS',
      'SYSTEM',
      'outbound-reconciliation',
      'TARGET_EVIDENCE_INVALID'
    );
  }
  if (evidence.provider !== operation.destination_provider) {
    return transition(
      env,
      operation,
      'STILL_AMBIGUOUS',
      'TARGET_IDENTITY_REJECTED',
      'SYSTEM',
      'outbound-reconciliation',
      'TARGET_IDENTITY_CHANGED'
    );
  }
  if (evidence.provider === 'telegram') {
    return transition(
      env,
      operation,
      'STILL_AMBIGUOUS',
      'RECONCILIATION_STILL_AMBIGUOUS',
      'SYSTEM',
      'telegram-conservative',
      'TELEGRAM_HISTORICAL_LOOKUP_UNAVAILABLE'
    );
  }
  if (operation.operation_type !== 'SEND_MESSAGE' && operation.operation_type !== 'SEND_ATTACHMENT') {
    return transition(
      env,
      operation,
      'STILL_AMBIGUOUS',
      'RECONCILIATION_STILL_AMBIGUOUS',
      'SYSTEM',
      'chatwoot-source-id',
      'CHATWOOT_OPERATION_NOT_RECONCILABLE'
    );
  }
  return reconcileChatwoot(env, operation, evidence);
}

export async function manualMarkDelivered(
  env: Env,
  operationId: string,
  actor: ManualResolutionActor,
  reason: ManualDeliveredReason,
  providerMessageRef?: string
): Promise<ReconciliationResult> {
  const operation = await loadOperation(env, operationId);
  if (operation.status !== 'AMBIGUOUS') {
    throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  }
  if (!isUnresolved(operation)) return result(operation);
  if (operation.operation_type === 'CREATE_TOPIC' && !providerMessageRef) {
    throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  }
  return transition(
    env,
    operation,
    'MANUAL_MARK_DELIVERED',
    'MANUAL_MARK_DELIVERED',
    actor.type,
    boundedActorRef(actor.ref),
    reason,
    providerMessageRef
  );
}

export async function manualCancel(
  env: Env,
  operationId: string,
  actor: ManualResolutionActor,
  reason: ManualCancelReason
): Promise<ReconciliationResult> {
  const operation = await loadOperation(env, operationId);
  if (operation.status !== 'AMBIGUOUS') {
    throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  }
  if (!isUnresolved(operation)) return result(operation);
  return transition(
    env,
    operation,
    'MANUAL_CANCELLED',
    'MANUAL_CANCELLED',
    actor.type,
    boundedActorRef(actor.ref),
    reason
  );
}

export async function getAmbiguousOutboundOperation(
  env: Env,
  operationId: string
): Promise<OutboundOperation | null> {
  const operation = await env.DB.prepare(
    `SELECT * FROM outbound_operations WHERE id = ? AND status = 'AMBIGUOUS'`
  ).bind(operationId).first<OutboundOperation>();
  return operation || null;
}

export const CHATWOOT_RECONCILIATION_LIMITS = {
  pages: CHATWOOT_MAX_PAGES,
  messages: CHATWOOT_MAX_MESSAGES,
  runtimeMs: CHATWOOT_RECONCILIATION_RUNTIME_MS
} as const;
