import { Env } from '../config/env';
import { Conversation } from './domain';
import { logger } from '../observability/logger';
import { getAIConfig } from '../config/ai';
import { RetryableProcessingError } from './errors';

export async function pauseOperator(env: Env, convId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE conversations 
     SET ai_mode = CASE WHEN ai_mode = 'PAUSED_MANUAL' THEN ai_mode ELSE 'PAUSED_OPERATOR' END,
         last_operator_reply_at = ?,
         ai_generation_id = NULL,
         ai_generation_started_at = NULL,
         ai_generation_message_id = NULL,
         ai_handoff_epoch = ai_handoff_epoch + 1,
         updated_at = ?,
         version = version + 1
     WHERE id = ?`
  ).bind(now, now, convId).run();
  
  logger.info('AI paused due to operator reply', { conversation_id: convId });
}

export async function pauseManual(env: Env, convId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE conversations 
     SET ai_mode = 'PAUSED_MANUAL',
         ai_generation_id = NULL,
         ai_generation_started_at = NULL,
         ai_generation_message_id = NULL,
         ai_handoff_epoch = ai_handoff_epoch + 1,
         updated_at = ?,
         version = version + 1
     WHERE id = ?`
  ).bind(now, convId).run();
  
  logger.info('AI paused manually (/ai_off)', { conversation_id: convId });
}

export async function resumeManual(env: Env, convId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE conversations 
     SET ai_mode = 'ENABLED',
         ai_generation_id = NULL,
         ai_generation_started_at = NULL,
         ai_generation_message_id = NULL,
         updated_at = ?,
         version = version + 1
     WHERE id = ?`
  ).bind(now, convId).run();
  
  logger.info('AI resumed manually (/ai_on)', { conversation_id: convId });
}

export async function applyManualCommand(
  env: Env,
  convId: string,
  updateRef: string,
  mode: 'ENABLED' | 'PAUSED_MANUAL'
): Promise<'APPLIED' | 'CURRENT' | 'STALE'> {
  const updateId = Number(updateRef);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error('Invalid Telegram command update id');
  }
  const now = Math.floor(Date.now() / 1000);
  const setMode = mode === 'PAUSED_MANUAL'
    ? `SET ai_mode = 'PAUSED_MANUAL',
           ai_generation_id = NULL,
           ai_generation_started_at = NULL,
           ai_generation_message_id = NULL,
           ai_handoff_epoch = ai_handoff_epoch + 1,
           last_ai_command_update_id = ?, updated_at = ?, version = version + 1`
    : `SET ai_mode = 'ENABLED',
           ai_generation_id = NULL,
           ai_generation_started_at = NULL,
           ai_generation_message_id = NULL,
           last_ai_command_update_id = ?, updated_at = ?, version = version + 1`;
  const result = await env.DB.prepare(
    `UPDATE conversations ${setMode}
     WHERE id = ? AND (last_ai_command_update_id IS NULL OR last_ai_command_update_id < ?)`
  ).bind(updateId, now, convId, updateId).run();
  if (result.meta.changes === 1) return 'APPLIED';

  const current = await env.DB.prepare(
    'SELECT last_ai_command_update_id FROM conversations WHERE id = ?'
  ).bind(convId).first<{ last_ai_command_update_id: number | null }>();
  if (!current) throw new Error('Conversation not found for AI command');
  return Number(current.last_ai_command_update_id) === updateId ? 'CURRENT' : 'STALE';
}

export async function checkAutoResume(env: Env, conv: Conversation): Promise<boolean> {
  if (conv.ai_mode === 'ENABLED') return true;
  if (conv.ai_mode === 'PAUSED_MANUAL') return false;

  const config = getAIConfig(env);
  const now = Math.floor(Date.now() / 1000);
  
  if (conv.ai_mode === 'PAUSED_OPERATOR' && conv.last_operator_reply_at) {
    if (now - conv.last_operator_reply_at >= config.operatorPauseTimeoutSeconds) {
      const claim = await env.DB.prepare(
        `UPDATE conversations 
         SET ai_mode = 'ENABLED', updated_at = ?, version = version + 1
         WHERE id = ? AND ai_mode = 'PAUSED_OPERATOR' AND last_operator_reply_at = ?`
      ).bind(now, conv.id, conv.last_operator_reply_at).run();
      
      if (claim.meta.changes === 1) {
        logger.info('AI auto-resumed due to operator timeout', { conversation_id: conv.id });
        return true;
      }
    }
  }
  return false;
}

export async function acquireGenerationLease(
  env: Env, 
  convId: string, 
  messageId: string
): Promise<
  | { success: true; generationId: string; handoffEpoch: number }
  | { success: false; reason: 'PAUSED' | 'HANDOFF'; handoffEpoch: number }
> {
  const config = getAIConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const generationId = crypto.randomUUID();
  const leaseExpiryThreshold = now - config.generationLeaseSeconds;

  const conv = await env.DB.prepare(
    `SELECT ai_mode, ai_generation_id, ai_generation_started_at, ai_handoff_epoch
     FROM conversations WHERE id = ?`
  ).bind(convId).first<any>();

  if (!conv) {
    return { success: false, reason: 'PAUSED', handoffEpoch: 0 };
  }

  const expectedEpoch = Number(conv.ai_handoff_epoch);
  if (conv.ai_mode !== 'ENABLED') {
    return { success: false, reason: 'PAUSED', handoffEpoch: expectedEpoch };
  }

  if (conv.ai_generation_id && conv.ai_generation_started_at && conv.ai_generation_started_at >= leaseExpiryThreshold) {
    const expiresAt = conv.ai_generation_started_at + config.generationLeaseSeconds;
    const delaySeconds = expiresAt - now + 2;
    throw new RetryableProcessingError('AI generation lease is active', Math.max(delaySeconds, 2));
  }

  if (env.hooks && env.hooks.beforeGenerationLeaseClaim) await env.hooks.beforeGenerationLeaseClaim(env, convId);

  const claim = await env.DB.prepare(
    `UPDATE conversations 
     SET ai_generation_id = ?,
         ai_generation_started_at = ?,
         ai_generation_message_id = ?,
         updated_at = ?,
         version = version + 1
     WHERE id = ? 
       AND ai_mode = 'ENABLED'
       AND ai_handoff_epoch = ?
       AND (ai_generation_id IS NULL OR ai_generation_started_at < ?)`
  ).bind(generationId, now, messageId, now, convId, expectedEpoch, leaseExpiryThreshold).run();

  if (claim.meta.changes === 1) {
    return { success: true, generationId, handoffEpoch: expectedEpoch };
  }

  const current = await env.DB.prepare(
    `SELECT ai_mode, ai_generation_id, ai_generation_started_at, ai_handoff_epoch
     FROM conversations WHERE id = ?`
  ).bind(convId).first<any>();
  if (!current || current.ai_mode !== 'ENABLED' || Number(current.ai_handoff_epoch) !== expectedEpoch) {
    return {
      success: false,
      reason: current?.ai_mode === 'ENABLED' ? 'HANDOFF' : 'PAUSED',
      handoffEpoch: expectedEpoch
    };
  }

  if (current.ai_generation_id && current.ai_generation_started_at >= leaseExpiryThreshold) {
    const expiresAt = Number(current.ai_generation_started_at) + config.generationLeaseSeconds;
    throw new RetryableProcessingError('AI generation lease is active', Math.max(expiresAt - now + 2, 2));
  }
  throw new RetryableProcessingError('AI generation lease claim was contended', 2);
}

export async function releaseGenerationLease(
  env: Env, 
  convId: string, 
  generationId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE conversations 
     SET ai_generation_id = NULL,
         ai_generation_started_at = NULL,
         ai_generation_message_id = NULL,
         updated_at = ?,
         version = version + 1
     WHERE id = ? AND ai_generation_id = ?`
  ).bind(now, convId, generationId).run();
}

export async function verifyGenerationLease(
  env: Env,
  convId: string,
  generationId: string
): Promise<boolean> {
  const conv = await env.DB.prepare(
    `SELECT ai_mode, ai_generation_id FROM conversations WHERE id = ?`
  ).bind(convId).first<Conversation>();
  
  if (!conv) return false;
  return conv.ai_mode === 'ENABLED' && conv.ai_generation_id === generationId;
}

export async function verifyHandoffEpoch(
  env: Env,
  convId: string,
  expectedEpoch: number
): Promise<boolean> {
  const conv = await env.DB.prepare(
    `SELECT ai_mode, ai_handoff_epoch FROM conversations WHERE id = ?`
  ).bind(convId).first<any>();
  
  if (!conv) return false;
  return conv.ai_mode === 'ENABLED' && conv.ai_handoff_epoch === expectedEpoch;
}

export async function getDurableAiRun(env: Env, triggerEventRef: string) {
  return await env.DB.prepare(
    `SELECT * FROM ai_runs WHERE trigger_event_ref = ?`
  ).bind(triggerEventRef).first<any>();
}

export async function saveDurableAiRun(
  env: Env,
  triggerEventRef: string,
  convId: string,
  triggerMessageRef: string,
  generationId: string,
  handoffEpoch: number,
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED_BY_HANDOFF' | 'DISCARDED_STALE',
  providerResponseRef?: string,
  responseText?: string,
  lastError?: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch, provider_response_ref, response_text, status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (trigger_event_ref) DO UPDATE 
     SET status = ?, provider_response_ref = ?, response_text = ?, last_error = ?, generation_id = ?, handoff_epoch = ?, updated_at = ?
     WHERE ai_runs.status NOT IN ('CANCELLED_BY_HANDOFF', 'DISCARDED_STALE')
       AND (excluded.status = 'PENDING' OR ai_runs.generation_id = excluded.generation_id)`
  ).bind(
    triggerEventRef, convId, triggerMessageRef, generationId, handoffEpoch, providerResponseRef || null, responseText || null, status, lastError || null, now, now,
    status, providerResponseRef || null, responseText || null, lastError || null, generationId, handoffEpoch, now
  ).run();
  return result.meta.changes === 1;
}

export async function saveGeneratedAiResult(
  env: Env,
  triggerEventRef: string,
  convId: string,
  generationId: string,
  handoffEpoch: number,
  providerResponseRef: string,
  responseText: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'SUCCESS', provider_response_ref = ?, response_text = ?, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND generation_id = ? AND status = 'PENDING'
       AND EXISTS (
         SELECT 1 FROM conversations
         WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ? AND ai_handoff_epoch = ?
       )`
  ).bind(
    providerResponseRef,
    responseText,
    Math.floor(Date.now() / 1000),
    triggerEventRef,
    generationId,
    convId,
    generationId,
    handoffEpoch
  ).run();
  return result.meta.changes === 1;
}
