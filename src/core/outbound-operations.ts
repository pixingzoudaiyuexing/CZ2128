import { DatabaseEnv } from './database';
import { logger } from '../observability/logger';
import {
  CancelledBeforeDeliveryError,
  ProviderDeliveryError,
  RetryableProcessingError,
  retryExhaustionSemantic,
  safeErrorCode
} from './errors';
import { SafeErrorCode } from './error-taxonomy';

const OUTBOUND_LEASE_SECONDS = 30;
const MAX_OUTBOUND_ATTEMPTS = 3;

export interface OutboundAttemptLifecycle {
  requestStarted(): Promise<void>;
  responseObserved(httpStatus: number): Promise<void>;
}

export async function executeOutboundOperation(
  env: DatabaseEnv,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  action: (operationId: string, lifecycle: OutboundAttemptLifecycle) => Promise<{ providerMessageRef?: string }>,
  deterministicOperationId: string,
  options: { leaseSeconds?: number } = {}
): Promise<{ status: string; providerMessageRef?: string }> {
  const id = deterministicOperationId;
  const now = Math.floor(Date.now() / 1000);
  
  await env.DB.prepare(
    `INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`
  ).bind(id, conversationId, destinationProvider, operationType, 'PENDING', now, now).run();

  let op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first<any>();
  if (!op) {
    throw new Error('Outbound operation could not be loaded');
  }
  if (
    op.conversation_id !== conversationId ||
    op.destination_provider !== destinationProvider ||
    op.operation_type !== operationType
  ) {
    throw new Error('Outbound operation identity collision');
  }

  // Crash recovery / idempotent retry
  if (op.status === 'SENT') {
    return { status: 'SENT', providerMessageRef: op.provider_message_ref || undefined };
  }

  if (op.status === 'FAILED_FINAL' || op.status === 'AMBIGUOUS') {
    return { status: op.status };
  }

  if (op.status === 'FAILED_RETRYABLE' && op.next_retry_at !== null && op.next_retry_at > now) {
    throw new RetryableProcessingError('OUTBOUND_RATE_LIMITED', op.next_retry_at - now);
  }

  
  if (op.status === 'SENDING') {
    const isLegacyActive = op.lease_until && op.lease_until > now && (!op.lease_token || !op.lease_token.startsWith('v2:'));
    const isV2Active = op.lease_until && op.lease_until > now && op.lease_token && op.lease_token.startsWith('v2:');

    if (isV2Active || isLegacyActive) {
      logger.info('Active outbound lease blocks duplicate send', { operation_id: id });
      throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', op.lease_until! - now);
    }

    const isMalformed = op.lease_until == null || op.lease_token == null;
    const isV2 = !isMalformed && op.lease_token.startsWith('v2:');

    if (isMalformed) {
      logger.warn('SENDING lease is malformed. Marking as AMBIGUOUS.', { operation_id: id });
      const ambiguousResult = await env.DB.prepare(
        `UPDATE outbound_operations 
         SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING', updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND (lease_until IS NULL OR lease_until <= ?) AND (lease_token IS NULL OR lease_token = ?)`
      ).bind(now, id, now, op.lease_token || null).run();
      if (ambiguousResult.meta.changes === 1) return { status: 'AMBIGUOUS' };
      throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
    }

    if (isV2 && op.request_started_at === null) {
      logger.info('Safe reclaim of expired pre-request lease', { operation_id: id });
      const reclaimResult = await env.DB.prepare(
        `UPDATE outbound_operations 
         SET status = 'PENDING', lease_until = NULL, lease_token = NULL,
             request_started_at = NULL, response_observed_at = NULL, response_http_status = NULL,
             retry_after_seconds = NULL, next_retry_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND lease_until <= ? AND lease_token = ? AND request_started_at IS NULL`
      ).bind(now, id, now, op.lease_token).run();
      if (reclaimResult.meta.changes === 1) {
        op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first<any>();
      } else {
        throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
      }
    } else {
      logger.warn('SENDING lease expired on started or legacy request. Marking as AMBIGUOUS.', { operation_id: id });
      const ambiguousResult = await env.DB.prepare(
        `UPDATE outbound_operations 
         SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING', updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND lease_until <= ? AND lease_token = ?`
      ).bind(now, id, now, op.lease_token).run();
      if (ambiguousResult.meta.changes === 1) return { status: 'AMBIGUOUS' };
      throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
    }
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
           SET request_started_at = ?, attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND status = 'SENDING' AND lease_token = ? AND request_started_at IS NULL`
        ).bind(ts, ts, id, leaseToken).run();
      } catch (e) {
        throw new RetryableProcessingError('D1_TRANSACTION_FAILED', OUTBOUND_LEASE_SECONDS);
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
        throw new RetryableProcessingError('D1_TRANSACTION_FAILED', OUTBOUND_LEASE_SECONDS);
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
    if (!hasStarted && error instanceof RetryableProcessingError && error.code === 'D1_TRANSACTION_FAILED') {
      throw error;
    }

    const outcome = error instanceof CancelledBeforeDeliveryError
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
      if (error instanceof CancelledBeforeDeliveryError || (error instanceof ProviderDeliveryError && outcome === 'FINAL')) {
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
    const failureResult = await env.DB.prepare(
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
    ).run();

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
