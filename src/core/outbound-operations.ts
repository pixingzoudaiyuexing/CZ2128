import { Env } from '../index';
import { logger } from '../observability/logger';

export async function executeOutboundOperation(
  env: Env,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  action: (operationId: string) => Promise<{ providerMessageRef?: string }>,
  deterministicOperationId?: string
): Promise<{ status: string; providerMessageRef?: string }> {
  const id = deterministicOperationId || crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  // Try to create the operation if it doesn't exist
  try {
    await env.DB.prepare(
      `INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, conversationId, destinationProvider, operationType, 'PENDING', now, now).run();
  } catch (e) {
    // Ignore unique constraint violation
  }

  const op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first<any>();
  if (!op) {
    throw new Error('Outbound operation could not be loaded');
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
    return { status: 'SENDING' };
  }

  // Ambiguous delivery checking (expired SENDING)
  if (op.status === 'SENDING' && op.lease_until && op.lease_until <= now) {
    logger.warn('SENDING lease expired. Marking as AMBIGUOUS to prevent blind resend.', { operation_id: id });
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'AMBIGUOUS', updated_at = ?
       WHERE id = ? AND status = 'SENDING'`
    ).bind(now, id).run();
    return { status: 'AMBIGUOUS' };
  }

  if (op.attempt_count >= 3) {
    logger.info('Bounded outbound attempts reached', { operation_id: id });
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'FAILED_FINAL', updated_at = ?
       WHERE id = ?`
    ).bind(now, id).run();
    return { status: 'FAILED_FINAL' };
  }

  // Atomic CAS: attempt to claim the lease
  const leaseUntil = now + 30; // 30 seconds
  const claimResult = await env.DB.prepare(
    `UPDATE outbound_operations 
     SET status = 'SENDING', lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND (status = 'PENDING' OR status = 'FAILED_RETRYABLE')`
  ).bind(leaseUntil, now, id).run();

  if (claimResult.meta.changes !== 1) {
    logger.info('Outbound lease claimed by another worker', { operation_id: id });
    return { status: 'LOCKED_BY_OTHER' };
  }

  const startTime = Date.now();
  try {
    const result = await action(id);
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'SENT', provider_message_ref = ?, updated_at = ?
       WHERE id = ?`
    ).bind(result.providerMessageRef || null, Math.floor(Date.now() / 1000), id).run();
    
    logger.info('Outbound operation SENT', { 
      operation_id: id, 
      result: 'SUCCESS', 
      duration_ms: Date.now() - startTime 
    });

    return { status: 'SENT', providerMessageRef: result.providerMessageRef };
  } catch (error: any) {
    logger.error('Outbound operation failed', error, { 
      operation_id: id, 
      error_category: 'PROVIDER_ERROR',
      duration_ms: Date.now() - startTime
    });

    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'FAILED_RETRYABLE', last_error = ?, updated_at = ?
       WHERE id = ?`
    ).bind(String(error), Math.floor(Date.now() / 1000), id).run();
    throw error;
  }
}
