import { Env } from '../config/env';
import { getAIConfig } from '../config/ai';
import { RetryableProcessingError, safeErrorCode } from '../core/errors';
import { SupportEvent } from '../core/events';
import { logger } from '../observability/logger';
import { processAiTrigger } from './ai-handler';
import { processChatwootEvent } from './chatwoot-handler';
import { processTelegramEvent } from './telegram-handler';

const NORMAL_EVENT_LEASE_SECONDS = 30;
const AI_EVENT_SAFETY_MARGIN_SECONDS = 15;

function eventLeaseSeconds(event: SupportEvent, env: Env): number {
  if (event.source === 'internal') {
    return getAIConfig(env).generationLeaseSeconds + AI_EVENT_SAFETY_MARGIN_SECONDS;
  }
  return NORMAL_EVENT_LEASE_SECONDS;
}

export async function handleQueueEvent(event: SupportEvent, env: Env): Promise<void> {
  if (event.version !== 1) {
    throw new Error('Unsupported queue event version');
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
      throw new RetryableProcessingError('Event receipt lease is active', retryAfter);
    }
  }

  const startTime = Date.now();
  try {
    if (event.source === 'chatwoot') {
      await processChatwootEvent(event, env);
    } else if (event.source === 'telegram') {
      await processTelegramEvent(event, env);
    } else {
      await processAiTrigger(event, env);
    }

    const processedResult = await env.DB.prepare(
      `UPDATE event_receipts SET status = 'PROCESSED', processed_at = ?, lease_until = NULL, claim_token = NULL
       WHERE source = ? AND source_event_ref = ? AND status = 'PROCESSING' AND claim_token = ?`
    ).bind(Math.floor(Date.now() / 1000), event.source, event.eventId, claimToken).run();
    if (processedResult.meta.changes !== 1) {
      throw new RetryableProcessingError('Event receipt ownership was lost before completion', leaseSeconds);
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
