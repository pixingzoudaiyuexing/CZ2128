import { Env } from '../index';
import { Conversation } from './domain';
import { logger } from '../observability/logger';
import { getAIConfig } from '../config/ai';

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
     WHERE id = ? AND ai_mode != 'PAUSED_MANUAL'` // Manual pause overrides operator pause
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
      // Attempt auto resume
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
