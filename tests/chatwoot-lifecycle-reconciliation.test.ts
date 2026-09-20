import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import { ChatwootLifecycleEvent } from '../src/core/events';
import { resolveOutboundDomainState } from '../src/core/outbound-domain-resolution';
import { buildTelegramTargetEvidence } from '../src/core/outbound-evidence';
import { manualRetryOutboundOperation } from '../src/core/outbound-manual-retry';
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

async function seedLifecycleOperation(
  db: SqliteD1,
  env: Env,
  status: 'SENT' | 'SENDING' | 'AMBIGUOUS' | 'FAILED_FINAL',
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
    status === 'SENDING' ? Math.floor(Date.now() / 1000) : 1,
    JSON.stringify(buildTelegramTargetEvidence(env, '-1001', '77', method)),
    sequence,
    sequence
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
    let releaseClose!: () => void;
    const closeReleased = new Promise<void>(resolve => { releaseClose = resolve; });
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>(resolve => { markCloseStarted = resolve; });
    mockProviders(() => providerStatus, telegramMethods, async method => {
      if (method === 'closeForumTopic') {
        markCloseStarted();
        await closeReleased;
      }
    });

    const closing = processChatwootEvent(lifecycleEvent('concurrent-close', 'resolved'), env);
    await closeStarted;
    providerStatus = 'open';
    const opening = processChatwootEvent(lifecycleEvent('concurrent-open', 'open'), env);
    await opening;
    releaseClose();
    await closing;

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect(await conversationStatus(db)).toBe('OPEN');
    expect((await lifecycleOperations(db))).toHaveLength(2);
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
        await expect(result).resolves.toBeUndefined();
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
});
