import { Env } from '../index';
import { SupportEvent, RetryLaterError } from '../core/events';
import { logger } from '../observability/logger';
import { getAIConfig } from '../config/ai';
import { processChatwootEvent } from './chatwoot-handler';
import { processTelegramEvent } from './telegram-handler';
import { processAiTrigger } from './ai-handler';

export async function handleQueueEvent(event: SupportEvent, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  // Dynamic lease calculation
  let leaseDuration = 30;
  if (event.source === 'internal' && event.type === 'ai_trigger') {
    const aiConfig = getAIConfig(env);
    // aiEventLeaseSeconds >= generationLeaseSeconds + deliveryMargin
    leaseDuration = aiConfig.generationLeaseSeconds + 15;
  }
  
  const leaseUntil = now + leaseDuration;

  try {
    const claim = await env.DB.prepare(
      `INSERT INTO event_receipts (source, source_event_ref, status, attempt_count, lease_until)
       VALUES (?, ?, 'PROCESSING', 1, ?)
       ON CONFLICT (source, source_event_ref) DO UPDATE 
       SET status = 'PROCESSING',
           attempt_count = attempt_count + 1,
           lease_until = ?
       WHERE status = 'FAILED' OR (status = 'PROCESSING' AND lease_until <= ?)`
    ).bind(event.source, event.eventId, leaseUntil, leaseUntil, now).run();

    if (claim.meta.changes === 0) {
      logger.info('Event claim held by another worker', { source: event.source, source_event_ref: event.eventId });
      return; 
    }
  } catch (error: any) {
    if (error.message && error.message.includes('UNIQUE')) {
      logger.info('Event claim held by another worker', { source: event.source, source_event_ref: event.eventId });
      return; 
    }
    throw error;
  }

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
    ).bind(now, event.source, event.eventId).run();
    
    logger.info('Event processed successfully', { source: event.source, source_event_ref: event.eventId, duration_ms: Date.now() - (now * 1000) });
  } catch (error: any) {
    await env.DB.prepare(
      `UPDATE event_receipts SET status = 'FAILED', last_error = ? 
       WHERE source = ? AND source_event_ref = ?`
    ).bind(String(error), event.source, event.eventId).run();
    
    logger.error('Event processing failed', error, { source: event.source, source_event_ref: event.eventId, duration_ms: Date.now() - (now * 1000) });
    
    throw error; 
  }
}
