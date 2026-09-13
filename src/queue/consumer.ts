import { SupportEvent } from '../core/events';
import { Env } from '../index';
import { processChatwootEvent } from './chatwoot-handler';
import { processTelegramEvent } from './telegram-handler';
import { processAiTrigger } from './ai-handler';
import { logger } from '../observability/logger';

export async function handleQueueEvent(event: SupportEvent, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const leaseUntil = now + 30; // 30s lease

  let inserted = false;
  try {
    await env.DB.prepare(
      `INSERT INTO event_receipts (source, source_event_ref, status, attempt_count, lease_until)
       VALUES (?, ?, 'PROCESSING', 1, ?)`
    ).bind(event.source, event.eventId, leaseUntil).run();
    inserted = true;
  } catch (e) {
    // Already exists
  }

  if (!inserted) {
    // Atomic reclaim of FAILED or expired PROCESSING
    const claimResult = await env.DB.prepare(
      `UPDATE event_receipts 
       SET status = 'PROCESSING', attempt_count = attempt_count + 1, lease_until = ?
       WHERE source = ? AND source_event_ref = ? 
       AND (status = 'FAILED' OR (status = 'PROCESSING' AND lease_until <= ?))`
    ).bind(leaseUntil, event.source, event.eventId, now).run();

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
      throw new Error('Event locked by another worker, retry later');
    }
  }

  const startTime = Date.now();
  try {
    if (event.source === 'chatwoot') {
      await processChatwootEvent(event, env);
    } else if (event.source === 'telegram') {
      await processTelegramEvent(event, env);
    } else if (event.source === 'internal' && event.type === 'ai_trigger') {
      await processAiTrigger(event, env);
    }
    
    await env.DB.prepare(
      `UPDATE event_receipts SET status = 'PROCESSED', processed_at = ? 
       WHERE source = ? AND source_event_ref = ?`
    ).bind(Math.floor(Date.now() / 1000), event.source, event.eventId).run();

    logger.info('Event processed successfully', { 
      source: event.source, 
      source_event_ref: event.eventId,
      duration_ms: Date.now() - startTime
    });

  } catch (error: any) {
    await env.DB.prepare(
      `UPDATE event_receipts SET status = 'FAILED', last_error = ? 
       WHERE source = ? AND source_event_ref = ?`
    ).bind(String(error), event.source, event.eventId).run();
    
    logger.error('Event processing failed', error, {
      source: event.source,
      source_event_ref: event.eventId,
      duration_ms: Date.now() - startTime
    });
    
    throw error;
  }
}
