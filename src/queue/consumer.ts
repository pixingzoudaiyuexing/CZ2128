import { SupportEvent } from '../core/events';
import { Env } from '../config/env';
import { processChatwootEvent } from './chatwoot-handler';
import { processTelegramEvent } from './telegram-handler';
import { logger } from '../observability/logger';
import { RetryableProcessingError, safeErrorCode } from '../core/errors';

export async function handleQueueEvent(event: SupportEvent, env: Env): Promise<void> {
  if (event.version !== 1) {
    throw new Error('Unsupported queue event version');
  }

  const now = Math.floor(Date.now() / 1000);
  const leaseUntil = now + 30; // 30s lease
  const claimToken = crypto.randomUUID();

  const insertResult = await env.DB.prepare(
    `INSERT INTO event_receipts (source, source_event_ref, status, attempt_count, lease_until, claim_token)
     VALUES (?, ?, 'PROCESSING', 1, ?, ?)
     ON CONFLICT (source, source_event_ref) DO NOTHING`
  ).bind(event.source, event.eventId, leaseUntil, claimToken).run();
  const inserted = insertResult.meta.changes === 1;

  if (!inserted) {
    // Atomic reclaim of FAILED or expired PROCESSING
    const claimResult = await env.DB.prepare(
      `UPDATE event_receipts 
       SET status = 'PROCESSING', attempt_count = attempt_count + 1, lease_until = ?, claim_token = ?
       WHERE source = ? AND source_event_ref = ? 
       AND (status = 'FAILED' OR (status = 'PROCESSING' AND lease_until <= ?))`
    ).bind(leaseUntil, claimToken, event.source, event.eventId, now).run();

    if (claimResult.meta.changes === 0) {
      // Check if it's already processed or held by someone else
      const receipt = await env.DB.prepare(
        'SELECT status FROM event_receipts WHERE source = ? AND source_event_ref = ?'
      ).bind(event.source, event.eventId).first<any>();

      if (receipt?.status === 'PROCESSED') {
        logger.info('Duplicate queue event, already processed', { source: event.source, source_event_ref: event.eventId });
        return;
      }
      
      logger.info('Event claim held by another worker', { source: event.source, source_event_ref: event.eventId });
      throw new RetryableProcessingError('Event receipt lease is active', 30);
    }
  }

  const startTime = Date.now();
  try {
    if (event.source === 'chatwoot') {
      await processChatwootEvent(event, env);
    } else {
      await processTelegramEvent(event, env);
    }
    
    const processedResult = await env.DB.prepare(
      `UPDATE event_receipts SET status = 'PROCESSED', processed_at = ?, lease_until = NULL, claim_token = NULL
       WHERE source = ? AND source_event_ref = ? AND status = 'PROCESSING' AND claim_token = ?`
    ).bind(Math.floor(Date.now() / 1000), event.source, event.eventId, claimToken).run();
    if (processedResult.meta.changes !== 1) {
      throw new RetryableProcessingError('Event receipt ownership was lost before completion', 30);
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
