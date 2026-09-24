import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import {
  convergeAbandonedAiOutboundOperations,
  convergeStaleAiOutboundOperations,
  getDlqAiRedriveEligibility,
  isOpenDlqAiRecoveryEvent,
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

function makeEnv(db: SqliteD1, queue = vi.fn(), overrides: Partial<Env> = {}): Env {
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
    AI_GENERATION_LEASE_SECONDS: '60',
    ...overrides
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
    withChatwootEvidence?: boolean;
    queueName?: string;
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
  const queueName = options.queueName || 'cz2128-dlq';
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
     VALUES (?, ?, 'internal', ?, 'ai_trigger', ?,
             'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, 100, 100)`
  ).bind(RECEIPT_ID, queueName, EVENT_ID, CONVERSATION_ID).run();
  if (runStatus === 'FAILED_RETRYABLE' && options.withChatwootEvidence !== false) {
    await seedOutbound(db, makeEnv(db), 'CHATWOOT', 'PENDING');
  }
}

async function seedOutbound(
  db: SqliteD1,
  env: Env,
  kind: 'CHATWOOT' | 'TELEGRAM',
  status: string,
  options: {
    attemptCount?: number;
    nextRetryAt?: number | null;
    malformed?: boolean;
    safeRetryEvidence?: boolean;
  } = {}
): Promise<void> {
  const operationId = kind === 'CHATWOOT' ? `ai_reply:${EVENT_ID}` : `ai_tg_mirror:${EVENT_ID}`;
  const evidence = kind === 'CHATWOOT'
    ? await buildChatwootTargetEvidence(env, 'account-1', 'conversation-1', operationId)
    : buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage');
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, conversation_id, destination_provider, operation_type, status, provider_message_ref, attempt_count,
      lease_until, lease_token, last_error, created_at, updated_at, request_started_at,
      response_observed_at, response_http_status, next_retry_at,
      reconciliation_status, subject_type, subject_ref, target_evidence_json)
     VALUES (?, ?, ?, 'SEND_MESSAGE', ?, ?, ?, NULL, NULL, ?, 1, 1, ?, ?, ?, ?,
             'NOT_REQUIRED', 'AI_RUN', ?, ?)`
  ).bind(
    operationId,
    CONVERSATION_ID,
    kind === 'CHATWOOT' ? 'chatwoot' : 'telegram',
    status,
    status === 'SENT' ? `${kind.toLowerCase()}-provider-ref` : null,
    options.attemptCount ?? (status === 'SENT' ? 1 : 0),
    status === 'FAILED_RETRYABLE' && options.safeRetryEvidence ? 'OUTBOUND_RATE_LIMITED' : null,
    status === 'FAILED_RETRYABLE' && options.safeRetryEvidence ? 1 : null,
    status === 'FAILED_RETRYABLE' && options.safeRetryEvidence ? 2 : null,
    status === 'FAILED_RETRYABLE' && options.safeRetryEvidence ? 429 : null,
    options.nextRetryAt ?? null,
    EVENT_ID,
    options.malformed ? '{' : serializeTargetEvidence(evidence)
  ).run();
}

describe('DLQ durable-state AI redrive eligibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows scope-denied recovery only after durable AI success and confirmed Chatwoot delivery', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const env = makeEnv(db, vi.fn(), {
      AI_TEST_SCOPE_ENABLED: 'true',
      AI_TEST_ALLOWED_CONVERSATION_IDS: '["11111111-1111-4111-8111-111111111111"]'
    });
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'FAILED_RETRYABLE', {
      attemptCount: 1,
      nextRetryAt: 0,
      safeRetryEvidence: true
    });

    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW)).toMatchObject({
      eligible: true,
      reason: 'ELIGIBLE',
      aiRunStatus: 'SUCCESS'
    });
    db.close();
  });

  it('blocks scope-denied recovery when Chatwoot delivery is not SENT', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const env = makeEnv(db, vi.fn(), {
      AI_TEST_SCOPE_ENABLED: 'true',
      AI_TEST_ALLOWED_CONVERSATION_IDS: '["11111111-1111-4111-8111-111111111111"]'
    });
    await seedOutbound(db, env, 'CHATWOOT', 'PENDING');

    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW)).toMatchObject({
      eligible: false,
      reason: 'AI_SCOPE_DENIED'
    });
    db.close();
  });

  it('uses the legacy DLQ identity when both Queue variables are absent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const env = makeEnv(db);
    const event = {
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: EVENT_ID,
      payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
    } as const;
    expect(await isOpenDlqAiRecoveryEvent(env, event)).toBe(true);
    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW)).toMatchObject({
      eligible: true,
      reason: 'ELIGIBLE'
    });
    db.close();
  });

  it('uses the staging DLQ identity and rejects a legacy receipt in staging', async () => {
    const stagingVars = {
      EXPECTED_MAIN_QUEUE_NAME: 'cz2128-4c-staging-queue',
      EXPECTED_DLQ_QUEUE_NAME: 'cz2128-4c-staging-dlq'
    };
    const stagingDb = new SqliteD1();
    stagingDb.migrate();
    await seedEligible(stagingDb, { queueName: 'cz2128-4c-staging-dlq' });
    const stagingEnv = makeEnv(stagingDb, vi.fn(), stagingVars);
    const event = {
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: EVENT_ID,
      payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
    } as const;
    expect(await isOpenDlqAiRecoveryEvent(stagingEnv, event)).toBe(true);
    expect(await getDlqAiRedriveEligibility(stagingEnv, RECEIPT_ID, NOW)).toMatchObject({
      eligible: true,
      reason: 'ELIGIBLE'
    });
    stagingDb.close();

    const legacyDb = new SqliteD1();
    legacyDb.migrate();
    await seedEligible(legacyDb);
    const selectedStagingEnv = makeEnv(legacyDb, vi.fn(), stagingVars);
    expect(await isOpenDlqAiRecoveryEvent(selectedStagingEnv, event)).toBe(false);
    expect(await getDlqAiRedriveEligibility(selectedStagingEnv, RECEIPT_ID, NOW)).toMatchObject({
      eligible: false,
      reason: 'NOT_AI_TRIGGER'
    });
    legacyDb.close();
  });

  it('does not accept a staging receipt in the legacy environment', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { queueName: 'cz2128-4c-staging-dlq' });
    const env = makeEnv(db);
    expect(await getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW)).toMatchObject({
      eligible: false,
      reason: 'NOT_AI_TRIGGER'
    });
    db.close();
  });

  it('rejects partial Queue identity configuration before receipt lookup', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const env = makeEnv(db, vi.fn(), {
      EXPECTED_MAIN_QUEUE_NAME: 'cz2128-4c-staging-queue'
    });
    const event = {
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: EVENT_ID,
      payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
    } as const;
    await expect(isOpenDlqAiRecoveryEvent(env, event)).rejects.toThrow('QUEUE_IDENTITY_CONFIG_INVALID');
    await expect(getDlqAiRedriveEligibility(env, RECEIPT_ID, NOW))
      .rejects.toThrow('QUEUE_IDENTITY_CONFIG_INVALID');
    db.close();
  });

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

  it('rejects SUCCESS with no historical Chatwoot target evidence even when current target is unchanged', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    expect(await getDlqAiRedriveEligibility(makeEnv(db), RECEIPT_ID, NOW))
      .toMatchObject({ eligible: false, reason: 'OUTBOUND_EVIDENCE_MISSING' });
    db.close();
  });

  it('rejects SUCCESS with no historical Chatwoot evidence after the current endpoint changes', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const changedEnv = makeEnv(db);
    changedEnv.CHATWOOT_API_URL = 'https://changed-chatwoot.example/api/v1';
    expect(await getDlqAiRedriveEligibility(changedEnv, RECEIPT_ID, NOW))
      .toMatchObject({ eligible: false, reason: 'OUTBOUND_EVIDENCE_MISSING' });
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

  it('fails closed on malformed outbound evidence and accepts prepared retry evidence', async () => {
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
    expect(await getDlqAiRedriveEligibility(retryEnv, RECEIPT_ID, NOW))
      .toMatchObject({ eligible: true, reason: 'ELIGIBLE' });
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
  it('scope-denied redrive converges only the existing Telegram mirror after Chatwoot SENT', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }), {
      AI_TEST_SCOPE_ENABLED: 'true',
      AI_TEST_ALLOWED_CONVERSATION_IDS: '["11111111-1111-4111-8111-111111111111"]'
    });
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'FAILED_RETRYABLE', {
      attemptCount: 1,
      nextRetryAt: 0,
      safeRetryEvidence: true
    });

    expect((await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '4901', NOW)).status)
      .toBe('ENQUEUED');
    expect(bodies).toHaveLength(1);
    let aiCalls = 0;
    let chatwootCalls = 0;
    let telegramCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const target = String(url);
      if (target.includes('ai.example')) {
        aiCalls += 1;
        throw new Error('AI Provider boundary crossed');
      }
      if (target.includes('chatwoot.example')) {
        chatwootCalls += 1;
        throw new Error('Chatwoot duplicate boundary crossed');
      }
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), {
        status: 200
      });
    });

    await handleQueueEvent(bodies[0], env);

    expect({ aiCalls, chatwootCalls, telegramCalls }).toEqual({
      aiCalls: 0,
      chatwootCalls: 0,
      telegramCalls: 1
    });
    expect((await db.prepare(
      'SELECT COUNT(*) AS c FROM ai_runs WHERE trigger_event_ref = ?'
    ).bind(EVENT_ID).first<any>()).c).toBe(1);
    expect((await db.prepare(
      'SELECT status, attempt_count FROM ai_runs WHERE trigger_event_ref = ?'
    ).bind(EVENT_ID).first<any>())).toMatchObject({ status: 'SUCCESS', attempt_count: 1 });
    expect((await db.prepare(
      'SELECT status, attempt_count, provider_message_ref FROM outbound_operations WHERE id = ?'
    ).bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'SENT', attempt_count: 1, provider_message_ref: 'chatwoot-provider-ref'
    });
    expect((await db.prepare(
      'SELECT status, attempt_count, provider_message_ref FROM outbound_operations WHERE id = ?'
    ).bind(`ai_tg_mirror:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'SENT', attempt_count: 2, provider_message_ref: '902'
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND actor_role = 'AI'"
    ).bind(CONVERSATION_ID).first<any>()).c).toBe(1);
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

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

  it('converges a SENT Chatwoot reply without creating a missing mirror after Bot rotation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const originalEnv = makeEnv(db);
    await seedOutbound(db, originalEnv, 'CHATWOOT', 'SENT');
    const bodies: any[] = [];
    originalEnv.QUEUE = { send: vi.fn(async body => { bodies.push(body); }) } as any;
    expect((await requestDlqAiRedrive(originalEnv, RECEIPT_ID, '1001', '8101', NOW)).status)
      .toBe('ENQUEUED');

    const rotatedEnv = makeEnv(db);
    rotatedEnv.TELEGRAM_BOT_TOKEN = 'rotated-token';
    rotatedEnv.runtimeConfigSnapshot = {
      values: {},
      sources: {
        AI_BASE_URL: 'ENV', AI_MODEL: 'ENV', AI_API_KEY: 'ENV', AI_SYSTEM_PROMPT: 'ENV',
        AI_REQUEST_TIMEOUT_MS: 'ENV', AI_CONTEXT_MAX_MESSAGES: 'ENV', AI_CONTEXT_MAX_CHARS: 'ENV',
        AI_GENERATION_LEASE_SECONDS: 'ENV', AI_OPERATOR_PAUSE_TIMEOUT_SECONDS: 'ENV',
        CRISP_KEYWORD_RULES: 'ENV', CRISP_WELCOME_CONFIG: 'ENV',
        TELEGRAM_SUPPORT_PROFILE: 'D1', BOT_GROUP_ID: 'ENV', CHATWOOT_API_URL: 'ENV',
        CHATWOOT_API_TOKEN: 'ENV', CHATWOOT_ATTACHMENT_ALLOWED_HOSTS: 'ENV',
        ATTACHMENT_MAX_BYTES: 'ENV', ATTACHMENT_MAX_COUNT_PER_MESSAGE: 'ENV',
        ATTACHMENT_TTL_SECONDS: 'ENV', ATTACHMENT_SOURCE_TIMEOUT_MS: 'ENV',
        ATTACHMENT_DESTINATION_TIMEOUT_MS: 'ENV'
      },
      versions: { TELEGRAM_SUPPORT_PROFILE: 2 },
      errors: {},
      overrideCount: 1,
      health: 'AVAILABLE'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], rotatedEnv);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT id FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first()).toBeNull();
    expect((await db.prepare('SELECT status FROM event_receipts WHERE source_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('PROCESSED');
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it('continues an existing matching Telegram mirror without resending SENT Chatwoot', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'PENDING');
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8102', NOW);
    let chatwootCalls = 0;
    let telegramCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('chatwoot')) chatwootCalls += 1;
      if (String(url).includes('telegram')) telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), { status: 200 });
    });

    await handleQueueEvent(bodies[0], env);

    expect(chatwootCalls).toBe(0);
    expect(telegramCalls).toBe(1);
    expect((await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>()).status).toBe('SENT');
    db.close();
  });

  it('revalidates target evidence at consumption after Admin approval and fails closed on endpoint change', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const originalEnv = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, originalEnv, 'CHATWOOT', 'PENDING');
    expect((await requestDlqAiRedrive(originalEnv, RECEIPT_ID, '1001', '8103', NOW)).status)
      .toBe('ENQUEUED');
    const changedEnv = makeEnv(db);
    changedEnv.CHATWOOT_API_URL = 'https://changed-chatwoot.example/api/v1';
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(handleQueueEvent(bodies[0], changedEnv)).rejects.toMatchObject({
      code: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'TARGET_IDENTITY_CHANGED'
    });
    expect((await db.prepare('SELECT status FROM event_receipts WHERE source_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('FAILED');
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
    db.close();
  });

  it('blocks FAILED_RETRYABLE before another AI attempt when its prepared Chatwoot target changed', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const originalEnv = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(originalEnv, RECEIPT_ID, '1001', '8104', NOW);
    await db.prepare('UPDATE ai_runs SET next_retry_at = 0 WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).run();
    const changedEnv = makeEnv(db);
    changedEnv.CHATWOOT_API_URL = 'https://changed-chatwoot.example/api/v1';
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(handleQueueEvent(bodies[0], changedEnv)).rejects.toMatchObject({
      code: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT attempt_count, status FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>())).toMatchObject({ attempt_count: 1, status: 'PENDING' });
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'TARGET_IDENTITY_CHANGED'
    });
    db.close();
  });

  it('fails closed when another flow changes the prepared Chatwoot operation after Admin approval', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'PENDING');
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8105', NOW);
    await db.prepare(
      `UPDATE outbound_operations
       SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING'
       WHERE id = ?`
    ).bind(`ai_reply:${EVENT_ID}`).run();
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-before-ambiguous', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(handleQueueEvent(bodies[0], env)).rejects.toMatchObject({
      code: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
    expect((await db.prepare('SELECT status, reconciliation_status FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'AMBIGUOUS', reconciliation_status: 'PENDING'
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).first<any>()).c).toBe(0);
    db.close();
  });

  it('does not send an existing historical mirror after its Telegram group target changes', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const originalEnv = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, originalEnv, 'CHATWOOT', 'SENT');
    await seedOutbound(db, originalEnv, 'TELEGRAM', 'PENDING');
    await requestDlqAiRedrive(originalEnv, RECEIPT_ID, '1001', '8106', NOW);
    const changedEnv = makeEnv(db);
    changedEnv.BOT_GROUP_ID = '-2002';
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], changedEnv);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'TARGET_IDENTITY_CHANGED'
    });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM messages WHERE actor_role = 'AI'")
      .first<any>()).c).toBe(1);
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it('drops a redrive when a newer customer message is durable before consumption', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8201', NOW);
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-before-consume', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('DISCARDED_STALE');
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'DISCARDED_STALE'
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE entity_id = ? AND action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).bind(`ai_reply:${EVENT_ID}`).first<any>()).c).toBe(1);
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it('discards a redrive when a newer customer message arrives during generation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8202', NOW);
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
          id: 'response-stale', choices: [{ message: { content: 'Stale response' } }]
        }), { status: 200 });
      }
      chatwootCalls += 1;
      return new Response(JSON.stringify({ id: 901 }), { status: 200 });
    });

    const processing = handleQueueEvent(bodies[0], env);
    while (aiCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-during-generation', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    release();
    await processing;

    expect(aiCalls).toBe(1);
    expect(chatwootCalls).toBe(0);
    expect((await db.prepare('SELECT status FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('DISCARDED_STALE');
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'DISCARDED_STALE'
    });
    expect((await db.prepare('SELECT attempt_count FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).attempt_count).toBe(2);
    db.close();
  });

  it('rechecks freshness immediately before historical Chatwoot dispatch', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8203', NOW);
    await seedOutbound(db, env, 'TELEGRAM', 'PENDING');
    await db.prepare('UPDATE ai_runs SET next_retry_at = 0 WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).run();
    env.hooks = {
      beforeAiDispatchPreflight: async innerEnv => {
        await innerEnv.DB.prepare(
          `INSERT INTO messages
           (id, conversation_id, provider, provider_message_ref, direction, actor_role,
            message_type, text_content, created_at)
           VALUES ('newer-before-dispatch', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
                   'TEXT', 'New customer text', 101)`
        ).bind(CONVERSATION_ID).run();
      }
    };
    let aiCalls = 0;
    let chatwootCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        aiCalls += 1;
        return new Response(JSON.stringify({
          id: 'response-before-dispatch', choices: [{ message: { content: 'Generated response' } }]
        }), { status: 200 });
      }
      chatwootCalls += 1;
      return new Response(JSON.stringify({ id: 901 }), { status: 200 });
    });

    await handleQueueEvent(bodies[0], env);

    expect(aiCalls).toBe(1);
    expect(chatwootCalls).toBe(0);
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'DISCARDED_STALE'
    });
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'DISCARDED_STALE'
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).first<any>()).c).toBe(2);
    expect((await db.prepare(
      `SELECT old_state, new_state, reason_code FROM reliability_audit
       WHERE entity_id = ? AND action = 'HISTORICAL_AI_STALE_DISCARDED'`
    ).bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      old_state: 'SENDING',
      new_state: 'FAILED_FINAL',
      reason_code: 'DISCARDED_STALE'
    });
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it('converges stale SUCCESS with a safe Chatwoot FAILED_RETRYABLE operation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'FAILED_RETRYABLE', {
      attemptCount: 1,
      nextRetryAt: NOW - 1,
      safeRetryEvidence: true
    });
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8301', NOW);
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-success-retry', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, response_text FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>())).toMatchObject({
      status: 'SUCCESS', response_text: 'Durable response'
    });
    expect((await db.prepare(
      `SELECT status, last_error, attempt_count, request_started_at,
              response_observed_at, response_http_status
       FROM outbound_operations WHERE id = ?`
    ).bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'DISCARDED_STALE',
      attempt_count: 1,
      request_started_at: 1,
      response_observed_at: 2,
      response_http_status: 429
    });
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it.each(['PENDING', 'FAILED_RETRYABLE'] as const)(
    'preserves SENT Chatwoot and converges stale Telegram %s',
    async mirrorStatus => {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db, { runStatus: 'SUCCESS' });
      const bodies: any[] = [];
      const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
      await seedOutbound(db, env, 'CHATWOOT', 'SENT');
      await seedOutbound(db, env, 'TELEGRAM', mirrorStatus, {
        attemptCount: mirrorStatus === 'FAILED_RETRYABLE' ? 1 : 0,
        nextRetryAt: mirrorStatus === 'FAILED_RETRYABLE' ? NOW - 1 : null,
        safeRetryEvidence: mirrorStatus === 'FAILED_RETRYABLE'
      });
      await requestDlqAiRedrive(env, RECEIPT_ID, '1001', `83${mirrorStatus.length}`, NOW);
      await db.prepare(
        `INSERT INTO messages
         (id, conversation_id, provider, provider_message_ref, direction, actor_role,
          message_type, text_content, created_at)
         VALUES ('newer-mirror', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
                 'TEXT', 'New customer text', 101)`
      ).bind(CONVERSATION_ID).run();
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      await handleQueueEvent(bodies[0], env);

      expect(fetchMock).not.toHaveBeenCalled();
      expect((await db.prepare('SELECT status, provider_message_ref FROM outbound_operations WHERE id = ?')
        .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
        status: 'SENT', provider_message_ref: 'chatwoot-provider-ref'
      });
      expect((await db.prepare('SELECT status, last_error, attempt_count FROM outbound_operations WHERE id = ?')
        .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>())).toMatchObject({
        status: 'FAILED_FINAL',
        last_error: 'DISCARDED_STALE',
        attempt_count: mirrorStatus === 'FAILED_RETRYABLE' ? 1 : 0
      });
      expect((await db.prepare("SELECT COUNT(*) AS c FROM messages WHERE actor_role = 'AI'")
        .first<any>()).c).toBe(1);
      expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
        .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
      db.close();
    }
  );

  it('preserves SENT Chatwoot and SENT Telegram when the historical trigger is stale', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'SENT');
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8304', NOW);
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-both-sent', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT id, status FROM outbound_operations ORDER BY id').all<any>()).results)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `ai_reply:${EVENT_ID}`, status: 'SENT' }),
        expect.objectContaining({ id: `ai_tg_mirror:${EVENT_ID}`, status: 'SENT' })
      ]));
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).first<any>()).c).toBe(0);
    db.close();
  });

  it('fails closed when stale convergence loses a PENDING operation to a SENDING claimant', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8305', NOW);
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-claim-race', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    env.hooks = {
      beforeStaleOutboundConvergence: async innerEnv => {
        await innerEnv.DB.prepare(
          `UPDATE outbound_operations
           SET status = 'SENDING', lease_until = ?, lease_token = 'v2:other-owner'
           WHERE id = ? AND status = 'PENDING'`
        ).bind(NOW + 60, `ai_reply:${EVENT_ID}`).run();
      }
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(handleQueueEvent(bodies[0], env)).rejects.toMatchObject({
      code: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, lease_token FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'SENDING', lease_token: 'v2:other-owner'
    });
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).first<any>()).c).toBe(0);
    db.close();
  });

  it('converges duplicate stale cleanup calls idempotently with one audit', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const env = makeEnv(db);
    const staleEvent = {
      version: 1 as const,
      source: 'internal' as const,
      type: 'ai_trigger' as const,
      eventId: EVENT_ID,
      payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
    };

    const results = await Promise.all([
      convergeStaleAiOutboundOperations(env, staleEvent),
      convergeStaleAiOutboundOperations(env, staleEvent)
    ]);

    expect(results.reduce((sum, result) => sum + result.changed, 0)).toBe(1);
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'DISCARDED_STALE'
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE entity_id = ? AND action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).bind(`ai_reply:${EVENT_ID}`).first<any>()).c).toBe(1);
    db.close();
  });

  it('keeps event and DLQ unresolved when stale convergence D1 batch fails', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const requestEnv = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(requestEnv, RECEIPT_ID, '1001', '8306', NOW);
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('newer-batch-failure', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
               'TEXT', 'New customer text', 101)`
    ).bind(CONVERSATION_ID).run();
    const processingEnv = makeEnv(db);
    processingEnv.DB = {
      prepare: db.prepare.bind(db),
      batch: vi.fn(async () => { throw new Error('simulated D1 batch failure'); })
    } as any;

    await expect(handleQueueEvent(bodies[0], processingEnv)).rejects.toMatchObject({
      code: 'D1_RESULT_PERSIST_FAILED'
    });

    expect((await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).status).toBe('PENDING');
    expect((await db.prepare('SELECT status FROM event_receipts WHERE source_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('FAILED');
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'HISTORICAL_AI_STALE_DISCARDED'"
    ).first<any>()).c).toBe(0);
    db.close();
  });

  it('converges both operations when Telegram becomes stale immediately before dispatch', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'PENDING');
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8307', NOW);
    env.hooks = {
      beforeAiTelegramDispatchPreflight: async innerEnv => {
        await innerEnv.DB.prepare(
          `INSERT INTO messages
           (id, conversation_id, provider, provider_message_ref, direction, actor_role,
            message_type, text_content, created_at)
           VALUES ('newer-before-telegram', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
                   'TEXT', 'New customer text', 101)`
        ).bind(CONVERSATION_ID).run();
      }
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).status).toBe('SENT');
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'DISCARDED_STALE'
    });
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it('converges historical handoff before consume with CANCELLED_BY_HANDOFF semantics', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8401', NOW);
    await db.prepare(
      `UPDATE conversations
       SET ai_mode = 'PAUSED_OPERATOR', ai_handoff_epoch = ai_handoff_epoch + 1
       WHERE id = ?`
    ).bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('CANCELLED_BY_HANDOFF');
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'CANCELLED_BY_HANDOFF'
    });
    expect((await db.prepare(
      `SELECT action, old_state, new_state, reason_code FROM reliability_audit
       WHERE entity_id = ? AND action = 'AI_HANDOFF_CANCELLED'`
    ).bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      old_state: 'PENDING', new_state: 'FAILED_FINAL', reason_code: 'CANCELLED_BY_HANDOFF'
    });
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
    db.close();
  });

  it('preserves historical SUCCESS while cancelling a safe Chatwoot 429 retry after handoff', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'FAILED_RETRYABLE', {
      attemptCount: 1, nextRetryAt: NOW - 1, safeRetryEvidence: true
    });
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8402', NOW);
    await db.prepare('UPDATE conversations SET ai_handoff_epoch = ai_handoff_epoch + 1 WHERE id = ?')
      .bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, response_text FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>())).toMatchObject({ status: 'SUCCESS', response_text: 'Durable response' });
    expect((await db.prepare('SELECT status, last_error, attempt_count FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'CANCELLED_BY_HANDOFF', attempt_count: 1
    });
    db.close();
  });

  it('preserves SENT Chatwoot and cancels a safe pending mirror after handoff', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    await seedOutbound(db, env, 'TELEGRAM', 'PENDING');
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', '8403', NOW);
    await db.prepare('UPDATE conversations SET ai_handoff_epoch = ai_handoff_epoch + 1 WHERE id = ?')
      .bind(CONVERSATION_ID).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await handleQueueEvent(bodies[0], env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, provider_message_ref FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'SENT', provider_message_ref: 'chatwoot-provider-ref'
    });
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'CANCELLED_BY_HANDOFF'
    });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM messages WHERE actor_role = 'AI'")
      .first<any>()).c).toBe(1);
    db.close();
  });

  it.each(['SENDING', 'AMBIGUOUS'] as const)(
    'keeps historical handoff unresolved for unsafe outbound state %s',
    async unsafeStatus => {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db);
      const bodies: any[] = [];
      const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
      await requestDlqAiRedrive(env, RECEIPT_ID, '1001', `84${unsafeStatus.length}`, NOW);
      await db.prepare(
        unsafeStatus === 'SENDING'
          ? `UPDATE outbound_operations
             SET status = 'SENDING', lease_until = ?, lease_token = 'v2:other-owner'
             WHERE id = ?`
          : `UPDATE outbound_operations
             SET status = 'AMBIGUOUS', reconciliation_status = 'PENDING'
             WHERE id = ?`
      ).bind(...(unsafeStatus === 'SENDING'
        ? [NOW + 60, `ai_reply:${EVENT_ID}`]
        : [`ai_reply:${EVENT_ID}`])).run();
      await db.prepare('UPDATE conversations SET ai_handoff_epoch = ai_handoff_epoch + 1 WHERE id = ?')
        .bind(CONVERSATION_ID).run();
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      await expect(handleQueueEvent(bodies[0], env)).rejects.toMatchObject({
        code: 'OUTBOUND_PRECONDITION_FAILED'
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect((await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
        .bind(`ai_reply:${EVENT_ID}`).first<any>()).status).toBe(unsafeStatus);
      expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
        .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
      expect((await db.prepare(
        "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'AI_HANDOFF_CANCELLED'"
      ).first<any>()).c).toBe(0);
      db.close();
    }
  );

  it.each(['DISCARDED_STALE', 'CANCELLED_BY_HANDOFF'] as const)(
    'allows no-send %s cleanup across current Chatwoot mapping drift',
    async reason => {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db);
      const bodies: any[] = [];
      const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
      const originalEvidence = (await db.prepare(
        'SELECT target_evidence_json FROM outbound_operations WHERE id = ?'
      ).bind(`ai_reply:${EVENT_ID}`).first<any>()).target_evidence_json;
      await requestDlqAiRedrive(env, RECEIPT_ID, '1001', `85${reason.length}`, NOW);
      await db.prepare(
        `UPDATE conversations
         SET helpdesk_account_ref = 'account-new', helpdesk_conversation_ref = 'conversation-new'
         WHERE id = ?`
      ).bind(CONVERSATION_ID).run();
      if (reason === 'DISCARDED_STALE') {
        await db.prepare(
          `INSERT INTO messages
           (id, conversation_id, provider, provider_message_ref, direction, actor_role,
            message_type, text_content, created_at)
           VALUES ('newer-drift', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
                   'TEXT', 'New customer text', 101)`
        ).bind(CONVERSATION_ID).run();
      } else {
        await db.prepare('UPDATE conversations SET ai_handoff_epoch = ai_handoff_epoch + 1 WHERE id = ?')
          .bind(CONVERSATION_ID).run();
      }
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      await handleQueueEvent(bodies[0], env);

      expect(fetchMock).not.toHaveBeenCalled();
      expect((await db.prepare('SELECT status, last_error, target_evidence_json FROM outbound_operations WHERE id = ?')
        .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
        status: 'FAILED_FINAL', last_error: reason, target_evidence_json: originalEvidence
      });
      expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
        .bind(RECEIPT_ID).first<any>()).status).toBe('RESOLVED');
      db.close();
    }
  );

  it.each(['MALFORMED', 'WRONG_SOURCE', 'WRONG_SUBJECT', 'WRONG_ID'] as const)(
    'fails closed on abandoned outbound historical evidence/identity case %s',
    async invalidCase => {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db);
      const bodies: any[] = [];
      const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
      await requestDlqAiRedrive(env, RECEIPT_ID, '1001', `86${invalidCase.length}`, NOW);
      if (invalidCase === 'MALFORMED') {
        await db.prepare('UPDATE outbound_operations SET target_evidence_json = ? WHERE id = ?')
          .bind('{', `ai_reply:${EVENT_ID}`).run();
      } else if (invalidCase === 'WRONG_SOURCE') {
        const row = await db.prepare('SELECT target_evidence_json FROM outbound_operations WHERE id = ?')
          .bind(`ai_reply:${EVENT_ID}`).first<any>();
        const evidence = JSON.parse(row.target_evidence_json);
        evidence.sourceId = 'cz2128:wrong-operation';
        await db.prepare('UPDATE outbound_operations SET target_evidence_json = ? WHERE id = ?')
          .bind(JSON.stringify(evidence), `ai_reply:${EVENT_ID}`).run();
      } else if (invalidCase === 'WRONG_SUBJECT') {
        await db.prepare('UPDATE outbound_operations SET subject_ref = ? WHERE id = ?')
          .bind('wrong-event', `ai_reply:${EVENT_ID}`).run();
      } else {
        await db.prepare('UPDATE outbound_operations SET id = ? WHERE id = ?')
          .bind('ai_reply:wrong-event', `ai_reply:${EVENT_ID}`).run();
      }
      await db.prepare('UPDATE conversations SET ai_handoff_epoch = ai_handoff_epoch + 1 WHERE id = ?')
        .bind(CONVERSATION_ID).run();
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      await expect(handleQueueEvent(bodies[0], env)).rejects.toMatchObject({
        code: 'OUTBOUND_PRECONDITION_FAILED'
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
        .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
      db.close();
    }
  );

  it('deduplicates repeated handoff cleanup after target drift', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    await db.prepare(
      `UPDATE conversations
       SET helpdesk_account_ref = 'account-new', helpdesk_conversation_ref = 'conversation-new'
       WHERE id = ?`
    ).bind(CONVERSATION_ID).run();
    const env = makeEnv(db);
    const abandonedEvent = {
      version: 1 as const,
      source: 'internal' as const,
      type: 'ai_trigger' as const,
      eventId: EVENT_ID,
      payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
    };

    const results = await Promise.all([
      convergeAbandonedAiOutboundOperations(env, abandonedEvent, 'CANCELLED_BY_HANDOFF'),
      convergeAbandonedAiOutboundOperations(env, abandonedEvent, 'CANCELLED_BY_HANDOFF')
    ]);

    expect(results.reduce((sum, result) => sum + result.changed, 0)).toBe(1);
    expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'CANCELLED_BY_HANDOFF'
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE entity_id = ? AND action = 'AI_HANDOFF_CANCELLED'"
    ).bind(`ai_reply:${EVENT_ID}`).first<any>()).c).toBe(1);
    db.close();
  });

  it.each(['DISCARDED_STALE', 'CANCELLED_BY_HANDOFF'] as const)(
    'preserves unsafe non-429 retryable outbound for %s cleanup',
    async reason => {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db);
      const env = makeEnv(db);
      await db.prepare(
        `UPDATE outbound_operations
         SET status = 'FAILED_RETRYABLE', last_error = 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS',
             request_started_at = 1, response_observed_at = 2, response_http_status = 503,
             next_retry_at = ?, attempt_count = 1
         WHERE id = ?`
      ).bind(NOW - 1, `ai_reply:${EVENT_ID}`).run();
      const abandonedEvent = {
        version: 1 as const,
        source: 'internal' as const,
        type: 'ai_trigger' as const,
        eventId: EVENT_ID,
        payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
      };

      await expect(convergeAbandonedAiOutboundOperations(env, abandonedEvent, reason))
        .rejects.toMatchObject({ code: 'OUTBOUND_PRECONDITION_FAILED' });

      expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
        .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
        status: 'FAILED_RETRYABLE', last_error: 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS'
      });
      expect((await db.prepare('SELECT COUNT(*) AS c FROM reliability_audit')
        .first<any>()).c).toBe(0);
      db.close();
    }
  );

  it.each(['DISCARDED_STALE', 'CANCELLED_BY_HANDOFF'] as const)(
    'preserves existing FAILED_FINAL reason during %s cleanup',
    async reason => {
      const db = new SqliteD1();
      db.migrate();
      await seedEligible(db);
      const env = makeEnv(db);
      await db.prepare(
        `UPDATE outbound_operations
         SET status = 'FAILED_FINAL', last_error = 'OUTBOUND_PROVIDER_4XX_FINAL'
         WHERE id = ?`
      ).bind(`ai_reply:${EVENT_ID}`).run();
      const abandonedEvent = {
        version: 1 as const,
        source: 'internal' as const,
        type: 'ai_trigger' as const,
        eventId: EVENT_ID,
        payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
      };

      expect(await convergeAbandonedAiOutboundOperations(env, abandonedEvent, reason))
        .toEqual({ changed: 0 });
      expect((await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
        .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
        status: 'FAILED_FINAL', last_error: 'OUTBOUND_PROVIDER_4XX_FINAL'
      });
      expect((await db.prepare('SELECT COUNT(*) AS c FROM reliability_audit')
        .first<any>()).c).toBe(0);
      db.close();
    }
  );

  it.each([
    ['DISCARDED_STALE', 'CHATWOOT'],
    ['CANCELLED_BY_HANDOFF', 'CHATWOOT'],
    ['DISCARDED_STALE', 'TELEGRAM'],
    ['CANCELLED_BY_HANDOFF', 'TELEGRAM']
  ] as const)('fails closed for %s cleanup with malformed %s SENT evidence', async (reason, kind) => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db, { runStatus: 'SUCCESS' });
    const bodies: any[] = [];
    const env = makeEnv(db, vi.fn(async body => { bodies.push(body); }));
    await seedOutbound(db, env, 'CHATWOOT', 'SENT');
    if (kind === 'TELEGRAM') await seedOutbound(db, env, 'TELEGRAM', 'SENT');
    await requestDlqAiRedrive(env, RECEIPT_ID, '1001', `87${reason.length}${kind.length}`, NOW);
    const operationId = kind === 'CHATWOOT'
      ? `ai_reply:${EVENT_ID}`
      : `ai_tg_mirror:${EVENT_ID}`;
    await db.prepare('UPDATE outbound_operations SET provider_message_ref = NULL WHERE id = ?')
      .bind(operationId).run();
    if (reason === 'DISCARDED_STALE') {
      await db.prepare(
        `INSERT INTO messages
         (id, conversation_id, provider, provider_message_ref, direction, actor_role,
          message_type, text_content, created_at)
         VALUES ('newer-malformed-sent', ?, 'chatwoot', 'msg-2', 'INBOUND', 'CUSTOMER',
                 'TEXT', 'New customer text', 101)`
      ).bind(CONVERSATION_ID).run();
    } else {
      await db.prepare('UPDATE conversations SET ai_handoff_epoch = ai_handoff_epoch + 1 WHERE id = ?')
        .bind(CONVERSATION_ID).run();
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(handleQueueEvent(bodies[0], env)).rejects.toMatchObject({
      code: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status, provider_message_ref FROM outbound_operations WHERE id = ?')
      .bind(operationId).first<any>())).toMatchObject({ status: 'SENT', provider_message_ref: null });
    expect((await db.prepare('SELECT status FROM event_receipts WHERE source_event_ref = ?')
      .bind(EVENT_ID).first<any>()).status).toBe('FAILED');
    expect((await db.prepare('SELECT status FROM dlq_receipts WHERE id = ?')
      .bind(RECEIPT_ID).first<any>()).status).toBe('OPEN');
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action IN ('HISTORICAL_AI_STALE_DISCARDED', 'AI_HANDOFF_CANCELLED')"
    ).first<any>()).c).toBe(0);
    db.close();
  });

  it.each([
    ['valid', 'provider-race-ref', true],
    ['malformed', null, false]
  ] as const)('handles CAS-lost PENDING to %s SENT with the same integrity rule', async (_label, providerRef, accepted) => {
    const db = new SqliteD1();
    db.migrate();
    await seedEligible(db);
    const env = makeEnv(db);
    env.hooks = {
      beforeAbandonedOutboundConvergence: async innerEnv => {
        await innerEnv.DB.prepare(
          `UPDATE outbound_operations
           SET status = 'SENT', provider_message_ref = ?
           WHERE id = ? AND status = 'PENDING'`
        ).bind(providerRef, `ai_reply:${EVENT_ID}`).run();
      }
    };
    const abandonedEvent = {
      version: 1 as const,
      source: 'internal' as const,
      type: 'ai_trigger' as const,
      eventId: EVENT_ID,
      payload: { convId: CONVERSATION_ID, messageId: MESSAGE_REF }
    };

    const convergence = convergeAbandonedAiOutboundOperations(
      env, abandonedEvent, 'CANCELLED_BY_HANDOFF'
    );
    if (accepted) await expect(convergence).resolves.toEqual({ changed: 0 });
    else await expect(convergence).rejects.toMatchObject({ code: 'OUTBOUND_PRECONDITION_FAILED' });

    expect((await db.prepare('SELECT status, provider_message_ref FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>())).toMatchObject({
      status: 'SENT', provider_message_ref: providerRef
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS c FROM reliability_audit WHERE action = 'AI_HANDOFF_CANCELLED'"
    ).first<any>()).c).toBe(0);
    db.close();
  });
});
