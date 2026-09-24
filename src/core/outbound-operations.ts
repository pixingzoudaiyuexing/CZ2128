import { DatabaseEnv } from './database';
import { logger } from '../observability/logger';
import {
  AiScopeDeniedBeforeDeliveryError,
  CancelledBeforeDeliveryError,
  ProviderDeliveryError,
  RetryableProcessingError,
  SafeError,
  StaleAiTriggerBeforeDeliveryError,
  retryExhaustionSemantic,
  safeErrorCode
} from './errors';
import { SafeErrorCode } from './error-taxonomy';
import { OutboundOperation } from './domain';
import {
  OutboundSubjectIdentity,
  OutboundTargetEvidence,
  serializeTargetEvidence,
  targetEvidenceMatches
} from './outbound-evidence';
import { auditAfterPreviousChange, d1Changed } from './reliability-audit';

const OUTBOUND_LEASE_SECONDS = 30;
export const MAX_OUTBOUND_ATTEMPTS = 3;

export interface OutboundAttemptLifecycle {
  requestStarted(): Promise<void>;
  responseObserved(httpStatus: number): Promise<void>;
}

export interface ExecuteOutboundOperationOptions {
  leaseSeconds?: number;
  allowCreate?: boolean;
  parentOperationId?: string;
  subject: OutboundSubjectIdentity;
  targetEvidence: OutboundTargetEvidence;
}

export class OutboundOperationIdentityCollisionError extends Error {
  constructor(public readonly operationId: string) {
    super('Outbound operation identity collision');
    this.name = 'OutboundOperationIdentityCollisionError';
  }
}

type OutboundAbandonmentReason = 'DISCARDED_STALE' | 'CANCELLED_BY_HANDOFF' | 'AI_SCOPE_DENIED';

function abandonmentAction(reason: OutboundAbandonmentReason): string {
  if (reason === 'DISCARDED_STALE') return 'HISTORICAL_AI_STALE_DISCARDED';
  if (reason === 'CANCELLED_BY_HANDOFF') return 'AI_HANDOFF_CANCELLED';
  return 'AI_SCOPE_CANCELLED';
}

function abandonmentReason(error: unknown): OutboundAbandonmentReason | null {
  if (error instanceof StaleAiTriggerBeforeDeliveryError) return 'DISCARDED_STALE';
  if (error instanceof CancelledBeforeDeliveryError) return 'CANCELLED_BY_HANDOFF';
  if (error instanceof AiScopeDeniedBeforeDeliveryError) return 'AI_SCOPE_DENIED';
  return null;
}

async function abandonmentFailureAuditId(
  operationId: string,
  oldState: string,
  reason: OutboundAbandonmentReason
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([operationId, oldState, reason]))
  );
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `abandoned-ai:${hex}`;
}

export async function getOutboundOperation(
  env: DatabaseEnv,
  id: string
): Promise<OutboundOperation | null> {
  return env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
    .bind(id).first<OutboundOperation>();
}

async function loadOperation(env: DatabaseEnv, id: string): Promise<OutboundOperation> {
  const operation = await getOutboundOperation(env, id);
  if (!operation) throw new Error('Outbound operation could not be loaded');
  return operation;
}

export async function prepareOutboundOperation(
  env: DatabaseEnv,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  deterministicOperationId: string,
  options: ExecuteOutboundOperationOptions
): Promise<OutboundOperation | null> {
  const targetEvidenceJson = serializeTargetEvidence(options.targetEvidence);
  let operation = await getOutboundOperation(env, deterministicOperationId);
  if (!operation && options.allowCreate === false) return null;

  if (!operation) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO outbound_operations
       (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at,
        subject_type, subject_ref, target_evidence_json, parent_operation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`
    ).bind(
      deterministicOperationId,
      conversationId,
      destinationProvider,
      operationType,
      'PENDING',
      now,
      now,
      options.subject.type,
      options.subject.ref,
      targetEvidenceJson,
      options.parentOperationId || null
    ).run();
    operation = await loadOperation(env, deterministicOperationId);
  }

  if (
    operation.conversation_id !== conversationId ||
    operation.destination_provider !== destinationProvider ||
    operation.operation_type !== operationType
  ) {
    throw new OutboundOperationIdentityCollisionError(deterministicOperationId);
  }
  assertSubjectIdentity(operation, options.subject);
  if (options.parentOperationId !== undefined && operation.parent_operation_id !== options.parentOperationId) {
    throw new OutboundOperationIdentityCollisionError(deterministicOperationId);
  }
  operation = await establishEvidence(env, operation, options.subject, targetEvidenceJson);
  if (
    operation.status !== 'SENT' &&
    operation.status !== 'AMBIGUOUS' &&
    operation.status !== 'FAILED_FINAL' &&
    (!operation.target_evidence_json ||
      !targetEvidenceMatches(operation.target_evidence_json, options.targetEvidence))
  ) {
    operation = await rejectTargetIdentity(env, operation, 'TARGET_IDENTITY_CHANGED');
  }
  return operation;
}

function assertSubjectIdentity(operation: OutboundOperation, subject: OutboundSubjectIdentity): void {
  if (operation.subject_type == null && operation.subject_ref == null) return;
  if (operation.subject_type !== subject.type || operation.subject_ref !== subject.ref) {
    throw new Error('Outbound operation subject identity collision');
  }
}

async function rejectTargetIdentity(
  env: DatabaseEnv,
  operation: OutboundOperation,
  reasonCode: 'TARGET_IDENTITY_CHANGED' | 'TARGET_EVIDENCE_MISSING_UNSAFE'
): Promise<OutboundOperation> {
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbound_operations
       SET status = 'FAILED_FINAL', last_error = 'TARGET_IDENTITY_CHANGED',
           lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
    ).bind(now, operation.id),
    auditAfterPreviousChange(env, {
      id: crypto.randomUUID(),
      entityType: 'OUTBOUND_OPERATION',
      entityId: operation.id,
      action: 'TARGET_IDENTITY_REJECTED',
      actorType: 'SYSTEM',
      actorRef: 'system:outbound-execution',
      oldState: operation.status,
      newState: 'FAILED_FINAL',
      reasonCode,
      createdAt: now
    })
  ]);
  if (d1Changed(results[0]) !== d1Changed(results[1])) {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
  }
  return loadOperation(env, operation.id);
}

async function establishEvidence(
  env: DatabaseEnv,
  operation: OutboundOperation,
  subject: OutboundSubjectIdentity,
  targetEvidenceJson: string
): Promise<OutboundOperation> {
  assertSubjectIdentity(operation, subject);
  if (
    operation.subject_type != null &&
    operation.subject_ref != null &&
    operation.target_evidence_json != null
  ) {
    return operation;
  }

  const hasPartialEvidence =
    operation.subject_type != null ||
    operation.subject_ref != null ||
    operation.target_evidence_json != null;
  if (hasPartialEvidence) {
    return rejectTargetIdentity(env, operation, 'TARGET_EVIDENCE_MISSING_UNSAFE');
  }

  if (
    operation.attempt_count !== 0 ||
    operation.request_started_at !== null ||
    (operation.status !== 'PENDING' && operation.status !== 'FAILED_RETRYABLE')
  ) {
    return rejectTargetIdentity(env, operation, 'TARGET_EVIDENCE_MISSING_UNSAFE');
  }

  const result = await env.DB.prepare(
    `UPDATE outbound_operations
     SET subject_type = ?, subject_ref = ?, target_evidence_json = ?, updated_at = ?
     WHERE id = ? AND attempt_count = 0 AND request_started_at IS NULL
       AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')
       AND subject_type IS NULL AND subject_ref IS NULL AND target_evidence_json IS NULL`
  ).bind(
    subject.type,
    subject.ref,
    targetEvidenceJson,
    Math.floor(Date.now() / 1000),
    operation.id
  ).run();
  if (result.meta.changes !== 1) {
    const current = await loadOperation(env, operation.id);
    assertSubjectIdentity(current, subject);
    return current;
  }
  return loadOperation(env, operation.id);
}

export async function executeOutboundOperation(
  env: DatabaseEnv,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  action: (operationId: string, lifecycle: OutboundAttemptLifecycle) => Promise<{ providerMessageRef?: string }>,
  deterministicOperationId: string,
  options: ExecuteOutboundOperationOptions
): Promise<{ status: string; providerMessageRef?: string }> {
  const id = deterministicOperationId;
  const now = Math.floor(Date.now() / 1000);
  const targetEvidenceJson = serializeTargetEvidence(options.targetEvidence);
  let op = await getOutboundOperation(env, id);
  if (!op && options.allowCreate === false) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
  if (!op) {
    await env.DB.prepare(
      `INSERT INTO outbound_operations
       (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at,
        subject_type, subject_ref, target_evidence_json, parent_operation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`
    ).bind(
      id, conversationId, destinationProvider, operationType, 'PENDING', now, now,
      options.subject.type, options.subject.ref, targetEvidenceJson, options.parentOperationId || null
    ).run();
    op = await loadOperation(env, id);
  }
  if (
    op.conversation_id !== conversationId ||
    op.destination_provider !== destinationProvider ||
    op.operation_type !== operationType
  ) {
    throw new OutboundOperationIdentityCollisionError(id);
  }
  assertSubjectIdentity(op, options.subject);
  if (options.parentOperationId !== undefined && op.parent_operation_id !== options.parentOperationId) {
    throw new OutboundOperationIdentityCollisionError(id);
  }

  // Crash recovery / idempotent retry
  if (op.status === 'SENT') {
    return { status: 'SENT', providerMessageRef: op.provider_message_ref || undefined };
  }

  if (
    op.status === 'AMBIGUOUS' &&
    (op.reconciliation_status === 'CONFIRMED_SENT' || op.reconciliation_status === 'MANUAL_MARK_DELIVERED')
  ) {
    return { status: 'SENT', providerMessageRef: op.provider_message_ref || undefined };
  }

  if (op.status === 'FAILED_FINAL' || op.status === 'AMBIGUOUS') {
    return { status: op.status };
  }

  
  if (op.status === 'SENDING') {
    const isMalformed = op.lease_until == null || op.lease_token == null;

    if (isMalformed) {
      logger.warn('SENDING lease is malformed. Marking as AMBIGUOUS.', { operation_id: id });
      const ambiguousResult = await env.DB.prepare(
        `UPDATE outbound_operations 
         SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING', updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND (lease_until IS NULL OR lease_token IS NULL)`
      ).bind(now, id).run();
      if (ambiguousResult.meta.changes === 1) return { status: 'AMBIGUOUS' };
      throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
    }

    const leaseUntil = op.lease_until as number;
    const leaseToken = op.lease_token as string;
    const isLegacyActive = leaseUntil > now && !leaseToken.startsWith('v2:');
    const isV2Active = leaseUntil > now && leaseToken.startsWith('v2:');

    if (isV2Active || isLegacyActive) {
      logger.info('Active outbound lease blocks duplicate send', { operation_id: id });
      throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', leaseUntil - now);
    }

    const isV2 = leaseToken.startsWith('v2:');

    if (isV2 && op.request_started_at === null) {
      logger.info('Safe reclaim of expired pre-request lease', { operation_id: id });
      const reclaimResult = await env.DB.prepare(
        `UPDATE outbound_operations 
         SET status = 'PENDING', lease_until = NULL, lease_token = NULL,
             request_started_at = NULL, response_observed_at = NULL, response_http_status = NULL,
             retry_after_seconds = NULL, next_retry_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND lease_until <= ? AND lease_token = ? AND request_started_at IS NULL`
      ).bind(now, id, now, leaseToken).run();
      if (reclaimResult.meta.changes === 1) {
        op = await loadOperation(env, id);
      } else {
        throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
      }
    } else {
      logger.warn('SENDING lease expired on started or legacy request. Marking as AMBIGUOUS.', { operation_id: id });
      const ambiguousResult = await env.DB.prepare(
        `UPDATE outbound_operations 
         SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING', updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND lease_until <= ? AND lease_token = ?`
      ).bind(now, id, now, leaseToken).run();
      if (ambiguousResult.meta.changes === 1) return { status: 'AMBIGUOUS' };
      throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
    }
  }

  op = await establishEvidence(env, op, options.subject, targetEvidenceJson);
  assertSubjectIdentity(op, options.subject);
  if (op.status === 'FAILED_FINAL') return { status: 'FAILED_FINAL' };
  if (!op.target_evidence_json || !targetEvidenceMatches(op.target_evidence_json, options.targetEvidence)) {
    op = await rejectTargetIdentity(env, op, 'TARGET_IDENTITY_CHANGED');
    return { status: op.status };
  }

  if (op.status === 'FAILED_RETRYABLE' && op.next_retry_at !== null && op.next_retry_at > now) {
    throw new RetryableProcessingError('OUTBOUND_RATE_LIMITED', op.next_retry_at - now);
  }

  if (op.attempt_count >= MAX_OUTBOUND_ATTEMPTS) {
    logger.info('Bounded outbound attempts reached', {
      operation_id: id,
      error_code: 'OUTBOUND_RETRY_EXHAUSTED',
      retry_exhausted: true
    });
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'FAILED_FINAL', last_error = 'OUTBOUND_RETRY_EXHAUSTED', updated_at = ?
       WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
    ).bind(now, id).run();
    return { status: 'FAILED_FINAL' };
  }

  // Atomic CAS: attempt to claim the lease
  const leaseSeconds = options.leaseSeconds && Number.isSafeInteger(options.leaseSeconds)
    ? Math.min(Math.max(options.leaseSeconds, OUTBOUND_LEASE_SECONDS), 300)
    : OUTBOUND_LEASE_SECONDS;
  const leaseUntil = now + leaseSeconds;
  const leaseToken = `v2:${crypto.randomUUID()}`;
  const startResult = await env.DB.prepare(
    `UPDATE outbound_operations 
     SET status = 'SENDING', lease_until = ?, lease_token = ?, 
         request_started_at = NULL, response_observed_at = NULL, response_http_status = NULL, 
         retry_after_seconds = NULL, next_retry_at = NULL, reconciliation_status = 'NOT_REQUIRED', updated_at = ?
     WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
  ).bind(leaseUntil, leaseToken, now, id).run();

  if (startResult.meta.changes !== 1) {
    logger.info('Outbound lease claimed by another worker', { operation_id: id });
    throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', leaseSeconds);
  }

  const startTime = Date.now();
  let hasStarted = false;
  
  const lifecycle: OutboundAttemptLifecycle = {
    async requestStarted() {
      const ts = Math.floor(Date.now() / 1000);
      let result;
      try {
        result = await env.DB.prepare(
          `UPDATE outbound_operations
           SET request_started_at = ?, attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
           WHERE id = ? AND status = 'SENDING' AND lease_token = ? AND request_started_at IS NULL`
        ).bind(ts, ts, id, leaseToken).run();
      } catch (e) {
        throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
      }
      if (result.meta.changes === 0) {
        throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
      }
      hasStarted = true;
    },
    async responseObserved(httpStatus: number) {
      const ts = Math.floor(Date.now() / 1000);
      let result;
      try {
        result = await env.DB.prepare(
          `UPDATE outbound_operations
           SET response_observed_at = ?, response_http_status = ?, updated_at = ?
           WHERE id = ? AND status = 'SENDING' AND lease_token = ? AND request_started_at IS NOT NULL`
        ).bind(ts, httpStatus, ts, id, leaseToken).run();
      } catch (e) {
        throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
      }
      if (result.meta.changes === 0) {
        throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
      }
    }
  };
let result: { providerMessageRef?: string };
  try {
    result = await action(id, lifecycle);
  } catch (error: unknown) {
    if (error instanceof RetryableProcessingError && error.code === 'CONCURRENCY_CAS_CONFLICT') {
      logger.warn('Stale owner detected during request lifecycle, exiting safely', { operation_id: id });
      throw error;
    }
    if (!hasStarted && error instanceof RetryableProcessingError && error.code === 'D1_RESULT_PERSIST_FAILED') {
      throw error;
    }

    const abandonment = abandonmentReason(error);
    const outcome = abandonment
      ? 'FINAL'
      : error instanceof ProviderDeliveryError
        ? error.outcome
        : 'AMBIGUOUS';

    let attemptNumber = Number(op.attempt_count);
    if (hasStarted) {
      attemptNumber += 1;
    }
    
    let nextStatus: string;
    let errorCode: SafeErrorCode;
    let reconciliationStatus = 'NOT_REQUIRED';
    let setRetryAfter = false;
    let retryAfterSecs = 0;

    if (!hasStarted) {
      if (
        abandonment ||
        (error instanceof ProviderDeliveryError && outcome === 'FINAL')
      ) {
        nextStatus = 'FAILED_FINAL';
        errorCode = safeErrorCode(error);
      } else {
        nextStatus = 'AMBIGUOUS';
        reconciliationStatus = 'PENDING';
        errorCode = error instanceof ProviderDeliveryError ? safeErrorCode(error) : (error instanceof RetryableProcessingError ? safeErrorCode(error) : 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED');
      }
    } else {
      const exhaustion = retryExhaustionSemantic(attemptNumber, MAX_OUTBOUND_ATTEMPTS);
      if (outcome === 'RETRYABLE' && exhaustion === 'RETRY_PENDING') {
        nextStatus = 'FAILED_RETRYABLE';
        errorCode = safeErrorCode(error);
        setRetryAfter = true;
        retryAfterSecs = error instanceof ProviderDeliveryError ? error.retryAfterSeconds ?? 5 : 5;
      } else if (outcome === 'RETRYABLE' || outcome === 'FINAL') {
        nextStatus = 'FAILED_FINAL';
        errorCode = outcome === 'RETRYABLE' && exhaustion === 'RETRY_EXHAUSTED'
          ? 'OUTBOUND_RETRY_EXHAUSTED'
          : safeErrorCode(error);
      } else {
        nextStatus = 'AMBIGUOUS';
        reconciliationStatus = 'PENDING';
        errorCode = error instanceof ProviderDeliveryError ? safeErrorCode(error) : (error instanceof RetryableProcessingError ? safeErrorCode(error) : 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED');
      }
    }

    logger.error('Outbound operation failed', error, {
      operation_id: id,
      error_category: 'PROVIDER_ERROR',
      duration_ms: Date.now() - startTime
    });
    
    const ts = Math.floor(Date.now() / 1000);
    const failureStatement = env.DB.prepare(
      `UPDATE outbound_operations
       SET status = ?, last_error = ?, lease_until = NULL, lease_token = NULL, reconciliation_status = ?,
           retry_after_seconds = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND lease_token = ?`
    ).bind(
      nextStatus, 
      errorCode, 
      reconciliationStatus,
      setRetryAfter ? retryAfterSecs : null,
      setRetryAfter ? ts + retryAfterSecs : null,
      ts, id, leaseToken
    );

    let failureResult: D1Result;
    if (abandonment) {
      const results = await env.DB.batch([
        failureStatement,
        auditAfterPreviousChange(env, {
          id: await abandonmentFailureAuditId(id, 'SENDING', abandonment),
          entityType: 'OUTBOUND_OPERATION',
          entityId: id,
          action: abandonmentAction(abandonment),
          actorType: 'SYSTEM',
          actorRef: 'system:ai-handler',
          oldState: 'SENDING',
          newState: 'FAILED_FINAL',
          reasonCode: abandonment,
          createdAt: ts
        })
      ]);
      if (d1Changed(results[0]) !== d1Changed(results[1])) {
        throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
      }
      failureResult = results[0];
    } else {
      failureResult = await failureStatement.run();
    }

    if (failureResult.meta.changes !== 1) {
      throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
    }
    if (nextStatus === 'FAILED_RETRYABLE') {
      throw new RetryableProcessingError(
        errorCode,
        retryAfterSecs,
        error instanceof ProviderDeliveryError ? {
          provider: error.provider,
          stage: error.stage,
          httpStatus: error.httpStatus
        } : {}
      );
    }
    return { status: nextStatus };
  }

  // Success path
  if (!hasStarted) {
    logger.error('Outbound action succeeded without recording requestStarted', { operation_id: id });
    const ts = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE outbound_operations
       SET status = 'AMBIGUOUS', last_error = 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED', lease_until = NULL, lease_token = NULL, reconciliation_status = 'PENDING', updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND lease_token = ?`
    ).bind(ts, id, leaseToken).run();
    return { status: 'AMBIGUOUS' };
  }

  const sentResult = await env.DB.prepare(
    `UPDATE outbound_operations
     SET status = 'SENT', provider_message_ref = ?, lease_until = NULL, lease_token = NULL, last_error = NULL, retry_after_seconds = NULL, next_retry_at = NULL, reconciliation_status = 'NOT_REQUIRED', updated_at = ?
     WHERE id = ? AND status = 'SENDING' AND lease_token = ?`
  ).bind(result.providerMessageRef || null, Math.floor(Date.now() / 1000), id, leaseToken).run();
  
  if (sentResult.meta.changes !== 1) {
    throw new RetryableProcessingError('OUTBOUND_RESULT_PERSIST_AMBIGUOUS', OUTBOUND_LEASE_SECONDS);
  }logger.info('Outbound operation SENT', {
    operation_id: id,
    result: 'SUCCESS',
    duration_ms: Date.now() - startTime
  });

  return { status: 'SENT', providerMessageRef: result.providerMessageRef };
}

export interface FinalizeNeverStartedOutboundAudit {
  id: string;
  action: string;
  actorRef: string;
  reasonCode: string;
}

export async function finalizeNeverStartedOutboundOperation(
  env: DatabaseEnv,
  expected: OutboundOperation,
  reason: SafeErrorCode,
  audit: FinalizeNeverStartedOutboundAudit
): Promise<{ operation: OutboundOperation; changed: boolean }> {
  if (
    (expected.status !== 'PENDING' && expected.status !== 'FAILED_RETRYABLE') ||
    expected.attempt_count !== 0 ||
    expected.provider_message_ref !== null ||
    expected.request_started_at !== null ||
    expected.response_observed_at !== null ||
    expected.response_http_status !== null ||
    expected.lease_until !== null ||
    expected.lease_token !== null
  ) {
    return { operation: expected, changed: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbound_operations
       SET status = 'FAILED_FINAL', last_error = ?, lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE id = ?
         AND conversation_id = ?
         AND destination_provider = ?
         AND operation_type = ?
         AND status = ?
         AND attempt_count = 0
         AND provider_message_ref IS NULL
         AND request_started_at IS NULL
         AND response_observed_at IS NULL
         AND response_http_status IS NULL
         AND lease_until IS NULL
         AND lease_token IS NULL
         AND subject_type IS ?
         AND subject_ref IS ?
         AND target_evidence_json IS ?
         AND reconciliation_status IS ?`
    ).bind(
      reason,
      now,
      expected.id,
      expected.conversation_id,
      expected.destination_provider,
      expected.operation_type,
      expected.status,
      expected.subject_type,
      expected.subject_ref,
      expected.target_evidence_json,
      expected.reconciliation_status
    ),
    auditAfterPreviousChange(env, {
      id: audit.id,
      entityType: 'OUTBOUND_OPERATION',
      entityId: expected.id,
      action: audit.action,
      actorType: 'SYSTEM',
      actorRef: audit.actorRef,
      oldState: expected.status,
      newState: 'FAILED_FINAL',
      reasonCode: audit.reasonCode,
      createdAt: now
    })
  ]);
  if (d1Changed(results[0]) !== d1Changed(results[1])) {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
  }
  return {
    operation: await loadOperation(env, expected.id),
    changed: d1Changed(results[0])
  };
}

export async function markOutboundOperationFinal(
  env: DatabaseEnv,
  operationId: string,
  reason: SafeErrorCode
): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbound_operations
     SET status = 'FAILED_FINAL', last_error = ?, lease_until = NULL, lease_token = NULL, updated_at = ?
     WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
  ).bind(reason, Math.floor(Date.now() / 1000), operationId).run();
}
