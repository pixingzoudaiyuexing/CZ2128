import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import {
  getDlqAiRedriveEligibility,
  requestDlqAiRedrive
} from '../src/core/dlq-ai-redrive';
import {
  buildChatwootTargetEvidence,
  buildTelegramTargetEvidence,
  serializeTargetEvidence
} from '../src/core/outbound-evidence';
import { handleQueueEvent } from '../src/queue/consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

const NOW = 1_800_000_000;
const RECEIPT_ID = 'dlq:v1:eligible-ai-trigger';
const CONVERSATION_ID = 'conv-1';
const MESSAGE_REF = 'msg-1';
const EVENT_ID = `ai_trigger:${CONVERSATION_ID}:${MESSAGE_REF}`;

function makeEnv(db: SqliteD1, queue = vi.fn()): Env {
  return {
    DB: db as any,
    QUEUE: { send: queue } as any,
    CHATWOOT_API_URL: 'https://chatwoot.example/api/v1',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    BOT_GROUP_ID: '-1001',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    AI_BASE_URL: 'https://ai.example/v1',
    AI_API_KEY: 'ai-key',
    AI_MODEL: 'model',
    AI_SYSTEM_PROMPT: 'System policy',
    AI_GENERATION_LEASE_SECONDS: '60'
  } as Env;
}

async function seedEligible(
  db: SqliteD1,
  options: {
    runStatus?: string;
    attemptCount?: number;
    nextRetryAt?: number | null;
    responseText?: string | null;
    eventStatus?: string;
    eventLeaseUntil?: number | null;
  } = {}
): Promise<void> {
  const runStatus = options.runStatus || 'FAILED_RETRYABLE';
  const attemptCount = options.attemptCount ?? 1;
  const nextRetryAt = options.nextRetryAt === undefined ? NOW - 1 : options.nextRetryAt;
  const responseText = options.responseText === undefined
    ? runStatus === 'SUCCESS' ? 'Durable response' : null
    : options.responseText;
  const eventStatus = options.eventStatus || 'FAILED';
  const eventLeaseUntil = options.eventLeaseUntil === undefined ? null : options.eventLeaseUntil;
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, created_at, updated_at, version)
     VALUES (?, 'chatwoot', 'account-1', 'conversation-1', 'customer-1', 'telegram', '77', 1, 1, 1)`
  ).bind(CONVERSATION_ID).run();
  await db.prepare(
    `INSERT INTO messages
     (id, conversation_id, provider, provider_message_ref, direction, actor_role,
      message_type, text_content, created_at)
     VALUES ('message-row-1', ?, 'chatwoot', ?, 'INBOUND', 'CUSTOMER', 'TEXT', 'Customer text', 100)`
  ).bind(CONVERSATION_ID, MESSAGE_REF).run();
  await db.prepare(
    `INSERT INTO event_receipts
     (source, source_event_ref, status, attempt_count, lease_until, claim_token,
      event_type, conversation_id, last_attempt_at, dead_lettered_at)
     VALUES ('internal', ?, ?, 3, ?, NULL, 'ai_trigger', ?, 100, 100)`
  ).bind(EVENT_ID, eventStatus, eventLeaseUntil, CONVERSATION_ID).run();
  await db.prepare(
    `INSERT INTO ai_runs
     (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
      provider_response_ref, response_text, status, attempt_count, next_retry_at, last_error,
      created_at, updated_at)
     VALUES (?, ?, ?, 'generation-old', 0, 'response-1', ?, ?, ?, ?, 'AI_PROVIDER_5XX', 1, 1)`
  ).bind(
    EVENT_ID,
    CONVERSATION_ID,
    MESSAGE_REF,
    responseText,
    runStatus,
    attemptCount,
    nextRetryAt
  ).run();
  await db.prepare(
    `INSERT INTO dlq_receipts
     (id, queue_name, event_source, source_event_ref, event_type, conversation_id,
      safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
     VALUES (?, 'cz2128-dlq', 'internal', ?, 'ai_trigger', ?,
             'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, 100, 100)`
  ).bind(RECEIPT_ID, EVENT_ID, CONVERSATION_ID).run();
}

async function seedOutbound(
  db: SqliteD1,
  env: Env,
  kind: 'CHATWOOT' | 'TELEGRAM',
  status: string,
  options: { attemptCount?: number; nextRetryAt?: number | null; malformed?: boolean } = {}
): Promise<void> {
  const operationId = kind === 'CHATWOOT' ? `ai_reply:${EVENT_ID}` : `ai_tg_mirror:${EVENT_ID}`;
  const evidence = kind === 'CHATWOOT'
    ? await buildChatwootTargetEvidence(env, 'account-1', 'conversation-1', operationId)
    : buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage');
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, conversation_id, destination_provider, operation_type, status, provider_message_ref, attempt_count,
      lease_until, lease_token, last_error, created_at, updated_at, next_retry_at,
      reconciliation_status, subject_type, subject_ref, target_evidence_json)
     VALUES (?, ?, ?, 'SEND_MESSAGE', ?, ?, ?, NULL, NULL, NULL, 1, 1, ?,
             'NOT_REQUIRED', 'AI_RUN', ?, ?)`
  ).bind(
    operationId,
    CONVERSATION_ID,
    kind === 'CHATWOOT' ? 'chatwoot' : 'telegram',
    status,
    status === 'SENT' ? `${kind.toLowerCase()}-provider-ref` : null,
    options.attemptCount ?? (status === 'SENT' ? 1 : 0),
    options.nextRetryAt ?? null,
    EVENT_ID,
    options.malformed ? '{' : serializeTargetEvidence(evidence)
  ).run();
}

describe('DLQ durable-state AI redrive eligibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([0, 1, 2])('reconstructs the exact original event with attempt_count %s', async attemptCount => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { attemptCount });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW);
    expect(result).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
      aiRunStatus: 'FAILED_RETRYABLE',
      event: {
        version: 1,
        source: 'internal',
        type: 'ai_trigger',
        eventId: EVENT_ID,
        payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ['PENDING', 'AI_RUN_STATE_INELIGIBLE'],
    ['FAILED', 'AI_RUN_STATE_INELIGIBLE'],
    ['RETRY_EXHAUSTED', 'AI_RUN_STATE_INELIGIBLE'],
    ['FAILED_FINAL', 'AI_RUN_STATE_INELIGIBLE'],
    ['CANCELLED_BY_HANDOFF', 'AI_RUN_STATE_INELIGIBLE'],
    ['DISCARDED_STALE', 'AI_RUN_STATE_INELIGIBLE']
  ])('rejects AI run status %s', async (runStatus, reason) => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus });
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ eligible: false, reason });
    db.close();
  });

  it('honors AI retry deadline and maximum attempt budget', async () => {
    const notDue = new SqliteD1();
    notDue.migrate();
    await seedEligible(notDue, { nextRetryAt: NOW + 30 });
    expect(await getDlqAiRedriveEligibility(makeEnv(notDue), RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'AI_RETRY_NOT_DUE' });
    notDue.close();

    const exhausted = new SqliteD1();
    exhausted.migrate();
    await seedEligible(exhausted, { attemptCount: 3 });
    expect(await getDlqAiRedriveEligibility(makeEnv(exhausted), RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'AI_ATTEMPTS_EXHAUSTED' });
    exhausted.close();
  });

  it('uses created_at DESC, rowid DESC to reject a same-second stale trigger', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('message-row-2', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER', 'TEXT', 'Newer', 100)`
    ).bind(CONVERSATION_ID).run();
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ eligible: false, reason: 'STALE_TRIGGER' });
    db.close();
  });

  it('requires canonical Chatwoot customer text and an exact event identity prefix', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    await db.prepare('UPDATE dlq_receipts SET source_event_ref = ? WHERE id = ?')
      .bind(`ai_trigger:other-conversation:${MESSAGE_REF}`, RECEIPT_ID).run();
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'EVENT_ID_INVALID' });
    db.close();
  });

  it('fails closed when event receipt metadata disagrees with the DLQ receipt', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    await db.prepare("UPDATE event_receipts SET conversation_id = 'other' WHERE source_event_ref = ?")
      .bind(EVENT_ID).run();
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'EVENT_RECEIPT_INCONSISTENT' });
    db.close();
  });

  it.each([
    ['FAILED', null, 'ELIGIBLE'],
    ['PROCESSING', NOW - 1, 'ELIGIBLE'],
    ['PROCESSING', NOW + 30, 'EVENT_RECEIPT_ACTIVE'],
    ['PROCESSED', null, 'EVENT_RECEIPT_PROCESSED']
  ])('evaluates event receipt %s with lease %s', async (eventStatus, lease, reason) => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { eventStatus, eventLeaseUntil: lease as number | null });
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ reason });
    db.close();
  });

  it('accepts SUCCESS with no existing outbound operation as a safe candidate', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ eligible: true, aiRunStatus: 'SUCCESS' });
    db.close();
  });

  it.each([
    ['PENDING', 0, null, 'ELIGIBLE'],
    ['FAILED_RETRYABLE', 1, NOW - 1, 'ELIGIBLE'],
    ['FAILED_RETRYABLE', 1, NOW + 30, 'OUTBOUND_RETRY_NOT_DUE'],
    ['FAILED_RETRYABLE', 3, NOW - 1, 'OUTBOUND_ATTEMPTS_EXHAUSTED'],
    ['SENDING', 1, null, 'OUTBOUND_ACTIVE'],
    ['SENT', 1, null, 'ELIGIBLE'],
    ['AMBIGUOUS', 1, null, 'OUTBOUND_AMBIGUOUS'],
    ['FAILED_FINAL', 1, null, 'OUTBOUND_FINAL']
  ])('applies the Telegram mirror outbound whitelist for %s', async (status, attempts, nextRetryAt, reason) => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const env = makeEnv(db);
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', status, {
      attemptCount: attempts as number,
      nextRetryAt: nextRetryAt as number | null
    });
    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW)).toMatchObject({ reason });
    db.close();
  });

  it('blocks paused AI, epoch drift, active generation, missing run and resolved receipts', async () => {
    const cases: Array<[
      string,
      (db: SqliteD1) => Promise<void>
    ]> = [
      ['AI_PAUSED', db => db.prepare("UPDATE conversations SET ai_mode = 'PAUSED_MANUAL' WHERE id = ?").bind(CONVERSATION_ID).run() as any],
      ['HANDOFF_EPOCH_CHANGED', db => db.prepare('UPDATE conversations SET ai_handoff_epoch = 1 WHERE id = ?').bind(CONVERSATION_ID).run() as any],
      ['ACTIVE_GENERATION', db => db.prepare('UPDATE conversations SET ai_generation_id = ?, ai_generation_started_at = ? WHERE id = ?').bind('active', NOW, CONVERSATION_ID).run() as any],
      ['AI_RUN_MISSING', db => db.prepare('DELETE FROM ai_runs WHERE trigger_event_ref = ?').bind(EVENT_ID).run() as any],
      ['RECEIPT_RESOLVED', db => db.prepare("UPDATE dlq_receipts SET status = 'RESOLVED' WHERE id = ?").bind(RECEIPT_ID).run() as any]
    ];
    for (const [reason, mutate] of cases) {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db);
      await mutate(db);
      expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
        .toMatchObject({ eligible: false, reason });
      db.close();
    }
  });

  it('keeps non-AI event classes and malformed receipts ineligible', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    for (const [source, type] of [
      ['chatwoot', 'message_created'],
      ['telegram', 'message_created'],
      ['chatwoot', 'conversation_status_changed'],
      ['internal', 'attachment_transfer']
    ]) {
      await db.prepare('UPDATE dlq_receipts SET event_source = ?, event_type = ? WHERE id = ?')
        .bind(source, type, RECEIPT_ID).run();
      expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
        .toMatchObject({ eligible: false, reason: 'NOT_AI_TRIGGER' });
    }
    db.close();
  });

  it.each([
    ['PENDING', 0, null, 'ELIGIBLE'],
    ['FAILED_RETRYABLE', 1, NOW - 1, 'ELIGIBLE'],
    ['FAILED_RETRYABLE', 1, NOW + 30, 'OUTBOUND_RETRY_NOT_DUE'],
    ['FAILED_RETRYABLE', 3, NOW - 1, 'OUTBOUND_ATTEMPTS_EXHAUSTED'],
    ['SENDING', 1, null, 'OUTBOUND_ACTIVE'],
    ['SENT', 1, null, 'ELIGIBLE'],
    ['AMBIGUOUS', 1, null, 'OUTBOUND_AMBIGUOUS'],
    ['FAILED_FINAL', 1, null, 'OUTBOUND_FINAL']
  ])('applies the Chatwoot outbound whitelist for %s', async (status, attempts, nextRetryAt, reason) => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const env = makeEnv(db);
    await seedOutbound(db, env, 'CHATWOOT', status, {
      attemptCount: attempts as number,
      nextRetryAt: nextRetryAt as number | null
    });
    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW)).toMatchObject({ reason });
    db.close();
  });

  it('checks Telegram mirror state only after a durable SENT Chatwoot operation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const env = makeEnv(db);
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'AMBIGUOUS');
    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'OUTBOUND_AMBIGUOUS' });
    db.close();
  });

  it('fails closed on malformed outbound evidence and impossible pre-success outbound state', async () => {
    const successDb = new SqliteD1();
    successDb.migrate();
    await seedEligible(successDb, { runStatus: 'SUCCESS' });
    const successEnv = makeEnv(successDb);
    await seedOutbound(successDb, successEnv, 'CHATWOOT', 'PENDING', { malformed: true });
    expect(await getDlqAiRedriveEligibility(successEnv, RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'OUTBOUND_INCONSISTENT' });
    successDb.close();

    const retryDb = new SqliteD1();
    retryDb.migrate();
    await seedEligible(retryDb);
    const retryEnv = makeEnv(retryDb);
    await seedOutbound(retryDb, retryEnv, 'CHATWOOT', 'PENDING');
    expect(await getDlqAiRedriveEligibility(retryEnv, RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'OUTBOUND_INCONSISTENT' });
    retryDb.close();
  });

  it('fails closed on contradictory SENT outbound evidence', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const env = makeEnv(db);
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await db.prepare(
      "UPDATE outbound_operations SET provider_message_ref = NULL, reconciliation_status = 'MANUAL_CANCELLED' WHERE id = ?"
    ).bind(`ai_reply:${EVENT_ID}`).run();
    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW))
      .toMatchObject({ reason: 'OUTBOUND_INCONSISTENT' });
    db.close();
  });
});

describe('DLQ AI redrive request idempotency', () => {
  it('deduplicates concurrent same-command intent and sends at most one Queue message', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(db, send);
    const results = await Promise.all([
      requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5001', NOW),
      requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5001', NOW)
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['ALREADY_REQUESTED', 'ENQUEUED']);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE entity_type = 'DLQ_RECEIPT'"
    ).first<{ c: number }>())?.c).toBe(1);
    db.close();
  });

  it('allows distinct commands to enqueue identical logical events', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: unknown[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    expect((await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5001', NOW)).status).toBe('ENQUEUED');
    expect((await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5002', NOW)).status).toBe('ENQUEUED');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect((bodies[0] as any).eventId).toBe(EVENT_ID);
    db.close();
  });

  it('retains truthful intent audit when Queue send fails and permits a new command retry', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('private queue detail'))
      .mockResolvedValueOnce(undefined);
    const env = makeEnv(db, send);
    await expect(requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5001', NOW))
      .rejects.toMatchObject({ code: 'QUEUE_ENQUEUE_FAILED' });
    expect((await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5001', NOW)).status)
      .toBe('ALREADY_REQUESTED');
    expect((await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '5002', NOW)).status)
      .toBe('ENQUEUED');
    expect(send).toHaveBeenCalledTimes(2);
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<{ status: string }>())?.status).toBe('OPEN');
    db.close();
  });

  it('processes duplicate physical redrive events with one AI generation and one visible operation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8001', NOW);
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8002', NOW);
    expect(bodies).toHaveLength(2);
    await db.prepare('UPDATE ai_runs SET next_retry_at = 0 WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).run();

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let aiCalls = 0;
    let chatwootCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        aiCalls += 1;
        await gate;
        return new Response(JSON.stringify({
          id: 'response-redrive',
          choices: [{ message: { content: 'Recovered response' } }]
        }), { status: 200 });
      }
      if (String(url).includes('chatwoot.example')) {
        chatwootCalls += 1;
        return new Response(JSON.stringify({ id: 901 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), { status: 200 });
    });

    const first = handleQueueEvent(bodies[0], env);
    while (aiCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    await expect(handleQueueEvent(bodies[1], env)).rejects.toMatchObject({
      code: 'QUEUE_EVENT_CLAIM_CONTENDED'
    });
    release();
    await first;

    expect(aiCalls).toBe(1);
    expect(chatwootCalls).toBe(1);
    expect((await db.prepare('SELECT status, attempt_count FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>())).toMatchObject({ status: 'SUCCESS', attempt_count: 2 });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM outbound_operations WHERE id = ? AND status = 'SENT'")
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).c).toBe(1);
    expect((await db.prepare('SELECT status FROM event_receipts WHERE source_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('PROCESSED');
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });
});
