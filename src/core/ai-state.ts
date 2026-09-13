import { Env } from '../index';
import { Conversation } from './domain';
import { logger } from '../observability/logger';
import { getAIConfig } from '../config/ai';
import { RetryLaterError } from './events';

export async function pauseOperator(env: Env, convId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE conversations 
     SET ai_mode = 'PAUSED_OPERATOR', 
         last_operator_reply_at = ?,
         ai_generation_id = NULL,
         ai_generation_started_at = NULL,
         ai_generation_message_id = NULL,
         updated_at = ?,
         version = version + 1
     WHERE id = ? AND ai_mode != 'PAUSED_MANUAL'`
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
): Promise<{ success: boolean; generationId?: string }> {
  const config = getAIConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const generationId = crypto.randomUUID();
  const leaseExpiryThreshold = now - config.generationLeaseSeconds;

  // Before acquiring, check if we're locked so we can calculate retry delay
  const conv = await env.DB.prepare(
    `SELECT ai_generation_id, ai_generation_started_at 
     FROM conversations 
     WHERE id = ? AND ai_mode = 'ENABLED'`
  ).bind(convId).first<Conversation>();

  if (!conv) {
    return { success: false }; // Not ENABLED or conversation doesn't exist
  }

  if (conv.ai_generation_id && conv.ai_generation_started_at && conv.ai_generation_started_at >= leaseExpiryThreshold) {
    // Locked by active generation. Calculate delay.
    const expiresAt = conv.ai_generation_started_at + config.generationLeaseSeconds;
    const delaySeconds = expiresAt - now + 2; // 2 seconds safety margin
    throw new RetryLaterError('AI Generation Lease locked', Math.max(delaySeconds, 2));
  }

  const claim = await env.DB.prepare(
    `UPDATE conversations 
     SET ai_generation_id = ?,
         ai_generation_started_at = ?,
         ai_generation_message_id = ?,
         updated_at = ?,
         version = version + 1
     WHERE id = ? 
       AND ai_mode = 'ENABLED'
       AND (ai_generation_id IS NULL OR ai_generation_started_at < ?)`
  ).bind(generationId, now, messageId, now, convId, leaseExpiryThreshold).run();

  if (claim.meta.changes === 1) {
    return { success: true, generationId };
  }
  return { success: false };
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
  status: string,
  providerResponseRef?: string,
  responseText?: string,
  lastError?: string
) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, provider_response_ref, response_text, status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (trigger_event_ref) DO UPDATE 
     SET status = ?, provider_response_ref = ?, response_text = ?, last_error = ?, updated_at = ?`
  ).bind(
    triggerEventRef, convId, triggerMessageRef, generationId, providerResponseRef || null, responseText || null, status, lastError || null, now, now,
    status, providerResponseRef || null, responseText || null, lastError || null, now
  ).run();
}
