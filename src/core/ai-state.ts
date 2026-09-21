import { Env } from '../config/env';
import { AiRun, Conversation } from './domain';
import { logger } from '../observability/logger';
import { getAIConfig } from '../config/ai';
import { RetryableProcessingError } from './errors';
import { SafeErrorCode } from './error-taxonomy';
import { boundedQueueRetryDelay, RETRY_DELAY_FALLBACK_SECONDS } from './retry';

export const MAX_AI_GENERATION_ATTEMPTS = 3;

const RETRYABLE_AI_ERRORS = new Set<SafeErrorCode>([
  'AI_RATE_LIMITED',
  'AI_TIMEOUT',
  'AI_TRANSPORT_ERROR',
  'AI_PROVIDER_5XX',
  'AI_INVALID_RESPONSE'
]);

const FINAL_AI_ERRORS = new Set<SafeErrorCode>([
  'AI_PROVIDER_4XX',
  'AI_CONTEXT_INVALID'
]);

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

export type TelegramOperatorAction = 'HUMAN_REPLY' | 'AI_OFF' | 'AI_ON';
export type OrderedActionResult = 'APPLIED' | 'CURRENT' | 'STALE' | 'STALE_PROFILE';

export async function applyTelegramOperatorAction(
  env: Env,
  convId: string,
  supportProfileVersion: number,
  updateRef: string,
  action: TelegramOperatorAction
): Promise<OrderedActionResult> {
  const updateId = Number(updateRef);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error('Invalid Telegram operator update id');
  }
  if (!Number.isSafeInteger(supportProfileVersion) || supportProfileVersion < 0) {
    throw new Error('Invalid Telegram support profile version');
  }
  const now = Math.floor(Date.now() / 1000);
  if (action === 'HUMAN_REPLY') {
    const result = await env.DB.prepare(
      `UPDATE conversations
       SET ai_mode = CASE WHEN ai_mode = 'PAUSED_MANUAL' THEN ai_mode ELSE 'PAUSED_OPERATOR' END,
           last_operator_reply_at = ?,
           ai_generation_id = NULL,
           ai_generation_started_at = NULL,
           ai_generation_message_id = NULL,
           ai_handoff_epoch = ai_handoff_epoch + 1,
           last_telegram_operator_profile_version = ?,
           last_telegram_operator_update_id = ?,
           updated_at = ?,
           version = version + 1
       WHERE id = ?
         AND (
           COALESCE(last_telegram_operator_profile_version, 0) < ?
           OR (
             COALESCE(last_telegram_operator_profile_version, 0) = ?
             AND (last_telegram_operator_update_id IS NULL OR last_telegram_operator_update_id < ?)
           )
         )`
    ).bind(
      now, supportProfileVersion, updateId, now, convId,
      supportProfileVersion, supportProfileVersion, updateId
    ).run();
    if (result.meta.changes === 1) return 'APPLIED';
  } else {
    const setMode = action === 'AI_OFF'
      ? `SET ai_mode = 'PAUSED_MANUAL',
             ai_generation_id = NULL,
             ai_generation_started_at = NULL,
             ai_generation_message_id = NULL,
             ai_handoff_epoch = ai_handoff_epoch + 1,
             last_telegram_operator_profile_version = ?,
             last_telegram_operator_update_id = ?, updated_at = ?, version = version + 1`
      : `SET ai_mode = 'ENABLED',
           ai_generation_id = NULL,
           ai_generation_started_at = NULL,
           ai_generation_message_id = NULL,
             last_telegram_operator_profile_version = ?,
             last_telegram_operator_update_id = ?, updated_at = ?, version = version + 1`;
    const result = await env.DB.prepare(
      `UPDATE conversations ${setMode}
       WHERE id = ?
         AND (
           COALESCE(last_telegram_operator_profile_version, 0) < ?
           OR (
             COALESCE(last_telegram_operator_profile_version, 0) = ?
             AND (last_telegram_operator_update_id IS NULL OR last_telegram_operator_update_id < ?)
           )
         )`
    ).bind(
      supportProfileVersion, updateId, now, convId,
      supportProfileVersion, supportProfileVersion, updateId
    ).run();
    if (result.meta.changes === 1) return 'APPLIED';
  }

  const current = await env.DB.prepare(
    `SELECT last_telegram_operator_profile_version, last_telegram_operator_update_id
     FROM conversations WHERE id = ?`
  ).bind(convId).first<{
    last_telegram_operator_profile_version: number | null;
    last_telegram_operator_update_id: number | null;
  }>();
  if (!current) throw new Error('Conversation not found for Telegram operator action');
  const currentProfileVersion = Number(current.last_telegram_operator_profile_version || 0);
  if (currentProfileVersion > supportProfileVersion) return 'STALE_PROFILE';
  return Number(current.last_telegram_operator_update_id) === updateId ? 'CURRENT' : 'STALE';
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
    throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', Math.max(delaySeconds, 2));
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
    throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', Math.max(expiresAt - now + 2, 2));
  }
  throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 2);
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

export async function getDurableAiRun(env: Env, triggerEventRef: string): Promise<AiRun | null> {
  return await env.DB.prepare(
    `SELECT * FROM ai_runs WHERE trigger_event_ref = ?`
  ).bind(triggerEventRef).first<AiRun>();
}

export async function normalizeLegacyAiRun(
  env: Env,
  run: AiRun
): Promise<AiRun> {
  if (run.status !== 'FAILED') return run;
  const now = Math.floor(Date.now() / 1000);
  const attemptCount = Math.max(Number(run.attempt_count) || 0, 1);
  const legacyError = run.last_error;
  const retryable = RETRYABLE_AI_ERRORS.has(legacyError as SafeErrorCode);
  const final = FINAL_AI_ERRORS.has(legacyError as SafeErrorCode);
  const status = retryable
    ? attemptCount >= MAX_AI_GENERATION_ATTEMPTS ? 'RETRY_EXHAUSTED' : 'FAILED_RETRYABLE'
    : 'FAILED_FINAL';
  const nextRetryAt = status === 'FAILED_RETRYABLE'
    ? Number.isSafeInteger(run.next_retry_at) && Number(run.next_retry_at) > 0
      ? Number(run.next_retry_at)
      : now + RETRY_DELAY_FALLBACK_SECONDS
    : null;
  const lastError = status === 'RETRY_EXHAUSTED'
    ? 'AI_RETRY_EXHAUSTED'
    : retryable || final
      ? legacyError
      : 'AI_LEGACY_FAILURE_UNCLASSIFIED';

  await env.DB.prepare(
    `UPDATE ai_runs
     SET status = ?, attempt_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
     WHERE trigger_event_ref = ? AND status = 'FAILED'`
  ).bind(
    status,
    attemptCount,
    nextRetryAt,
    lastError,
    now,
    run.trigger_event_ref
  ).run();
  return (await getDurableAiRun(env, run.trigger_event_ref)) || run;
}

export async function ensureAiRunProviderResponseRef(env: Env, run: AiRun): Promise<AiRun> {
  if (run.status !== 'SUCCESS' || run.response_text === null || run.provider_response_ref) return run;
  const fallbackRef = `ai_res_${run.trigger_event_ref}`;
  await env.DB.prepare(
    `UPDATE ai_runs SET provider_response_ref = ?, updated_at = ?
     WHERE trigger_event_ref = ? AND status = 'SUCCESS' AND response_text IS NOT NULL
       AND provider_response_ref IS NULL`
  ).bind(fallbackRef, Math.floor(Date.now() / 1000), run.trigger_event_ref).run();
  return (await getDurableAiRun(env, run.trigger_event_ref)) || run;
}

export async function cancelDurableAiRunForHandoff(
  env: Env,
  triggerEventRef: string,
  convId: string,
  triggerMessageRef: string,
  handoffEpoch: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `INSERT INTO ai_runs
     (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
      provider_response_ref, response_text, status, attempt_count, next_retry_at, last_error,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'CANCELLED_BY_HANDOFF', 0, NULL, NULL, ?, ?)
     ON CONFLICT (trigger_event_ref) DO UPDATE
     SET status = 'CANCELLED_BY_HANDOFF', next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE ai_runs.conversation_id = excluded.conversation_id
       AND ai_runs.trigger_message_ref = excluded.trigger_message_ref
       AND ai_runs.status IN ('PENDING', 'FAILED_RETRYABLE')`
  ).bind(
    triggerEventRef,
    convId,
    triggerMessageRef,
    `cancelled:${triggerEventRef}`,
    handoffEpoch,
    now,
    now,
    now
  ).run();
  return result.meta.changes === 1;
}

export async function cancelDurableAiRunForScope(
  env: Env,
  triggerEventRef: string,
  convId: string,
  triggerMessageRef: string
): Promise<boolean> {
  const current = await getDurableAiRun(env, triggerEventRef);
  if (
    !current ||
    current.conversation_id !== convId ||
    current.trigger_message_ref !== triggerMessageRef ||
    (current.status !== 'PENDING' && current.status !== 'FAILED_RETRYABLE')
  ) return false;

  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'FAILED_FINAL', next_retry_at = NULL,
         last_error = 'AI_SCOPE_DENIED', updated_at = ?
     WHERE trigger_event_ref = ? AND conversation_id = ? AND trigger_message_ref = ?
       AND status = ? AND generation_id IS ? AND handoff_epoch = ? AND attempt_count = ?`
  ).bind(
    Math.floor(Date.now() / 1000),
    triggerEventRef,
    convId,
    triggerMessageRef,
    current.status,
    current.generation_id,
    current.handoff_epoch,
    current.attempt_count
  ).run();
  if (result.meta.changes !== 1) return false;
  if (current.generation_id) {
    await releaseGenerationLease(env, convId, current.generation_id);
  }
  return true;
}

export async function claimDurableAiRun(
  env: Env,
  triggerEventRef: string,
  convId: string,
  triggerMessageRef: string,
  generationId: string,
  handoffEpoch: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiryThreshold = now - getAIConfig(env).generationLeaseSeconds;
  const result = await env.DB.prepare(
    `INSERT INTO ai_runs
     (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
      provider_response_ref, response_text, status, attempt_count, next_retry_at, last_error,
      created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, NULL, NULL, 'PENDING', 0, NULL, NULL, ?, ?
     FROM conversations
     WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ?
       AND ai_handoff_epoch = ? AND ai_generation_started_at >= ?
     ON CONFLICT (trigger_event_ref) DO UPDATE
     SET generation_id = excluded.generation_id, handoff_epoch = excluded.handoff_epoch,
         provider_response_ref = NULL, response_text = NULL, status = 'PENDING',
         next_retry_at = NULL, last_error = NULL, updated_at = excluded.updated_at
     WHERE ai_runs.conversation_id = excluded.conversation_id
       AND ai_runs.trigger_message_ref = excluded.trigger_message_ref
       AND ai_runs.handoff_epoch = excluded.handoff_epoch
       AND ai_runs.attempt_count < ?
       AND (
         ai_runs.status = 'PENDING'
         OR (ai_runs.status = 'FAILED_RETRYABLE' AND ai_runs.next_retry_at <= ?)
       )
       AND EXISTS (
         SELECT 1 FROM conversations
         WHERE id = excluded.conversation_id AND ai_mode = 'ENABLED'
           AND ai_generation_id = excluded.generation_id
           AND ai_handoff_epoch = excluded.handoff_epoch
           AND ai_generation_started_at >= ?
       )`
  ).bind(
    triggerEventRef,
    convId,
    triggerMessageRef,
    generationId,
    handoffEpoch,
    now,
    now,
    convId,
    generationId,
    handoffEpoch,
    leaseExpiryThreshold,
    MAX_AI_GENERATION_ATTEMPTS,
    now,
    leaseExpiryThreshold
  ).run();
  return result.meta.changes === 1;
}

export async function startAiGenerationAttempt(
  env: Env,
  triggerEventRef: string,
  convId: string,
  generationId: string,
  handoffEpoch: number
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiryThreshold = now - getAIConfig(env).generationLeaseSeconds;
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND conversation_id = ? AND generation_id = ?
       AND handoff_epoch = ? AND status = 'PENDING' AND attempt_count < ?
       AND EXISTS (
         SELECT 1 FROM conversations
         WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ?
           AND ai_handoff_epoch = ? AND ai_generation_started_at >= ?
       )`
  ).bind(
    now,
    triggerEventRef,
    convId,
    generationId,
    handoffEpoch,
    MAX_AI_GENERATION_ATTEMPTS,
    convId,
    generationId,
    handoffEpoch,
    leaseExpiryThreshold
  ).run();
  if (result.meta.changes !== 1) return null;
  const current = await getDurableAiRun(env, triggerEventRef);
  return current?.generation_id === generationId ? current.attempt_count : null;
}

export async function saveAiGenerationFailure(
  env: Env,
  triggerEventRef: string,
  convId: string,
  generationId: string,
  handoffEpoch: number,
  error: SafeErrorCode,
  retryable: boolean,
  retryAfterSeconds?: number
): Promise<AiRun | null> {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiryThreshold = now - getAIConfig(env).generationLeaseSeconds;
  const retryDelay = boundedQueueRetryDelay(retryAfterSeconds, RETRY_DELAY_FALLBACK_SECONDS);
  const result = retryable
    ? await env.DB.prepare(
      `UPDATE ai_runs
       SET status = CASE WHEN attempt_count >= ? THEN 'RETRY_EXHAUSTED' ELSE 'FAILED_RETRYABLE' END,
           next_retry_at = CASE WHEN attempt_count >= ? THEN NULL ELSE ? END,
           last_error = CASE WHEN attempt_count >= ? THEN 'AI_RETRY_EXHAUSTED' ELSE ? END,
           updated_at = ?
       WHERE trigger_event_ref = ? AND generation_id = ? AND handoff_epoch = ? AND status = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM conversations
           WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ?
             AND ai_handoff_epoch = ? AND ai_generation_started_at >= ?
         )`
    ).bind(
      MAX_AI_GENERATION_ATTEMPTS,
      MAX_AI_GENERATION_ATTEMPTS,
      now + retryDelay,
      MAX_AI_GENERATION_ATTEMPTS,
      error,
      now,
      triggerEventRef,
      generationId,
      handoffEpoch,
      convId,
      generationId,
      handoffEpoch,
      leaseExpiryThreshold
    ).run()
    : await env.DB.prepare(
      `UPDATE ai_runs
       SET status = 'FAILED_FINAL', next_retry_at = NULL, last_error = ?, updated_at = ?
       WHERE trigger_event_ref = ? AND generation_id = ? AND handoff_epoch = ? AND status = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM conversations
           WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ?
             AND ai_handoff_epoch = ? AND ai_generation_started_at >= ?
         )`
    ).bind(
      error, now, triggerEventRef, generationId, handoffEpoch,
      convId, generationId, handoffEpoch, leaseExpiryThreshold
    ).run();
  if (result.meta.changes !== 1) return null;
  return getDurableAiRun(env, triggerEventRef);
}

export async function exhaustAiRunWithoutAttempt(
  env: Env,
  triggerEventRef: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'RETRY_EXHAUSTED', next_retry_at = NULL,
         last_error = 'AI_RETRY_EXHAUSTED', updated_at = ?
     WHERE trigger_event_ref = ? AND attempt_count >= ?
       AND status IN ('PENDING', 'FAILED_RETRYABLE')`
  ).bind(
    Math.floor(Date.now() / 1000),
    triggerEventRef,
    MAX_AI_GENERATION_ATTEMPTS
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
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiryThreshold = now - getAIConfig(env).generationLeaseSeconds;
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'SUCCESS', provider_response_ref = ?, response_text = ?,
         next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND generation_id = ? AND handoff_epoch = ? AND status = 'PENDING'
       AND EXISTS (
         SELECT 1 FROM conversations
         WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ?
           AND ai_handoff_epoch = ? AND ai_generation_started_at >= ?
       )`
  ).bind(
    providerResponseRef,
    responseText,
    now,
    triggerEventRef,
    generationId,
    handoffEpoch,
    convId,
    generationId,
    handoffEpoch,
    leaseExpiryThreshold
  ).run();
  return result.meta.changes === 1;
}

export async function saveGeneratedAiResultForLatestTrigger(
  env: Env,
  triggerEventRef: string,
  convId: string,
  triggerMessageRef: string,
  generationId: string,
  handoffEpoch: number,
  providerResponseRef: string,
  responseText: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiryThreshold = now - getAIConfig(env).generationLeaseSeconds;
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'SUCCESS', provider_response_ref = ?, response_text = ?,
         next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND generation_id = ? AND handoff_epoch = ? AND status = 'PENDING'
       AND EXISTS (
         SELECT 1 FROM conversations
         WHERE id = ? AND ai_mode = 'ENABLED' AND ai_generation_id = ?
           AND ai_handoff_epoch = ? AND ai_generation_started_at >= ?
       )
       AND EXISTS (
         SELECT 1 FROM messages AS target
         WHERE target.conversation_id = ? AND target.provider = 'chatwoot'
           AND target.provider_message_ref = ? AND target.direction = 'INBOUND'
           AND target.actor_role = 'CUSTOMER' AND target.message_type = 'TEXT'
           AND target.text_content IS NOT NULL
           AND target.rowid = (
             SELECT rowid FROM messages
             WHERE conversation_id = ? AND actor_role = 'CUSTOMER'
               AND message_type = 'TEXT' AND text_content IS NOT NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1
           )
       )`
  ).bind(
    providerResponseRef,
    responseText,
    now,
    triggerEventRef,
    generationId,
    handoffEpoch,
    convId,
    generationId,
    handoffEpoch,
    leaseExpiryThreshold,
    convId,
    triggerMessageRef,
    convId
  ).run();
  return result.meta.changes === 1;
}

export async function isLatestCustomerTextMessage(
  env: Pick<Env, 'DB'>,
  convId: string,
  triggerMessageRef: string
): Promise<boolean> {
  const latest = await env.DB.prepare(
    `SELECT provider, provider_message_ref, direction
     FROM messages
     WHERE conversation_id = ? AND actor_role = 'CUSTOMER'
       AND message_type = 'TEXT' AND text_content IS NOT NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(convId).first<{
    provider: string;
    provider_message_ref: string | null;
    direction: string;
  }>();
  return latest?.provider === 'chatwoot' &&
    latest.provider_message_ref === triggerMessageRef &&
    latest.direction === 'INBOUND';
}

export async function discardRetryableAiRunAsStale(
  env: Pick<Env, 'DB'>,
  triggerEventRef: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'DISCARDED_STALE', next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND status = 'FAILED_RETRYABLE'`
  ).bind(Math.floor(Date.now() / 1000), triggerEventRef).run();
  return result.meta.changes === 1;
}

export async function cancelOwnedAiRunAfterHandoff(
  env: Env,
  triggerEventRef: string,
  generationId: string | null
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'CANCELLED_BY_HANDOFF', next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND generation_id IS ? AND status IN ('PENDING', 'SUCCESS')`
  ).bind(Math.floor(Date.now() / 1000), triggerEventRef, generationId).run();
  return result.meta.changes === 1;
}

export async function discardOwnedStaleAiRun(
  env: Env,
  triggerEventRef: string,
  generationId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE ai_runs
     SET status = 'DISCARDED_STALE', next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE trigger_event_ref = ? AND generation_id = ? AND status = 'PENDING'`
  ).bind(Math.floor(Date.now() / 1000), triggerEventRef, generationId).run();
  return result.meta.changes === 1;
}

export function aiRunRetryDelay(run: AiRun, now = Math.floor(Date.now() / 1000)): number | null {
  if (run.status !== 'FAILED_RETRYABLE') return null;
  if (!Number.isSafeInteger(run.next_retry_at) || Number(run.next_retry_at) <= now) return null;
  return Math.max(Number(run.next_retry_at) - now, 1);
}

export function isAiRunTerminal(status: AiRun['status']): boolean {
  return [
    'SUCCESS',
    'RETRY_EXHAUSTED',
    'FAILED_FINAL',
    'CANCELLED_BY_HANDOFF',
    'DISCARDED_STALE'
  ].includes(status);
}
