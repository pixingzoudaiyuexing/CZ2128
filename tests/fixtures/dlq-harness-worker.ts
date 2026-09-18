import { completeEventReceipt } from '../../src/queue/consumer';
import { captureDlqMessage } from '../../src/queue/dlq-consumer';
import { listDlqQuarantine, persistDlqQuarantine } from '../../src/queue/dlq-quarantine';

interface HarnessEnv {
  DB: D1Database;
  DLQ_QUARANTINE: R2Bucket;
}

interface HarnessRequest {
  id?: string;
  body?: unknown;
  now?: number;
  attempts?: number;
  timestamp?: number;
  source?: 'chatwoot' | 'telegram' | 'internal';
  eventId?: string;
  status?: 'PROCESSING' | 'PROCESSED' | 'FAILED';
  claimToken?: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function payload(request: Request): Promise<HarnessRequest> {
  return request.method === 'POST' ? request.json<HarnessRequest>() : {};
}

async function reset(env: HarnessEnv): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dlq_receipts'),
    env.DB.prepare('DELETE FROM event_receipts'),
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM outbound_operations'),
    env.DB.prepare('DELETE FROM conversations')
  ]);
  let cursor: string | undefined;
  do {
    const objects = await env.DLQ_QUARANTINE.list({ prefix: 'terminal-dlq/v1/', cursor });
    if (objects.objects.length > 0) {
      await env.DLQ_QUARANTINE.delete(objects.objects.map(object => object.key));
    }
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
}

async function snapshot(env: HarnessEnv): Promise<unknown> {
  const dlq = await env.DB.prepare('SELECT * FROM dlq_receipts ORDER BY id').all();
  const events = await env.DB.prepare(
    'SELECT * FROM event_receipts ORDER BY source, source_event_ref'
  ).all();
  const quarantine = await listDlqQuarantine(env.DLQ_QUARANTINE, 10);
  const objects = await env.DLQ_QUARANTINE.list({ prefix: 'terminal-dlq/v1/' });
  const bodies = [];
  for (const object of objects.objects) {
    const stored = await env.DLQ_QUARANTINE.get(object.key);
    bodies.push(stored ? await stored.text() : null);
  }
  return { dlq: dlq.results, events: events.results, quarantine, quarantineBodies: bodies };
}

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health') return json({ ok: true });
    if (path === '/reset') {
      await reset(env);
      return json({ ok: true });
    }
    if (path === '/snapshot') return json(await snapshot(env));

    const input = await payload(request);
    if (path === '/seed-conversation') {
      await env.DB.prepare(
        `INSERT INTO conversations
         (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
          operator_channel, created_at, updated_at, version)
         VALUES ('conv-1', 'chatwoot', 'account-1', 'conversation-1', 'customer-1', 'telegram', 1, 1, 1)`
      ).run();
      return json({ ok: true });
    }
    if (path === '/seed-event') {
      await env.DB.prepare(
        `INSERT INTO event_receipts
         (source, source_event_ref, status, attempt_count, lease_until, claim_token, processed_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      ).bind(
        input.source || 'chatwoot',
        input.eventId,
        input.status,
        input.status === 'PROCESSING' ? 9999999999 : null,
        input.claimToken || null,
        input.status === 'PROCESSED' ? input.now || 1 : null
      ).run();
      return json({ ok: true });
    }
    if (path === '/capture') {
      const captured = await captureDlqMessage({ DB: env.DB }, {
        id: input.id || '',
        body: input.body,
        attempts: input.attempts,
        timestamp: input.timestamp === undefined ? undefined : new Date(input.timestamp * 1000)
      }, input.now);
      return json(captured);
    }
    if (path === '/complete') {
      const completed = await completeEventReceipt(
        { DB: env.DB },
        { source: input.source || 'chatwoot', eventId: input.eventId || '' },
        input.claimToken || '',
        input.now || 1
      );
      return json({ completed });
    }
    if (path === '/quarantine') {
      const quarantined = await persistDlqQuarantine(env.DLQ_QUARANTINE, {
        id: input.id || '',
        body: input.body,
        attempts: input.attempts,
        timestamp: input.timestamp === undefined ? undefined : new Date(input.timestamp * 1000)
      });
      return json(quarantined);
    }
    return json({ error: 'NOT_FOUND' }, 404);
  }
};
