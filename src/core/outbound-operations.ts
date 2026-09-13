import { Env } from '../index';

export async function executeOutboundOperation(
  env: Env,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  action: (operationId: string) => Promise<{ providerMessageRef?: string }>,
  deterministicOperationId?: string
): Promise<void> {
  const id = deterministicOperationId || crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  let op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first<any>();
  if (!op) {
    await env.DB.prepare(
      `INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, conversationId, destinationProvider, operationType, 'PENDING', now, now).run();
    op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first<any>();
  }

  if (op.status === 'SENT' || op.status === 'FAILED_FINAL') {
    return;
  }

  if (op.status === 'SENDING' && op.lease_until && op.lease_until > now) {
    return; // Active lease, block concurrent send
  }

  if (op.attempt_count >= 3) {
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'FAILED_FINAL', updated_at = ?
       WHERE id = ?`
    ).bind(now, id).run();
    return; // Bounded attempts reached
  }

  const leaseUntil = now + 30; // 30 seconds
  await env.DB.prepare(
    `UPDATE outbound_operations 
     SET status = 'SENDING', lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ?`
  ).bind(leaseUntil, now, id).run();

  try {
    const result = await action(id);
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'SENT', provider_message_ref = ?, updated_at = ?
       WHERE id = ?`
    ).bind(result.providerMessageRef || null, Math.floor(Date.now() / 1000), id).run();
  } catch (error: any) {
    await env.DB.prepare(
      `UPDATE outbound_operations 
       SET status = 'FAILED_RETRYABLE', last_error = ?, updated_at = ?
       WHERE id = ?`
    ).bind(String(error), Math.floor(Date.now() / 1000), id).run();
    throw error;
  }
}
