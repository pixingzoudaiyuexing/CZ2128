import { SupportEvent } from '../core/events';
import { Env } from '../index';
import { processChatwootEvent } from './chatwoot-handler';
import { processTelegramEvent } from './telegram-handler';

export async function handleQueueEvent(event: SupportEvent, env: Env): Promise<void> {
  // Check idempotency in D1
  const existing = await env.DB.prepare(
    'SELECT * FROM event_receipts WHERE source = ? AND source_event_ref = ?'
  ).bind(event.source, event.eventId).first();

  if (existing) {
    if (existing.status === 'PROCESSED') {
      return; // Already processed, duplicate delivery from queue
    }
    // If it's FAILED we could retry, but here we just update attempt_count
    await env.DB.prepare(
      'UPDATE event_receipts SET attempt_count = attempt_count + 1 WHERE source = ? AND source_event_ref = ?'
    ).bind(event.source, event.eventId).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO event_receipts (source, source_event_ref, status, attempt_count, processed_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(event.source, event.eventId, 'PROCESSING', 1, Math.floor(Date.now() / 1000)).run();
  }

  try {
    if (event.source === 'chatwoot') {
      await processChatwootEvent(event, env);
    } else if (event.source === 'telegram') {
      await processTelegramEvent(event, env);
    }
    
    await env.DB.prepare(
      'UPDATE event_receipts SET status = ?, processed_at = ? WHERE source = ? AND source_event_ref = ?'
    ).bind('PROCESSED', Math.floor(Date.now() / 1000), event.source, event.eventId).run();

  } catch (error: any) {
    await env.DB.prepare(
      'UPDATE event_receipts SET status = ?, last_error = ? WHERE source = ? AND source_event_ref = ?'
    ).bind('FAILED', String(error), event.source, event.eventId).run();
    throw error;
  }
}
