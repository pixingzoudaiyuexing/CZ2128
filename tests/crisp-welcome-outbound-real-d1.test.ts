import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrispWelcomeConfig } from '../src/config/crisp-welcome';
import { buildCrispTargetEvidence } from '../src/core/outbound-evidence';
import {
  finalizeNeverStartedOutboundOperation,
  getOutboundOperation
} from '../src/core/outbound-operations';
import type { OutboundOperation } from '../src/core/domain';
import { handleQueueEvent } from '../src/queue/consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

const WEBSITE = 'website-1';
const SESSION = 'session-1';
const CONVERSATION = 'crisp-welcome-conv';
const OPERATION = `crisp_welcome:${CONVERSATION}`;

function d1WelcomeSnapshot(text = 'new runtime welcome', version = 2) {
  return {
    values: { CRISP_WELCOME_CONFIG: createCrispWelcomeConfig(text, true) },
    sources: { CRISP_WELCOME_CONFIG: 'D1' },
    versions: { CRISP_WELCOME_CONFIG: version },
    errors: {},
    overrideCount: 1,
    health: 'AVAILABLE'
  } as any;
}

function event(eventId = 'crisp:welcome-history') {
  return {
    version: 1,
    source: 'crisp',
    type: 'message_created',
    eventId,
    payload: {
      websiteRef: WEBSITE,
      sessionRef: SESSION,
      customerRef: 'visitor-1',
      messageRef: `message:${eventId}`,
      actorRole: 'CUSTOMER',
      content: 'Hello'
    }
  } as any;
}

function env(db: SqliteD1, snapshot = d1WelcomeSnapshot()) {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() },
    BOT_GROUP_ID: '-100',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    CRISP_API_IDENTIFIER: 'crisp-id',
    CRISP_API_KEY: 'crisp-key',
    CRISP_WELCOME_TEXT: 'old ENV welcome',
    runtimeConfigSnapshot: snapshot
  } as any;
}

function seedConversation(db: SqliteD1) {
  db.exec(`
    INSERT INTO conversations
    (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
     operator_channel, operator_thread_ref, operator_thread_status, ai_mode, ai_handoff_epoch,
     created_at, updated_at, version)
    VALUES ('${CONVERSATION}', 'crisp', '${WEBSITE}', '${SESSION}', 'visitor-1',
            'telegram', NULL, 'OPEN', 'ENABLED', 0, 1, 1, 1);
  `);
}

async function seedWelcomeOperation(
  db: SqliteD1,
  input: {
    status: OutboundOperation['status'];
    subjectRef?: string | null;
    attemptCount?: number;
    requestStartedAt?: number | null;
    responseObservedAt?: number | null;
    responseHttpStatus?: number | null;
    leaseUntil?: number | null;
    leaseToken?: string | null;
    providerMessageRef?: string | null;
    reconciliationStatus?: OutboundOperation['reconciliation_status'];
  }
) {
  const subjectRef = input.subjectRef === undefined
    ? `crisp-welcome:${CONVERSATION}`
    : input.subjectRef;
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, conversation_id, destination_provider, operation_type, status,
      provider_message_ref, attempt_count, lease_until, lease_token, last_error,
      created_at, updated_at, request_started_at, response_observed_at, response_http_status,
      reconciliation_status, subject_type, subject_ref, target_evidence_json)
     VALUES (?, ?, 'crisp', 'SEND_MESSAGE', ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    OPERATION,
    CONVERSATION,
    input.status,
    input.providerMessageRef ?? null,
    input.attemptCount ?? 0,
    input.leaseUntil ?? null,
    input.leaseToken ?? null,
    input.requestStartedAt ?? null,
    input.responseObservedAt ?? null,
    input.responseHttpStatus ?? null,
    input.reconciliationStatus ?? (input.status === 'AMBIGUOUS' ? 'PENDING' : 'NOT_REQUIRED'),
    subjectRef === null ? null : 'MESSAGE',
    subjectRef,
    JSON.stringify(buildCrispTargetEvidence(WEBSITE, SESSION))
  ).run();
}

async function seedMalformedHistory(db: SqliteD1, version = 1) {
  await db.prepare(
    `INSERT INTO runtime_config_history
     (key, version, value_kind, value_text, ciphertext, nonce, is_deleted,
      actor_user_id, action, source_update_id, created_at)
     VALUES ('CRISP_WELCOME_CONFIG', ?, 'PLAIN', ?, NULL, NULL, 0, 'admin', 'SET', 'seed', 1)`
  ).bind(version, '{"version":1,"enabled":true,"text":""}').run();
}

function mockTelegramOnly() {
  let messageId = 100;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url.includes('api.telegram.org') && url.endsWith('/createForumTopic')) {
      return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 77 } }), { status: 200 });
    }
    if (url.includes('api.telegram.org') && url.endsWith('/sendMessage')) {
      messageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  });
}

async function receipt(db: SqliteD1, eventId: string) {
  return db.prepare(
    `SELECT status, attempt_count, last_error
     FROM event_receipts WHERE source = 'crisp' AND source_event_ref = ?`
  ).bind(eventId).first<any>();
}

async function operation(db: SqliteD1) {
  return db.prepare(
    `SELECT status, provider_message_ref, attempt_count, lease_until, lease_token,
            request_started_at, response_observed_at, response_http_status,
            reconciliation_status, last_error
     FROM outbound_operations WHERE id = ?`
  ).bind(OPERATION).first<any>();
}

describe('Crisp Welcome historical outbound settlement on real local D1', () => {
  const databases: SqliteD1[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) db.close();
  });

  function setup() {
    const db = new SqliteD1();
    db.migrate();
    databases.push(db);
    seedConversation(db);
    return db;
  }

  it('finalizes a never-started legacy PENDING Welcome without sending it and completes the event', async () => {
    const db = setup();
    await seedWelcomeOperation(db, { status: 'PENDING' });
    const fetchMock = mockTelegramOnly();
    const e = event('crisp:legacy-pending');

    await handleQueueEvent(e, env(db));

    expect(await operation(db)).toMatchObject({
      status: 'FAILED_FINAL',
      attempt_count: 0,
      request_started_at: null,
      provider_message_ref: null,
      last_error: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(await receipt(db, e.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 1 });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit
       WHERE entity_id = ? AND action = 'CRISP_WELCOME_UNSENT_FINALIZED'
         AND reason_code = 'CRISP_WELCOME_LEGACY_CONFIG_CHANGED'`
    ).bind(OPERATION).first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare(
      `SELECT status FROM outbound_operations WHERE id = ?`
    ).bind(`send_tg_crisp_message:${e.eventId}`).first<any>())?.status).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('finalizes a migrated never-started FAILED_RETRYABLE Welcome but not one that crossed requestStarted', async () => {
    const safeDb = setup();
    await seedWelcomeOperation(safeDb, { status: 'FAILED_RETRYABLE', attemptCount: 0 });
    const safeFetch = mockTelegramOnly();
    const safeEvent = event('crisp:legacy-retry-safe');
    await handleQueueEvent(safeEvent, env(safeDb));
    expect(await operation(safeDb)).toMatchObject({
      status: 'FAILED_FINAL',
      attempt_count: 0,
      request_started_at: null
    });
    expect(await receipt(safeDb, safeEvent.eventId)).toMatchObject({ status: 'PROCESSED' });
    safeFetch.mockRestore();

    const unsafeDb = setup();
    await seedWelcomeOperation(unsafeDb, {
      status: 'FAILED_RETRYABLE',
      attemptCount: 1,
      requestStartedAt: 10,
      responseObservedAt: 11,
      responseHttpStatus: 429
    });
    const unsafeFetch = mockTelegramOnly();
    const unsafeEvent = event('crisp:legacy-retry-started');
    await expect(handleQueueEvent(unsafeEvent, env(unsafeDb))).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(await operation(unsafeDb)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      attempt_count: 1,
      request_started_at: 10,
      response_observed_at: 11,
      response_http_status: 429
    });
    expect(await receipt(unsafeDb, unsafeEvent.eventId)).toMatchObject({
      status: 'FAILED',
      attempt_count: 1,
      last_error: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(unsafeFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing', false],
    ['malformed', true]
  ] as const)('safely closes a PENDING versioned Welcome when history is %s', async (_label, malformed) => {
    const db = setup();
    await seedWelcomeOperation(db, { status: 'PENDING', subjectRef: 'crisp-welcome:v1' });
    if (malformed) await seedMalformedHistory(db, 1);
    mockTelegramOnly();
    const e = event(`crisp:history-${_label}`);

    await handleQueueEvent(e, env(db, d1WelcomeSnapshot('new welcome', 2)));

    expect(await operation(db)).toMatchObject({
      status: 'FAILED_FINAL',
      attempt_count: 0,
      request_started_at: null,
      last_error: 'OUTBOUND_PRECONDITION_FAILED'
    });
    expect(await receipt(db, e.eventId)).toMatchObject({ status: 'PROCESSED' });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit
       WHERE entity_id = ? AND reason_code = 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'`
    ).bind(OPERATION).first<{ count: number }>())?.count).toBe(1);
  });

  it('keeps active and expired SENDING Welcome rows unchanged and the same event receipt unresolved', async () => {
    for (const [label, leaseUntil] of [
      ['active', Math.floor(Date.now() / 1000) + 300],
      ['expired', Math.floor(Date.now() / 1000) - 1]
    ] as const) {
      const db = setup();
      await seedWelcomeOperation(db, {
        status: 'SENDING',
        attemptCount: 0,
        leaseUntil,
        leaseToken: `v2:${label}`
      });
      const fetchMock = mockTelegramOnly();
      const e = event(`crisp:sending-${label}`);
      const testEnv = env(db);

      await expect(handleQueueEvent(e, testEnv)).rejects.toMatchObject({
        message: 'OUTBOUND_PRECONDITION_FAILED'
      });
      expect(await operation(db)).toMatchObject({
        status: 'SENDING',
        lease_until: leaseUntil,
        lease_token: `v2:${label}`,
        request_started_at: null
      });
      expect(await receipt(db, e.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 1 });

      await expect(handleQueueEvent(e, testEnv)).rejects.toMatchObject({
        message: 'OUTBOUND_PRECONDITION_FAILED'
      });
      expect(await receipt(db, e.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 2 });
      expect(await operation(db)).toMatchObject({
        status: 'SENDING',
        lease_until: leaseUntil,
        lease_token: `v2:${label}`
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockRestore();
    }
  });

  it('preserves AMBIGUOUS Welcome evidence and never turns a retry into a processed event', async () => {
    const db = setup();
    await seedWelcomeOperation(db, {
      status: 'AMBIGUOUS',
      attemptCount: 1,
      requestStartedAt: 10,
      reconciliationStatus: 'PENDING'
    });
    const fetchMock = mockTelegramOnly();
    const e = event('crisp:ambiguous-welcome');
    const testEnv = env(db);

    await expect(handleQueueEvent(e, testEnv)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });
    await expect(handleQueueEvent(e, testEnv)).rejects.toMatchObject({
      message: 'OUTBOUND_PRECONDITION_FAILED'
    });

    expect(await operation(db)).toMatchObject({
      status: 'AMBIGUOUS',
      attempt_count: 1,
      request_started_at: 10,
      reconciliation_status: 'PENDING'
    });
    expect(await receipt(db, e.eventId)).toMatchObject({ status: 'FAILED', attempt_count: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves an already SENT legacy Welcome and completes the event without another Crisp request', async () => {
    const db = setup();
    await seedWelcomeOperation(db, {
      status: 'SENT',
      attemptCount: 1,
      requestStartedAt: 10,
      responseObservedAt: 11,
      responseHttpStatus: 200,
      providerMessageRef: 'crisp-message-1'
    });
    const fetchMock = mockTelegramOnly();
    const e = event('crisp:sent-welcome');

    await handleQueueEvent(e, env(db));

    expect(await operation(db)).toMatchObject({
      status: 'SENT',
      provider_message_ref: 'crisp-message-1',
      attempt_count: 1,
      request_started_at: 10
    });
    expect(await receipt(db, e.eventId)).toMatchObject({ status: 'PROCESSED', attempt_count: 1 });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit WHERE entity_id = ?`
    ).bind(OPERATION).first<{ count: number }>())?.count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads real D1 state after a zero-row finalization CAS and preserves concurrent SENT', async () => {
    const db = setup();
    await seedWelcomeOperation(db, { status: 'PENDING' });
    const expected = await getOutboundOperation(env(db), OPERATION);
    if (!expected) throw new Error('Expected Welcome operation');

    await db.prepare(
      `UPDATE outbound_operations
       SET status = 'SENT', provider_message_ref = 'concurrent-message',
           attempt_count = 1, request_started_at = 10, response_observed_at = 11,
           response_http_status = 200, updated_at = 2
       WHERE id = ?`
    ).bind(OPERATION).run();

    const result = await finalizeNeverStartedOutboundOperation(
      env(db),
      expected,
      'OUTBOUND_PRECONDITION_FAILED',
      {
        id: 'cas-audit',
        action: 'CRISP_WELCOME_UNSENT_FINALIZED',
        actorRef: 'system:crisp-welcome',
        reasonCode: 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'
      }
    );

    expect(result.changed).toBe(false);
    expect(result.operation).toMatchObject({
      status: 'SENT',
      provider_message_ref: 'concurrent-message',
      attempt_count: 1,
      request_started_at: 10
    });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit WHERE id = 'cas-audit'`
    ).first<{ count: number }>())?.count).toBe(0);
  });
});
