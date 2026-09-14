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

export async function executeOutboundOperation(
  env: DatabaseEnv,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  action: (operationId: string) => Promise<{ providerMessageRef?: string }>,
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

  const op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first<any>();
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

  if (op.status === 'SENDING' && op.lease_until && op.lease_until > now) {
    logger.info('Active outbound lease blocks duplicate send', { operation_id: id });
    throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', op.lease_until - now);
  }

  // Ambiguous delivery checking (expired SENDING)
  if (op.status === 'SENDING' && op.lease_until && op.lease_until <= now) {
    logger.warn('SENDING lease expired. Marking as AMBIGUOUS to prevent blind resend.', { operation_id: id });
    const ambiguousResult = await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'AMBIGUOUS', updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND lease_until <= ?`
    ).bind(now, id, now).run();
    if (ambiguousResult.meta.changes === 1) return { status: 'AMBIGUOUS' };
    throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', OUTBOUND_LEASE_SECONDS);
  }

  if (op.attempt_count >= MAX_OUTBOUND_ATTEMPTS) {
    logger.info('Bounded outbound attempts reached', {
      operation_id: id,
      error_code: 'OUTBOUND_RETRY_EXHAUSTED',
      retry_exhausted: true
    });
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'FAILED_FINAL', updated_at = ?
       WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
    ).bind(now, id).run();
    return { status: 'FAILED_FINAL' };
  }

  // Atomic CAS: attempt to claim the lease
  const leaseSeconds = options.leaseSeconds && Number.isSafeInteger(options.leaseSeconds)
    ? Math.min(Math.max(options.leaseSeconds, OUTBOUND_LEASE_SECONDS), 300)
    : OUTBOUND_LEASE_SECONDS;
  const leaseUntil = now + leaseSeconds;
  const leaseToken = crypto.randomUUID();
  const claimResult = await env.DB.prepare(
    `UPDATE outbound_operations 
     SET status = 'SENDING', lease_until = ?, lease_token = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
  ).bind(leaseUntil, leaseToken, now, id).run();

  if (claimResult.meta.changes !== 1) {
    logger.info('Outbound lease claimed by another worker', { operation_id: id });
    throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', leaseSeconds);
  }

  const startTime = Date.now();
  let result: { providerMessageRef?: string };
  try {
    result = await action(id);
  } catch (error: unknown) {
    const outcome = error instanceof CancelledBeforeDeliveryError
      ? 'FINAL'
      : error instanceof ProviderDeliveryError
        ? error.outcome
        : 'AMBIGUOUS';
    const attemptNumber = Number(op.attempt_count) + 1;
    const exhaustion = retryExhaustionSemantic(attemptNumber, MAX_OUTBOUND_ATTEMPTS);
    const nextStatus = outcome === 'RETRYABLE' && exhaustion === 'RETRY_PENDING'
      ? 'FAILED_RETRYABLE'
      : outcome === 'RETRYABLE' || outcome === 'FINAL'
        ? 'FAILED_FINAL'
        : 'AMBIGUOUS';
    const errorCode: SafeErrorCode = outcome === 'RETRYABLE' && exhaustion === 'RETRY_EXHAUSTED'
      ? 'OUTBOUND_RETRY_EXHAUSTED'
      : error instanceof ProviderDeliveryError || error instanceof CancelledBeforeDeliveryError
        ? safeErrorCode(error)
        : 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED';

    logger.error('Outbound operation failed', error, {
      operation_id: id,
      error_category: 'PROVIDER_ERROR',
      retry_exhausted: outcome === 'RETRYABLE' && exhaustion === 'RETRY_EXHAUSTED',
      duration_ms: Date.now() - startTime
    });
    
    const failureResult = await env.DB.prepare(
      `UPDATE outbound_operations
       SET status = ?, last_error = ?, lease_until = NULL, lease_token = NULL, updated_at = ?
       WHERE id = ? AND status = 'SENDING' AND lease_token = ?`
    ).bind(nextStatus, errorCode, Math.floor(Date.now() / 1000), id, leaseToken).run();

    if (failureResult.meta.changes !== 1) {
      throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', OUTBOUND_LEASE_SECONDS);
    }
    if (nextStatus === 'FAILED_RETRYABLE') {
      throw new RetryableProcessingError(
        errorCode,
        error instanceof ProviderDeliveryError ? error.retryAfterSeconds ?? 5 : 5,
        error instanceof ProviderDeliveryError ? {
          provider: error.provider,
          stage: error.stage,
          httpStatus: error.httpStatus
        } : {}
      );
    }
    return { status: nextStatus };
  }

  const sentResult = await env.DB.prepare(
    `UPDATE outbound_operations
     SET status = 'SENT', provider_message_ref = ?, lease_until = NULL, lease_token = NULL, updated_at = ?
     WHERE id = ? AND status = 'SENDING' AND lease_token = ?`
  ).bind(result.providerMessageRef || null, Math.floor(Date.now() / 1000), id, leaseToken).run();
  if (sentResult.meta.changes !== 1) {
    throw new RetryableProcessingError('OUTBOUND_RESULT_PERSIST_AMBIGUOUS', OUTBOUND_LEASE_SECONDS);
  }

  logger.info('Outbound operation SENT', {
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
