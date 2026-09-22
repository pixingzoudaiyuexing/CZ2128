import { Env } from '../config/env';
import { getAIConfig } from '../config/ai';
import { RetryableProcessingError, SafeError, safeErrorCode } from '../core/errors';
import { SupportEvent } from '../core/events';
import { logger } from '../observability/logger';
import { processAiTrigger } from './ai-handler';
import { processChatwootEvent } from './chatwoot-handler';
import { processCrispEvent } from './crisp-handler';
import { processTelegramEvent } from './telegram-handler';
import { getAttachmentConfig } from '../config/attachments';
import { processAttachmentTransfer } from '../attachments/handler';

const NORMAL_EVENT_LEASE_SECONDS = 30;
const AI_EVENT_SAFETY_MARGIN_SECONDS = 15;

export function eventLeaseSeconds(event: SupportEvent, env: Env): number {
  if (event.type === 'attachment_transfer') {
    return getAttachmentConfig(env).eventLeaseSeconds;
  }
  if (event.type === 'ai_trigger') {
    return getAIConfig(env).generationLeaseSeconds + AI_EVENT_SAFETY_MARGIN_SECONDS;
  }
  return NORMAL_EVENT_LEASE_SECONDS;
}

export async function completeEventReceipt(
  env: Pick<Env, 'DB'>,
  event: Pick<SupportEvent, 'source' | 'eventId'>,
  claimToken: string,
  processedAt: number
): Promise<boolean> {
  const [processedResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE event_receipts SET status = 'PROCESSED', processed_at = ?, lease_until = NULL, claim_token = NULL
       WHERE source = ? AND source_event_ref = ? AND status = 'PROCESSING' AND claim_token = ?`
    ).bind(processedAt, event.source, event.eventId, claimToken),
    env.DB.prepare(
      `UPDATE dlq_receipts
       SET status = 'RESOLVED', resolved_at = COALESCE(resolved_at, ?)
       WHERE event_source = ? AND source_event_ref = ? AND status = 'OPEN'
         AND EXISTS (
           SELECT 1 FROM event_receipts
           WHERE source = ? AND source_event_ref = ? AND status = 'PROCESSED'
         )`
    ).bind(processedAt, event.source, event.eventId, event.source, event.eventId)
  ]);
  return processedResult.meta.changes === 1;
}

export async function handleQueueEvent(event: SupportEvent, env: Env): Promise<void> {
  if (event.version !== 1) {
    throw new SafeError('QUEUE_EVENT_VERSION_UNSUPPORTED');
  }
  if (env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG) {
    throw new RetryableProcessingError('RUNTIME_CONFIG_READ_FAILED', 5);
  }
  if (event.source === 'telegram') {
    const eventProfileVersion = event.payload.supportProfileVersion ?? 0;
    if (!Number.isSafeInteger(eventProfileVersion) || eventProfileVersion < 0) {
      throw new SafeError('INGRESS_PAYLOAD_INVALID', { provider: 'TELEGRAM' });
    }
    const currentProfileVersion = env.runtimeConfigSnapshot?.versions.TELEGRAM_SUPPORT_PROFILE ?? 0;
    if (eventProfileVersion < currentProfileVersion) {
      logger.info('Dropping event from stale Telegram support profile', {
        source: event.source,
        source_event_ref: event.eventId,
        error_category: 'STALE_TELEGRAM_SUPPORT_PROFILE',
        error_code: 'SUPPORT_PROFILE_STALE',
        provider: 'TELEGRAM',
        stage: 'VALIDATE'
      });
      return;
    }
    if (eventProfileVersion > currentProfileVersion) {
      throw new RetryableProcessingError('SUPPORT_PROFILE_FUTURE', 5, { provider: 'TELEGRAM' });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const leaseSeconds = eventLeaseSeconds(event, env);
  const leaseUntil = now + leaseSeconds;
  const claimToken = crypto.randomUUID();

  const insertResult = await env.DB.prepare(
    `INSERT INTO event_receipts (source, source_event_ref, status, attempt_count, lease_until, claim_token)
     VALUES (?, ?, 'PROCESSING', 1, ?, ?)
     ON CONFLICT (source, source_event_ref) DO NOTHING`
  ).bind(event.source, event.eventId, leaseUntil, claimToken).run();
  const inserted = insertResult.meta.changes === 1;

  if (!inserted) {
    const claimResult = await env.DB.prepare(
      `UPDATE event_receipts
       SET status = 'PROCESSING', attempt_count = attempt_count + 1, lease_until = ?, claim_token = ?
       WHERE source = ? AND source_event_ref = ?
       AND (status = 'FAILED' OR (status = 'PROCESSING' AND lease_until <= ?))`
    ).bind(leaseUntil, claimToken, event.source, event.eventId, now).run();

    if (claimResult.meta.changes === 0) {
      const receipt = await env.DB.prepare(
        'SELECT status, lease_until FROM event_receipts WHERE source = ? AND source_event_ref = ?'
      ).bind(event.source, event.eventId).first<{ status: string; lease_until: number | null }>();

      if (receipt?.status === 'PROCESSED') {
        logger.info('Duplicate queue event, already processed', { source: event.source, source_event_ref: event.eventId });
        return;
      }

      const retryAfter = receipt?.lease_until && receipt.lease_until > now
        ? receipt.lease_until - now
        : leaseSeconds;
      logger.info('Event claim held by another worker', { source: event.source, source_event_ref: event.eventId });
      throw new RetryableProcessingError('QUEUE_EVENT_CLAIM_CONTENDED', retryAfter);
    }
  }

  const startTime = Date.now();
  try {
    if (event.source === 'chatwoot') {
      await processChatwootEvent(event, env);
    } else if (event.source === 'crisp') {
      await processCrispEvent(event, env);
    } else if (event.source === 'telegram') {
      await processTelegramEvent(event, env);
    } else if (event.type === 'ai_trigger') {
      await processAiTrigger(event, env);
    } else {
      await processAttachmentTransfer(event, env);
    }

    const completed = await completeEventReceipt(
      env,
      event,
      claimToken,
      Math.floor(Date.now() / 1000)
    );
    if (!completed) {
      throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', leaseSeconds);
    }

    logger.info('Event processed successfully', {
      source: event.source,
      source_event_ref: event.eventId,
      duration_ms: Date.now() - startTime
    });
  } catch (error: unknown) {
    await env.DB.prepare(
      `UPDATE event_receipts SET status = 'FAILED', last_error = ?, lease_until = NULL, claim_token = NULL
       WHERE source = ? AND source_event_ref = ? AND status = 'PROCESSING' AND claim_token = ?`
    ).bind(safeErrorCode(error), event.source, event.eventId, claimToken).run();

    logger.error('Event processing failed', error, {
      source: event.source,
      source_event_ref: event.eventId,
      duration_ms: Date.now() - startTime
    });
    throw error;
  }
}
