import { completeEventReceipt, handleQueueEvent } from '../../src/queue/consumer';
import { captureDlqMessage } from '../../src/queue/dlq-consumer';
import { listDlqQuarantine, persistDlqQuarantine } from '../../src/queue/dlq-quarantine';
import {
  convergeStaleAiOutboundOperations,
  getDlqAiRedriveEligibility,
  requestDlqAiRedrive
} from '../../src/core/dlq-ai-redrive';
import { SupportEvent } from '../../src/core/events';
import {
  buildChatwootTargetEvidence,
  buildTelegramTargetEvidence
} from '../../src/core/outbound-evidence';
import { prepareOutboundOperation } from '../../src/core/outbound-operations';
import { safeErrorCode } from '../../src/core/errors';

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
  commandId?: string;
  chatwootApiUrl?: string;
}

const redriveQueueBodies: SupportEvent[] = [];
const redriveReceiptId = 'dlq:v1:workerd-ai-redrive';
const redriveConversationId = 'conv-redrive';
const redriveMessageId = 'message-redrive';
const redriveEventId = `ai_trigger:${redriveConversationId}:${redriveMessageId}`;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function payload(request: Request): Promise<HarnessRequest> {
  return request.method === 'POST' ? request.json<HarnessRequest>() : {};
}

async function reset(env: HarnessEnv): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reliability_audit'),
    env.DB.prepare('DELETE FROM dlq_receipts'),
    env.DB.prepare('DELETE FROM event_receipts'),
    env.DB.prepare('DELETE FROM ai_runs'),
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM outbound_operations'),
    env.DB.prepare('DELETE FROM conversations')
  ]);
  redriveQueueBodies.length = 0;
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
  const audits = await env.DB.prepare('SELECT * FROM reliability_audit ORDER BY id').all();
  const runs = await env.DB.prepare('SELECT * FROM ai_runs ORDER BY trigger_event_ref').all();
  const outbound = await env.DB.prepare('SELECT * FROM outbound_operations ORDER BY id').all();
  const messages = await env.DB.prepare('SELECT * FROM messages ORDER BY created_at, rowid').all();
  const quarantine = await listDlqQuarantine(env.DLQ_QUARANTINE, 10);
  const objects = await env.DLQ_QUARANTINE.list({ prefix: 'terminal-dlq/v1/' });
  const bodies = [];
  for (const object of objects.objects) {
    const stored = await env.DLQ_QUARANTINE.get(object.key);
    bodies.push(stored ? await stored.text() : null);
  }
  return {
    dlq: dlq.results,
    events: events.results,
    audits: audits.results,
    runs: runs.results,
    outbound: outbound.results,
    messages: messages.results,
    redriveQueueBodies,
    quarantine,
    quarantineBodies: bodies
  };
}

function redriveEnv(env: HarnessEnv, chatwootApiUrl = 'https://chatwoot.example/api/v1'): any {
  return {
    ...env,
    QUEUE: {
      async send(event: SupportEvent) {
        redriveQueueBodies.push(structuredClone(event));
      }
    },
    CHATWOOT_API_URL: chatwootApiUrl,
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    BOT_GROUP_ID: '-1001',
    AI_BASE_URL: 'https://ai.invalid/v1',
    AI_API_KEY: 'ai-key',
    AI_MODEL: 'model',
    AI_SYSTEM_PROMPT: 'System policy',
    AI_GENERATION_LEASE_SECONDS: '60'
  };
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
    if (path === '/seed-ai-redrive') {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO conversations
           (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
            operator_channel, operator_thread_ref, created_at, updated_at, version)
           VALUES (?, 'chatwoot', 'account-redrive', 'conversation-redrive', 'customer-redrive',
                   'telegram', '77', 1, 1, 1)`
        ).bind(redriveConversationId),
        env.DB.prepare(
          `INSERT INTO messages
           (id, conversation_id, provider, provider_message_ref, direction, actor_role,
            message_type, text_content, created_at)
           VALUES ('message-row-redrive', ?, 'chatwoot', ?, 'INBOUND', 'CUSTOMER',
                   'TEXT', 'private durable text', 100)`
        ).bind(redriveConversationId, redriveMessageId),
        env.DB.prepare(
          `INSERT INTO event_receipts
           (source, source_event_ref, status, attempt_count, event_type, conversation_id,
            last_attempt_at, dead_lettered_at)
           VALUES ('internal', ?, 'FAILED', 3, 'ai_trigger', ?, 100, 100)`
        ).bind(redriveEventId, redriveConversationId),
        env.DB.prepare(
          `INSERT INTO ai_runs
           (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
            status, attempt_count, next_retry_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, 'generation-old', 0, 'FAILED_RETRYABLE', 1, 0,
                   'AI_PROVIDER_5XX', 1, 1)`
        ).bind(redriveEventId, redriveConversationId, redriveMessageId),
        env.DB.prepare(
          `INSERT INTO dlq_receipts
           (id, queue_name, event_source, source_event_ref, event_type, conversation_id,
            safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
           VALUES (?, 'cz2128-dlq', 'internal', ?, 'ai_trigger', ?,
                   'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, 100, 100)`
        ).bind(redriveReceiptId, redriveEventId, redriveConversationId)
      ]);
      const currentEnv = redriveEnv(env);
      await prepareOutboundOperation(
        currentEnv,
        redriveConversationId,
        'chatwoot',
        'SEND_MESSAGE',
        `ai_reply:${redriveEventId}`,
        {
          subject: { type: 'AI_RUN', ref: redriveEventId },
          targetEvidence: await buildChatwootTargetEvidence(
            currentEnv,
            'account-redrive',
            'conversation-redrive',
            `ai_reply:${redriveEventId}`
          )
        }
      );
      return json({ receiptId: redriveReceiptId, eventId: redriveEventId });
    }
    if (path === '/redrive-eligibility') {
      return json(await getDlqAiRedriveEligibility(
        redriveEnv(env, input.chatwootApiUrl),
        redriveReceiptId,
        input.now
      ));
    }
    if (path === '/redrive-request') {
      return json(await requestDlqAiRedrive(
        redriveEnv(env),
        redriveReceiptId,
        '1001',
        input.commandId || '',
        input.now
      ));
    }
    if (path === '/advance-handoff') {
      await env.DB.prepare(
        `UPDATE conversations
         SET ai_mode = 'ENABLED', ai_handoff_epoch = ai_handoff_epoch + 1,
             ai_generation_id = NULL, ai_generation_started_at = NULL,
             ai_generation_message_id = NULL
         WHERE id = ?`
      ).bind(redriveConversationId).run();
      return json({ ok: true });
    }
    if (path === '/change-redrive-conversation-mapping') {
      await env.DB.prepare(
        `UPDATE conversations
         SET helpdesk_account_ref = 'account-new', helpdesk_conversation_ref = 'conversation-new'
         WHERE id = ?`
      ).bind(redriveConversationId).run();
      return json({ ok: true });
    }
    if (path === '/delete-redrive-chatwoot-operation') {
      await env.DB.prepare('DELETE FROM outbound_operations WHERE id = ?')
        .bind(`ai_reply:${redriveEventId}`).run();
      return json({ ok: true });
    }
    if (path === '/seed-newer-customer') {
      await env.DB.prepare(
        `INSERT INTO messages
         (id, conversation_id, provider, provider_message_ref, direction, actor_role,
          message_type, text_content, created_at)
         VALUES ('message-row-newer', ?, 'chatwoot', 'message-newer', 'INBOUND', 'CUSTOMER',
                 'TEXT', 'newer private durable text', 101)`
      ).bind(redriveConversationId).run();
      return json({ ok: true });
    }
    if (path === '/seed-success-with-mirror') {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE ai_runs
           SET status = 'SUCCESS', provider_response_ref = 'response-redrive',
               response_text = 'durable response', next_retry_at = NULL, last_error = NULL
           WHERE trigger_event_ref = ?`
        ).bind(redriveEventId),
        env.DB.prepare(
          `UPDATE outbound_operations
           SET status = 'SENT', provider_message_ref = 'chatwoot-sent', attempt_count = 1
           WHERE id = ?`
        ).bind(`ai_reply:${redriveEventId}`)
      ]);
      const currentEnv = redriveEnv(env);
      await prepareOutboundOperation(
        currentEnv,
        redriveConversationId,
        'telegram',
        'SEND_MESSAGE',
        `ai_tg_mirror:${redriveEventId}`,
        {
          subject: { type: 'AI_RUN', ref: redriveEventId },
          targetEvidence: buildTelegramTargetEvidence(currentEnv, '-1001', '77', 'sendMessage')
        }
      );
      return json({ ok: true });
    }
    if (path === '/malform-redrive-chatwoot-sent') {
      await env.DB.prepare(
        `UPDATE outbound_operations SET provider_message_ref = NULL
         WHERE id = ? AND status = 'SENT'`
      ).bind(`ai_reply:${redriveEventId}`).run();
      return json({ ok: true });
    }
    if (path === '/converge-stale') {
      const result = await convergeStaleAiOutboundOperations(redriveEnv(env), {
        version: 1,
        source: 'internal',
        type: 'ai_trigger',
        eventId: redriveEventId,
        payload: { convId: redriveConversationId, messageId: redriveMessageId }
      });
      return json(result);
    }
    if (path === '/process-redrive') {
      try {
        await handleQueueEvent({
          version: 1,
          source: 'internal',
          type: 'ai_trigger',
          eventId: redriveEventId,
          payload: { convId: redriveConversationId, messageId: redriveMessageId }
        }, redriveEnv(env, input.chatwootApiUrl));
        return json({ ok: true });
      } catch (error) {
        return json({ ok: false, error: safeErrorCode(error) });
      }
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
