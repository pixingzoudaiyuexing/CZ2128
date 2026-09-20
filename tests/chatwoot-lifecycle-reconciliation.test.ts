import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import { closeTelegramTopic, reopenTelegramTopic } from '../src/adapters/telegram/api';
import { ChatwootLifecycleEvent } from '../src/core/events';
import { resolveOutboundDomainState } from '../src/core/outbound-domain-resolution';
import { buildTelegramTargetEvidence } from '../src/core/outbound-evidence';
import { manualRetryOutboundOperation } from '../src/core/outbound-manual-retry';
import { executeOutboundOperation } from '../src/core/outbound-operations';
import { handleQueueEvent } from '../src/queue/consumer';
import { processChatwootEvent } from '../src/queue/chatwoot-handler';
import { SqliteD1 } from './helpers/sqlite-d1';

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CHATWOOT_WEBHOOK_SECRET: 'webhook-secret',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    CHATWOOT_API_URL: 'https://chatwoot.example',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    ATTACHMENTS_BUCKET: {} as any,
    DLQ_QUARANTINE: {} as any
  };
}

async function seedConversation(db: SqliteD1, status: 'OPEN' | 'CLOSED'): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
     VALUES ('conv', 'chatwoot', '1', '2', '3', 'telegram', '77', ?, 1, 1, 1)`
  ).bind(status).run();
}

function lifecycleEvent(eventId: string, status: 'open' | 'resolved'): ChatwootLifecycleEvent {
  return {
    version: 1,
    eventId,
    source: 'chatwoot',
    type: 'conversation_status_changed',
    payload: { accountRef: '1', conversationRef: '2', status }
  };
}

async function conversationStatus(db: SqliteD1): Promise<string | undefined> {
  return (await db.prepare('SELECT operator_thread_status FROM conversations WHERE id = ?')
    .bind('conv').first<{ operator_thread_status: string }>())?.operator_thread_status;
}

async function lifecycleOperations(db: SqliteD1): Promise<any[]> {
  return (await db.prepare(
    `SELECT * FROM outbound_operations
     WHERE operation_type IN ('CLOSE_TOPIC', 'REOPEN_TOPIC') ORDER BY id`
  ).all<any>()).results;
}

function mockProviders(
  status: () => 'open' | 'resolved',
  telegramMethods: string[],
  onTelegram?: (method: string) => Promise<void>
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url.startsWith('https://chatwoot.example/')) {
      return new Response(JSON.stringify({ id: 2, status: status() }), { status: 200 });
    }
    const method = url.split('/').at(-1) || '';
    telegramMethods.push(method);
    await onTelegram?.(method);
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function seedLifecycleOperation(
  db: SqliteD1,
  env: Env,
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED_RETRYABLE' | 'AMBIGUOUS' | 'FAILED_FINAL',
  target: 'OPEN' | 'CLOSED',
  sequence = 1
): Promise<string> {
  const operationType = target === 'CLOSED' ? 'CLOSE_TOPIC' : 'REOPEN_TOPIC';
  const method = target === 'CLOSED' ? 'closeForumTopic' : 'reopenForumTopic';
  const id = `topic_lifecycle_v2_conv_${String(sequence).padStart(8, '0')}_${target.toLowerCase()}`;
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, conversation_id, destination_provider, operation_type, status, attempt_count,
      lease_until, lease_token, request_started_at, reconciliation_status,
      subject_type, subject_ref, target_evidence_json, created_at, updated_at)
     VALUES (?, 'conv', 'telegram', ?, ?, 1, ?, ?, ?, 'NOT_REQUIRED',
             'CONVERSATION', 'conv', ?, ?, ?)`
  ).bind(
    id,
    operationType,
    status,
    status === 'SENDING' ? Math.floor(Date.now() / 1000) + 30 : null,
    status === 'SENDING' ? 'v2:active-lease' : null,
    status === 'SENDING' ? Math.floor(Date.now() / 1000) : status === 'PENDING' ? null : 1,
    JSON.stringify(buildTelegramTargetEvidence(env, '-1001', '77', method)),
    sequence,
    sequence
  ).run();
  return id;
}

async function seedLegacyLifecycleOperation(
  db: SqliteD1,
  env: Env,
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED_RETRYABLE' | 'AMBIGUOUS' | 'FAILED_FINAL',
  target: 'OPEN' | 'CLOSED',
  overrides: Partial<{
    id: string;
    parentOperationId: string | null;
    requestStartedAt: number | null;
    responseObservedAt: number | null;
    responseHttpStatus: number | null;
    leaseUntil: number | null;
    leaseToken: string | null;
    attemptCount: number;
    lastError: string | null;
  }> = {}
): Promise<string> {
  const operationType = target === 'CLOSED' ? 'CLOSE_TOPIC' : 'REOPEN_TOPIC';
  const method = target === 'CLOSED' ? 'closeForumTopic' : 'reopenForumTopic';
  const id = overrides.id || `legacy_${target.toLowerCase()}_${crypto.randomUUID()}`;
  const started = overrides.requestStartedAt === undefined
    ? (status === 'PENDING' ? null : 1)
    : overrides.requestStartedAt;
  const observed = overrides.responseObservedAt === undefined
    ? (['SENT', 'FAILED_RETRYABLE', 'FAILED_FINAL'].includes(status) ? 2 : null)
    : overrides.responseObservedAt;
  const httpStatus = overrides.responseHttpStatus === undefined
    ? (status === 'FAILED_RETRYABLE' ? 429 : status === 'FAILED_FINAL' ? 400 : status === 'SENT' ? 200 : null)
    : overrides.responseHttpStatus;
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, parent_operation_id, conversation_id, destination_provider, operation_type, status,
      attempt_count, lease_until, lease_token, request_started_at, response_observed_at,
      response_http_status, last_error, reconciliation_status, subject_type, subject_ref,
      target_evidence_json, created_at, updated_at)
     VALUES (?, ?, 'conv', 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'CONVERSATION', 'conv', ?, 1, 1)`
  ).bind(
    id,
    overrides.parentOperationId ?? null,
    operationType,
    status,
    overrides.attemptCount ?? (status === 'PENDING' ? 0 : 1),
    overrides.leaseUntil ?? (status === 'SENDING' ? Math.floor(Date.now() / 1000) + 30 : null),
    overrides.leaseToken ?? (status === 'SENDING' ? 'v2:legacy-active' : null),
    started,
    observed,
    httpStatus,
    overrides.lastError === undefined
      ? (status === 'FAILED_RETRYABLE'
          ? 'OUTBOUND_RATE_LIMITED'
          : status === 'FAILED_FINAL'
            ? 'OUTBOUND_PROVIDER_4XX_FINAL'
            : null)
      : overrides.lastError,
    status === 'AMBIGUOUS' ? 'PENDING' : 'NOT_REQUIRED',
    JSON.stringify(buildTelegramTargetEvidence(env, '-1001', '77', method))
  ).run();
  return id;
}

describe('Chatwoot lifecycle reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not close for an old resolved event after Chatwoot is open', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const telegramCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://chatwoot.example/')) {
        return new Response(JSON.stringify({ id: 2, status: 'open' }), { status: 200 });
      }
      telegramCalls.push(url);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    await processChatwootEvent(lifecycleEvent('old-resolved', 'resolved'), makeEnv(db));

    expect(await conversationStatus(db)).toBe('OPEN');
    expect(telegramCalls).toEqual([]);
    db.close();
  });

  it('does not reopen for an old open event after Chatwoot is resolved', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'CLOSED');
    const telegramCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://chatwoot.example/')) {
        return new Response(JSON.stringify({ id: 2, status: 'resolved' }), { status: 200 });
      }
      telegramCalls.push(url);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    await processChatwootEvent(lifecycleEvent('old-open', 'open'), makeEnv(db));

    expect(await conversationStatus(db)).toBe('CLOSED');
    expect(telegramCalls).toEqual([]);
    db.close();
  });

  it('converges different event identities for the same closed and open states once each', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    let providerStatus: 'open' | 'resolved' = 'resolved';
    const telegramMethods: string[] = [];
    mockProviders(() => providerStatus, telegramMethods);

    await processChatwootEvent(lifecycleEvent('close-1', 'resolved'), env);
    await processChatwootEvent(lifecycleEvent('close-2', 'resolved'), env);
    providerStatus = 'open';
    await processChatwootEvent(lifecycleEvent('open-1', 'open'), env);
    await processChatwootEvent(lifecycleEvent('open-2', 'open'), env);

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect((await lifecycleOperations(db)).map(operation => operation.operation_type))
      .toEqual(['CLOSE_TOPIC', 'REOPEN_TOPIC']);
    expect(await conversationStatus(db)).toBe('OPEN');
    db.close();
  });

  it('deduplicates the same close and reopen identities at the event receipt', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    let providerStatus: 'open' | 'resolved' = 'resolved';
    const telegramMethods: string[] = [];
    mockProviders(() => providerStatus, telegramMethods);
    const close = lifecycleEvent('same-close', 'resolved');

    await handleQueueEvent(close, env);
    await handleQueueEvent(close, env);
    providerStatus = 'open';
    const reopen = lifecycleEvent('same-reopen', 'open');
    await handleQueueEvent(reopen, env);
    await handleQueueEvent(reopen, env);

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    const receipts = (await db.prepare(
      `SELECT source_event_ref, status, attempt_count FROM event_receipts ORDER BY source_event_ref`
    ).all<any>()).results;
    expect(receipts).toEqual([
      { source_event_ref: 'same-close', status: 'PROCESSED', attempt_count: 1 },
      { source_event_ref: 'same-reopen', status: 'PROCESSED', attempt_count: 1 }
    ]);
    db.close();
  });

  it('rechecks Chatwoot and compensates when status changes during a close request', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    let providerStatus: 'open' | 'resolved' = 'resolved';
    const telegramMethods: string[] = [];
    mockProviders(() => providerStatus, telegramMethods, async method => {
      if (method === 'closeForumTopic') providerStatus = 'open';
    });

    await processChatwootEvent(lifecycleEvent('close-race', 'resolved'), env);

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect(await conversationStatus(db)).toBe('OPEN');
    expect((await lifecycleOperations(db))).toHaveLength(2);
    db.close();
  });

  it('serializes opposite events while a close request is in flight', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    let providerStatus: 'open' | 'resolved' = 'resolved';
    const telegramMethods: string[] = [];
    const providerOrder: string[] = [];
    let releaseClose!: () => void;
    const closeReleased = new Promise<void>(resolve => { releaseClose = resolve; });
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>(resolve => { markCloseStarted = resolve; });
    mockProviders(() => providerStatus, telegramMethods, async method => {
      if (method === 'closeForumTopic') {
        providerOrder.push('close-started');
        markCloseStarted();
        await closeReleased;
        providerOrder.push('close-completed');
      } else if (method === 'reopenForumTopic') {
        providerOrder.push('reopen-started', 'reopen-completed');
      }
    });

    const closing = processChatwootEvent(lifecycleEvent('concurrent-close', 'resolved'), env);
    await closeStarted;
    providerStatus = 'open';
    const opening = processChatwootEvent(lifecycleEvent('concurrent-open', 'open'), env);
    await expect(opening).rejects.toMatchObject({ code: 'CONCURRENCY_LEASE_HELD' });
    releaseClose();
    await closing;

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect(providerOrder).toEqual([
      'close-started',
      'close-completed',
      'reopen-started',
      'reopen-completed'
    ]);
    expect(await conversationStatus(db)).toBe('OPEN');
    expect((await lifecycleOperations(db))).toHaveLength(2);
    db.close();
  });

  it('atomically coordinates opposite targets that read the same lifecycle sequence', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const bothAtBoundary = deferred();
    const releaseBoundary = deferred();
    let arrivals = 0;
    env.hooks = {
      afterChatwootLifecycleSnapshot: async () => {
        arrivals += 1;
        if (arrivals === 2) bothAtBoundary.resolve();
        await releaseBoundary.promise;
      }
    };
    const telegramMethods: string[] = [];
    const statuses: Array<'resolved' | 'open'> = ['resolved', 'open'];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://chatwoot.example/')) {
        return new Response(JSON.stringify({ status: statuses.shift() || 'open' }), { status: 200 });
      }
      telegramMethods.push(url.split('/').at(-1) || '');
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    const closing = processChatwootEvent(lifecycleEvent('same-sequence-close', 'resolved'), env);
    await vi.waitFor(() => expect(arrivals).toBe(1));
    await db.prepare("UPDATE conversations SET operator_thread_status = 'CLOSED' WHERE id = 'conv'").run();
    const opening = processChatwootEvent(lifecycleEvent('same-sequence-open', 'open'), env);
    await bothAtBoundary.promise;
    releaseBoundary.resolve();
    await Promise.allSettled([closing, opening]);

    const operations = await lifecycleOperations(db);
    expect(operations.map(operation => operation.id)).toEqual([
      'topic_lifecycle_v2_conv_00000001',
      'topic_lifecycle_v2_conv_00000002'
    ]);
    expect(operations[0]).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND',
      attempt_count: 0,
      request_started_at: null
    });
    expect(telegramMethods).toHaveLength(1);
    expect(telegramMethods).toEqual(['reopenForumTopic']);
    expect(await conversationStatus(db)).toBe('OPEN');
    db.close();
  });

  it.each(['AMBIGUOUS', 'FAILED_FINAL'] as const)(
    'does not silently complete while a %s close can invalidate the apparent OPEN state',
    async operationStatus => {
      const db = new SqliteD1();
      db.migrate();
      await seedConversation(db, 'OPEN');
      const env = makeEnv(db);
      await seedLifecycleOperation(db, env, operationStatus, 'CLOSED');
      mockProviders(() => 'open', []);

      await expect(processChatwootEvent(
        lifecycleEvent(`blocked-${operationStatus}`, 'open'),
        env
      )).rejects.toMatchObject({
        code: operationStatus === 'AMBIGUOUS'
          ? 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED'
          : 'TOPIC_LIFECYCLE_FINAL_BLOCKED'
      });
      expect(await conversationStatus(db)).toBe('OPEN');
      db.close();
    }
  );

  it.each([
    ['AMBIGUOUS', 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED'],
    ['FAILED_FINAL', 'TOPIC_LIFECYCLE_FINAL_BLOCKED']
  ] as const)('records managed %s as a failed Queue receipt with its exact boundary', async (status, code) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    await seedLifecycleOperation(db, env, status, 'CLOSED');
    mockProviders(() => 'resolved', []);
    const event = lifecycleEvent(`receipt-${status}`, 'resolved');

    await expect(handleQueueEvent(event, env)).rejects.toMatchObject({ code });

    expect(await db.prepare(
      `SELECT status, attempt_count, last_error FROM event_receipts
       WHERE source = 'chatwoot' AND source_event_ref = ?`
    ).bind(event.eventId).first<any>()).toEqual({
      status: 'FAILED',
      attempt_count: 1,
      last_error: code
    });
    db.close();
  });

  it.each([
    ['PENDING', null],
    ['FAILED_RETRYABLE', 'OUTBOUND_RATE_LIMITED']
  ] as const)('safely resumes %s using the same managed operation id', async (status, lastError) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const id = await seedLifecycleOperation(db, env, status, 'CLOSED');
    if (status === 'PENDING') {
      await db.prepare(
        `UPDATE outbound_operations SET attempt_count = 0, request_started_at = NULL WHERE id = ?`
      ).bind(id).run();
    } else {
      await db.prepare(
        `UPDATE outbound_operations
         SET last_error = ?, response_observed_at = 2, response_http_status = 429,
             next_retry_at = NULL WHERE id = ?`
      ).bind(lastError, id).run();
    }
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods);

    await processChatwootEvent(lifecycleEvent(`resume-${status}`, 'resolved'), env);

    expect(telegramMethods).toEqual(['closeForumTopic']);
    const operations = await lifecycleOperations(db);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id, status: 'SENT' });
    expect(await conversationStatus(db)).toBe('CLOSED');
    db.close();
  });

  it.each([
    ['pre-request final', null, null, null, 'OUTBOUND_PRECONDITION_FAILED'],
    ['definitive provider rejection', 1, 2, 400, 'OUTBOUND_PROVIDER_4XX_FINAL']
  ] as const)(
    'keeps %s FAILED_FINAL terminal without allocating a new id',
    async (_label, requestStartedAt, responseObservedAt, responseHttpStatus, lastError) => {
      const db = new SqliteD1();
      db.migrate();
      await seedConversation(db, 'OPEN');
      const env = makeEnv(db);
      const id = await seedLifecycleOperation(db, env, 'FAILED_FINAL', 'CLOSED');
      await db.prepare(
        `UPDATE outbound_operations
         SET request_started_at = ?, response_observed_at = ?, response_http_status = ?,
             last_error = ? WHERE id = ?`
      ).bind(requestStartedAt, responseObservedAt, responseHttpStatus, lastError, id).run();
      const telegramMethods: string[] = [];
      mockProviders(() => 'resolved', telegramMethods);

      await expect(processChatwootEvent(
        lifecycleEvent(`terminal-${_label}`, 'resolved'),
        env
      )).rejects.toMatchObject({ code: 'TOPIC_LIFECYCLE_FINAL_BLOCKED' });
      expect(telegramMethods).toEqual([]);
      expect(await lifecycleOperations(db)).toHaveLength(1);
      expect((await lifecycleOperations(db))[0]).toMatchObject({ id, status: 'FAILED_FINAL' });
      db.close();
    }
  );

  it('allows a new sequence only after a proven pre-send supersede and later state reversal', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const firstId = await seedLifecycleOperation(db, env, 'PENDING', 'CLOSED');
    await db.prepare(
      `UPDATE outbound_operations SET attempt_count = 0, request_started_at = NULL WHERE id = ?`
    ).bind(firstId).run();
    let providerStatus: 'open' | 'resolved' = 'open';
    const telegramMethods: string[] = [];
    mockProviders(() => providerStatus, telegramMethods);

    await processChatwootEvent(lifecycleEvent('supersede-close', 'open'), env);
    providerStatus = 'resolved';
    await processChatwootEvent(lifecycleEvent('new-close-cycle', 'resolved'), env);

    const operations = await lifecycleOperations(db);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      id: firstId,
      status: 'FAILED_FINAL',
      last_error: 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND',
      attempt_count: 0
    });
    expect(operations[1]).toMatchObject({
      id: 'topic_lifecycle_v2_conv_00000002',
      status: 'SENT',
      attempt_count: 1
    });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit
       WHERE entity_id = ? AND action = 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND'`
    ).bind(firstId).first<{ count: number }>())?.count).toBe(1);
    expect(telegramMethods).toEqual(['closeForumTopic']);
    expect(await conversationStatus(db)).toBe('CLOSED');
    db.close();
  });

  it('repairs state after an unrelated D1 version change during the provider request', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods, async method => {
      if (method === 'closeForumTopic') {
        await db.prepare('UPDATE conversations SET version = version + 1 WHERE id = ?').bind('conv').run();
      }
    });

    await processChatwootEvent(lifecycleEvent('version-race', 'resolved'), env);

    const conversation = await db.prepare(
      'SELECT operator_thread_status, version FROM conversations WHERE id = ?'
    ).bind('conv').first<any>();
    expect(conversation).toMatchObject({ operator_thread_status: 'CLOSED', version: 3 });
    expect(telegramMethods).toEqual(['closeForumTopic']);
    db.close();
  });

  it('repairs a SENT operation after D1 domain persistence fails without resending', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods);
    const originalBatch = db.batch.bind(db);
    let failDomainBatch = true;
    db.batch = (async statements => {
      if (failDomainBatch) {
        failDomainBatch = false;
        throw new Error('synthetic D1 domain persistence failure');
      }
      return originalBatch(statements);
    }) as typeof db.batch;

    await expect(processChatwootEvent(lifecycleEvent('persist-failure', 'resolved'), env))
      .rejects.toThrow('synthetic D1 domain persistence failure');
    expect(telegramMethods).toEqual(['closeForumTopic']);
    expect(await conversationStatus(db)).toBe('OPEN');
    expect((await lifecycleOperations(db))[0]).toMatchObject({ status: 'SENT', attempt_count: 1 });

    await processChatwootEvent(lifecycleEvent('persist-retry', 'resolved'), env);
    expect(telegramMethods).toEqual(['closeForumTopic']);
    expect(await conversationStatus(db)).toBe('CLOSED');
    db.close();
  });

  it.each([
    ['query failure', () => Promise.reject(new Error('private transport detail')), 'CHATWOOT_STATE_READ_FAILED'],
    ['malformed response', () => Promise.resolve(new Response(JSON.stringify({ status: 'pending' }), { status: 200 })), 'CHATWOOT_STATE_INVALID']
  ])('fails closed on Chatwoot %s', async (_label, chatwootResponse, code) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const telegramCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).startsWith('https://chatwoot.example/')) return chatwootResponse();
      telegramCalls.push(String(input));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    await expect(processChatwootEvent(lifecycleEvent('query-failure', 'resolved'), makeEnv(db)))
      .rejects.toMatchObject({ code });
    expect(telegramCalls).toEqual([]);
    expect(await conversationStatus(db)).toBe('OPEN');
    db.close();
  });

  it.each(['SENDING', 'AMBIGUOUS', 'FAILED_FINAL'] as const)(
    'does not re-execute an existing %s lifecycle operation',
    async operationStatus => {
      const db = new SqliteD1();
      db.migrate();
      await seedConversation(db, 'OPEN');
      const env = makeEnv(db);
      await seedLifecycleOperation(db, env, operationStatus, 'CLOSED');
      const telegramMethods: string[] = [];
      mockProviders(() => 'resolved', telegramMethods);

      const result = processChatwootEvent(lifecycleEvent(`existing-${operationStatus}`, 'resolved'), env);
      if (operationStatus === 'SENDING') {
        await expect(result).rejects.toMatchObject({ code: 'CONCURRENCY_LEASE_HELD' });
      } else {
        await expect(result).rejects.toMatchObject({
          code: operationStatus === 'AMBIGUOUS'
            ? 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED'
            : 'TOPIC_LIFECYCLE_FINAL_BLOCKED'
        });
      }
      expect(telegramMethods).toEqual([]);
      expect(await conversationStatus(db)).toBe('OPEN');
      db.close();
    }
  );

  it('repairs an existing SENT operation without repeating its Provider action', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    await seedLifecycleOperation(db, env, 'SENT', 'CLOSED');
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods);

    await processChatwootEvent(lifecycleEvent('existing-sent', 'resolved'), env);

    expect(telegramMethods).toEqual([]);
    expect(await conversationStatus(db)).toBe('CLOSED');
    db.close();
  });

  it('repairs a SENT manual-retry child without replaying its ambiguous parent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const parentId = await seedLifecycleOperation(db, env, 'AMBIGUOUS', 'CLOSED');
    await db.prepare(
      `UPDATE outbound_operations SET reconciliation_status = 'MANUAL_RETRY_CREATED' WHERE id = ?`
    ).bind(parentId).run();
    await db.prepare(
      `INSERT INTO outbound_operations
       (id, parent_operation_id, conversation_id, destination_provider, operation_type, status,
        attempt_count, request_started_at, reconciliation_status, subject_type, subject_ref,
        target_evidence_json, created_at, updated_at)
       SELECT 'manual-retry-sent-close', id, conversation_id, destination_provider, operation_type,
              'SENT', 1, 1, 'NOT_REQUIRED', subject_type, subject_ref, target_evidence_json, 2, 2
       FROM outbound_operations WHERE id = ?`
    ).bind(parentId).run();
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods);

    await processChatwootEvent(lifecycleEvent('repair-child', 'resolved'), env);

    expect(telegramMethods).toEqual([]);
    expect(await conversationStatus(db)).toBe('CLOSED');
    db.close();
  });

  it('does not let an older delivered lifecycle operation overwrite a newer one', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const closeId = await seedLifecycleOperation(db, env, 'SENT', 'CLOSED', 1);
    const reopenId = await seedLifecycleOperation(db, env, 'SENT', 'OPEN', 2);
    await db.prepare(
      `INSERT INTO outbound_operations
       (id, parent_operation_id, conversation_id, destination_provider, operation_type, status,
        attempt_count, request_started_at, reconciliation_status, subject_type, subject_ref,
        target_evidence_json, created_at, updated_at)
       SELECT 'manual-retry-old-close', id, conversation_id, destination_provider, operation_type,
              'SENT', 1, 1, 'NOT_REQUIRED', subject_type, subject_ref, target_evidence_json, 3, 3
       FROM outbound_operations WHERE id = ?`
    ).bind(closeId).run();
    await db.prepare("UPDATE conversations SET operator_thread_status = 'OPEN' WHERE id = 'conv'").run();

    await expect(resolveOutboundDomainState(env, closeId)).resolves.toEqual({
      changed: false,
      domain: 'CONVERSATION'
    });
    await expect(resolveOutboundDomainState(env, 'manual-retry-old-close')).resolves.toEqual({
      changed: false,
      domain: 'CONVERSATION'
    });
    await expect(resolveOutboundDomainState(env, reopenId)).resolves.toEqual({
      changed: false,
      domain: 'CONVERSATION'
    });
    expect(await conversationStatus(db)).toBe('OPEN');
    db.close();
  });

  it('rejects manual retry of a managed lifecycle operation before Provider dispatch', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const closeId = await seedLifecycleOperation(db, env, 'AMBIGUOUS', 'CLOSED', 1);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env,
      closeId,
      { type: 'ADMIN', ref: '42' },
      'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('cancels a legacy PENDING operation before it can cross the Provider boundary', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const legacyId = await seedLegacyLifecycleOperation(db, env, 'PENDING', 'CLOSED', {
      id: 'close_topic_conv_legacy_pending'
    });
    const telegramMethods: string[] = [];
    mockProviders(() => 'open', telegramMethods);

    await processChatwootEvent(lifecycleEvent('legacy-pending', 'open'), env);

    expect(telegramMethods).toEqual([]);
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(legacyId).first<any>()).toEqual({
      status: 'FAILED_FINAL',
      last_error: 'TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND'
    });
    db.close();
  });

  it('repairs one legacy SENT operation before entering managed lifecycle mode', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const legacyId = await seedLegacyLifecycleOperation(db, env, 'SENT', 'CLOSED', {
      id: 'close_topic_conv_legacy_sent'
    });
    mockProviders(() => 'resolved', []);

    await processChatwootEvent(lifecycleEvent('legacy-sent', 'resolved'), env);

    expect(await conversationStatus(db)).toBe('CLOSED');
    expect(await lifecycleOperations(db)).toHaveLength(1);
    expect((await lifecycleOperations(db))[0].id).toBe(legacyId);
    db.close();
  });

  it.each(['AMBIGUOUS', 'FAILED_FINAL'] as const)(
    'keeps legacy %s history at an explicit manual boundary',
    async status => {
      const db = new SqliteD1();
      db.migrate();
      await seedConversation(db, 'OPEN');
      const env = makeEnv(db);
      await seedLegacyLifecycleOperation(db, env, status, 'CLOSED', {
        id: `close_topic_conv_legacy_${status.toLowerCase()}`,
        ...(status === 'FAILED_FINAL' ? { requestStartedAt: null, responseObservedAt: null, responseHttpStatus: null } : {})
      });
      mockProviders(() => 'resolved', []);

      await expect(processChatwootEvent(
        lifecycleEvent(`legacy-${status}`, 'resolved'),
        env
      )).rejects.toMatchObject({
        code: status === 'AMBIGUOUS'
          ? 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED'
          : 'TOPIC_LIFECYCLE_FINAL_BLOCKED'
      });
      expect(await conversationStatus(db)).toBe('OPEN');
      db.close();
    }
  );

  it('converts an expired started legacy SENDING operation to AMBIGUOUS without resending', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const id = await seedLegacyLifecycleOperation(db, env, 'SENDING', 'CLOSED', {
      id: 'close_topic_conv_legacy_expired',
      requestStartedAt: 1,
      leaseUntil: 1,
      leaseToken: 'v2:expired-owner'
    });
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods);

    await expect(processChatwootEvent(
      lifecycleEvent('legacy-expired-started', 'resolved'),
      env
    )).rejects.toMatchObject({ code: 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED' });

    expect(telegramMethods).toEqual([]);
    expect(await db.prepare(
      'SELECT status, last_error, lease_until, lease_token FROM outbound_operations WHERE id = ?'
    ).bind(id).first<any>()).toEqual({
      status: 'AMBIGUOUS',
      last_error: 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED',
      lease_until: null,
      lease_token: null
    });
    db.close();
  });

  it('fences a legacy child SENT repair after managed lifecycle has started', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const rootId = await seedLegacyLifecycleOperation(db, env, 'AMBIGUOUS', 'CLOSED', {
      id: 'close_topic_conv_legacy_root'
    });
    const childId = await seedLegacyLifecycleOperation(db, env, 'SENT', 'CLOSED', {
      id: 'manual_retry_legacy_close',
      parentOperationId: rootId
    });
    await seedLifecycleOperation(db, env, 'SENT', 'OPEN', 1);

    await expect(resolveOutboundDomainState(env, childId)).resolves.toEqual({
      changed: false,
      domain: 'CONVERSATION'
    });
    expect(await conversationStatus(db)).toBe('OPEN');
    db.close();
  });

  it('compensates after a legacy close finishes later than a managed reopen', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'OPEN');
    const env = makeEnv(db);
    const providerStarts: string[] = [];
    const completionOrder: string[] = [];
    let reopenCount = 0;
    const closeStarted = deferred();
    const releaseClose = deferred();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://chatwoot.example/')) {
        return new Response(JSON.stringify({ status: 'open' }), { status: 200 });
      }
      const method = url.split('/').at(-1) || '';
      if (method === 'closeForumTopic') {
        providerStarts.push('legacy-close');
        closeStarted.resolve();
        await releaseClose.promise;
        completionOrder.push('legacy-close');
      } else if (method === 'reopenForumTopic') {
        reopenCount += 1;
        const label = reopenCount === 1 ? 'managed-reopen' : 'managed-reopen-compensation';
        providerStarts.push(label);
        completionOrder.push(label);
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    const legacyId = 'close_topic_conv_inflight';
    const legacyExecution = executeOutboundOperation(
      env,
      'conv',
      'telegram',
      'CLOSE_TOPIC',
      async (_operationId, lifecycle) => {
        await closeTelegramTopic(env, '-1001', '77', lifecycle);
        return {};
      },
      legacyId,
      {
        subject: { type: 'CONVERSATION', ref: 'conv' },
        targetEvidence: buildTelegramTargetEvidence(env, '-1001', '77', 'closeForumTopic')
      }
    );
    await closeStarted.promise;
    await executeOutboundOperation(
      env,
      'conv',
      'telegram',
      'REOPEN_TOPIC',
      async (_operationId, lifecycle) => {
        await reopenTelegramTopic(env, '-1001', '77', lifecycle);
        return {};
      },
      'topic_lifecycle_v2_conv_00000001',
      {
        subject: { type: 'CONVERSATION', ref: 'conv' },
        targetEvidence: buildTelegramTargetEvidence(env, '-1001', '77', 'reopenForumTopic')
      }
    );

    await expect(processChatwootEvent(lifecycleEvent('legacy-inflight-blocked', 'open'), env))
      .rejects.toMatchObject({ code: 'CONCURRENCY_LEASE_HELD' });
    releaseClose.resolve();
    await legacyExecution;
    await processChatwootEvent(lifecycleEvent('legacy-inflight-compensate', 'open'), env);

    expect(providerStarts).toEqual([
      'legacy-close',
      'managed-reopen',
      'managed-reopen-compensation'
    ]);
    expect(completionOrder).toEqual([
      'managed-reopen',
      'legacy-close',
      'managed-reopen-compensation'
    ]);
    const managed = (await lifecycleOperations(db)).filter(operation =>
      operation.id.startsWith('topic_lifecycle_v2_')
    );
    expect(managed).toHaveLength(2);
    expect(managed[1]).toMatchObject({
      operation_type: 'REOPEN_TOPIC',
      status: 'SENT',
      parent_operation_id: legacyId,
      attempt_count: 1
    });
    expect(await conversationStatus(db)).toBe('OPEN');
    db.close();
  });
});
