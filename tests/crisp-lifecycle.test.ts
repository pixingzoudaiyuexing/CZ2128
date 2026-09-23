import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import { CrispLifecycleEvent, CrispMessageEvent } from '../src/core/events';
import { handleQueueEvent } from '../src/queue/consumer';
import { processCrispEvent } from '../src/queue/crisp-handler';
import { SqliteD1 } from './helpers/sqlite-d1';

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CHATWOOT_WEBHOOK_SECRET: 'chatwoot-secret',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    CHATWOOT_API_URL: 'https://chatwoot.example',
    CRISP_API_IDENTIFIER: 'identifier',
    CRISP_API_KEY: 'key',
    CRISP_WEBSITE_ID: 'website-1',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    ATTACHMENTS_BUCKET: {} as any,
    DLQ_QUARANTINE: {} as any
  };
}

async function seedConversation(
  db: SqliteD1,
  id = 'conv',
  websiteRef = 'website-1',
  sessionRef = 'session-1',
  status: 'OPEN' | 'CLOSED' = 'OPEN',
  aiMode: 'ENABLED' | 'PAUSED_OPERATOR' | 'PAUSED_MANUAL' = 'ENABLED',
  handoffEpoch = 0,
  threadRef = '77'
): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, operator_thread_status, ai_mode, ai_handoff_epoch,
      created_at, updated_at, version)
     VALUES (?, 'crisp', ?, ?, 'visitor', 'telegram', ?, ?, ?, ?, 1, 1, 1)`
  ).bind(id, websiteRef, sessionRef, threadRef, status, aiMode, handoffEpoch).run();
}

function lifecycleEvent(
  eventId: string,
  state: 'pending' | 'unresolved' | 'resolved',
  websiteRef = 'website-1',
  sessionRef = 'session-1'
): CrispLifecycleEvent {
  return {
    version: 1,
    source: 'crisp',
    type: 'conversation_state_changed',
    eventId,
    payload: {
      websiteRef,
      sessionRef,
      state,
      providerTimestamp: 1_790_000_000_000
    }
  };
}

function customerEvent(messageRef: string): CrispMessageEvent {
  return {
    version: 1,
    source: 'crisp',
    type: 'message_created',
    eventId: `crisp-message:${messageRef}`,
    payload: {
      websiteRef: 'website-1',
      sessionRef: 'session-1',
      customerRef: 'visitor',
      messageRef,
      actorRole: 'CUSTOMER',
      content: 'after reopen'
    }
  };
}

async function topicStatus(db: SqliteD1, id = 'conv'): Promise<string | undefined> {
  return (await db.prepare('SELECT operator_thread_status FROM conversations WHERE id = ?')
    .bind(id).first<{ operator_thread_status: string }>())?.operator_thread_status;
}

async function lifecycleOperations(db: SqliteD1, id = 'conv'): Promise<any[]> {
  return (await db.prepare(
    `SELECT * FROM outbound_operations
     WHERE conversation_id = ? AND operation_type IN ('CLOSE_TOPIC', 'REOPEN_TOPIC') ORDER BY id`
  ).bind(id).all<any>()).results;
}

function mockProviders(
  state: () => 'pending' | 'unresolved' | 'resolved',
  telegramMethods: string[],
  onTelegram?: (method: string) => Promise<void>
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url.startsWith('https://api.crisp.chat/') && url.endsWith('/state')) {
      return new Response(JSON.stringify({ data: { state: state() } }), { status: 200 });
    }
    const method = url.split('/').at(-1) || '';
    telegramMethods.push(method);
    await onTelegram?.(method);
    const result = method === 'sendMessage' ? { message_id: 9001 } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Crisp lifecycle reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses authoritative current state instead of an old resolved webhook', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const telegramMethods: string[] = [];
    mockProviders(() => 'unresolved', telegramMethods);

    await processCrispEvent(lifecycleEvent('old-resolved', 'resolved'), makeEnv(db));

    expect(telegramMethods).toEqual([]);
    expect(await topicStatus(db)).toBe('OPEN');
    expect(await lifecycleOperations(db)).toHaveLength(0);
    db.close();
  });

  it('closes and reopens the same Telegram topic once for duplicate state events', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    let providerState: 'unresolved' | 'resolved' = 'resolved';
    const telegramMethods: string[] = [];
    mockProviders(() => providerState, telegramMethods);

    const close = lifecycleEvent('crisp-close-same', 'resolved');
    await handleQueueEvent(close, env);
    await handleQueueEvent(close, env);
    await handleQueueEvent(lifecycleEvent('crisp-close-different', 'resolved'), env);
    expect(await topicStatus(db)).toBe('CLOSED');

    providerState = 'unresolved';
    const reopen = lifecycleEvent('crisp-reopen-same', 'unresolved');
    await handleQueueEvent(reopen, env);
    await handleQueueEvent(reopen, env);
    await handleQueueEvent(lifecycleEvent('crisp-reopen-different', 'unresolved'), env);
    await handleQueueEvent(lifecycleEvent('late-old-close', 'resolved'), env);

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect((await lifecycleOperations(db)).map(operation => operation.operation_type))
      .toEqual(['CLOSE_TOPIC', 'REOPEN_TOPIC']);
    const conversation = await db.prepare(
      'SELECT operator_thread_ref, operator_thread_status FROM conversations WHERE id = ?'
    ).bind('conv').first<any>();
    expect(conversation).toMatchObject({ operator_thread_ref: '77', operator_thread_status: 'OPEN' });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM outbound_operations WHERE conversation_id = ? AND operation_type = 'CREATE_TOPIC'"
    ).bind('conv').first<{ count: number }>())?.count).toBe(0);
    db.close();
  });

  it('compensates with reopen when Crisp changes state during Telegram close', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let providerState: 'unresolved' | 'resolved' = 'resolved';
    const telegramMethods: string[] = [];
    mockProviders(() => providerState, telegramMethods, async method => {
      if (method === 'closeForumTopic') providerState = 'unresolved';
    });

    await processCrispEvent(lifecycleEvent('close-race', 'resolved'), makeEnv(db));

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect(await topicStatus(db)).toBe('OPEN');
    expect(await lifecycleOperations(db)).toHaveLength(2);
    db.close();
  });

  it('fences an opposite event while close is in flight and lets the close owner compensate to current Crisp state', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    let providerState: 'unresolved' | 'resolved' = 'resolved';
    const closeStarted = deferred();
    const releaseClose = deferred();
    const telegramMethods: string[] = [];
    mockProviders(() => providerState, telegramMethods, async method => {
      if (method === 'closeForumTopic') {
        closeStarted.resolve();
        await releaseClose.promise;
      }
    });

    const closing = processCrispEvent(lifecycleEvent('concurrent-close', 'resolved'), env);
    await closeStarted.promise;
    providerState = 'unresolved';
    await expect(processCrispEvent(lifecycleEvent('concurrent-reopen', 'unresolved'), env))
      .rejects.toMatchObject({ code: 'CONCURRENCY_LEASE_HELD' });
    releaseClose.resolve();
    await closing;

    expect(telegramMethods).toEqual(['closeForumTopic', 'reopenForumTopic']);
    expect(await topicStatus(db)).toBe('OPEN');
    expect((await lifecycleOperations(db)).map(operation => operation.operation_type))
      .toEqual(['CLOSE_TOPIC', 'REOPEN_TOPIC']);
    db.close();
  });

  it('preserves AMBIGUOUS close evidence and never blindly resends it', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let telegramCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://api.crisp.chat/') && url.endsWith('/state')) {
        return new Response(JSON.stringify({ data: { state: 'resolved' } }), { status: 200 });
      }
      if (url.endsWith('/closeForumTopic')) {
        telegramCalls += 1;
        throw new Error('response lost after request');
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const env = makeEnv(db);

    await expect(processCrispEvent(lifecycleEvent('ambiguous-close-1', 'resolved'), env))
      .rejects.toMatchObject({ code: 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED' });
    await expect(processCrispEvent(lifecycleEvent('ambiguous-close-2', 'resolved'), env))
      .rejects.toMatchObject({ code: 'TOPIC_LIFECYCLE_RECONCILIATION_REQUIRED' });

    expect(telegramCalls).toBe(1);
    expect(await topicStatus(db)).toBe('OPEN');
    expect(await lifecycleOperations(db)).toHaveLength(1);
    expect((await lifecycleOperations(db))[0]).toMatchObject({
      status: 'AMBIGUOUS',
      reconciliation_status: 'PENDING'
    });
    db.close();
  });

  it('isolates lifecycle identity by Crisp website even when session ids match', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'conv-a', 'website-1', 'same-session');
    await seedConversation(db, 'conv-b', 'website-2', 'same-session', 'OPEN', 'ENABLED', 0, '78');
    const telegramMethods: string[] = [];
    mockProviders(() => 'resolved', telegramMethods);

    await processCrispEvent(
      lifecycleEvent('website-a-close', 'resolved', 'website-1', 'same-session'),
      makeEnv(db)
    );

    expect(await topicStatus(db, 'conv-a')).toBe('CLOSED');
    expect(await topicStatus(db, 'conv-b')).toBe('OPEN');
    expect(await lifecycleOperations(db, 'conv-a')).toHaveLength(1);
    expect(await lifecycleOperations(db, 'conv-b')).toHaveLength(0);
    db.close();
  });

  it('does not guess or create a topic for an unmapped lifecycle event', async () => {
    const db = new SqliteD1();
    db.migrate();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await processCrispEvent(lifecycleEvent('missing', 'resolved'), makeEnv(db));

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations')
      .first<{ count: number }>())?.count).toBe(0);
    db.close();
  });

  it('reopens a closed topic before forwarding a customer message that arrives first', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'conv', 'website-1', 'session-1', 'CLOSED');
    const telegramMethods: string[] = [];
    mockProviders(() => 'unresolved', telegramMethods);

    await processCrispEvent(customerEvent('customer-after-reopen'), makeEnv(db));

    expect(telegramMethods).toEqual(['reopenForumTopic', 'sendMessage']);
    expect(await topicStatus(db)).toBe('OPEN');
    const conversation = await db.prepare(
      'SELECT operator_thread_ref FROM conversations WHERE id = ?'
    ).bind('conv').first<any>();
    expect(conversation.operator_thread_ref).toBe('77');
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM outbound_operations WHERE conversation_id = ? AND operation_type = 'CREATE_TOPIC'"
    ).bind('conv').first<{ count: number }>())?.count).toBe(0);
    expect(await db.prepare(
      'SELECT status, provider_message_ref, response_http_status FROM outbound_operations WHERE id = ?'
    ).bind('send_tg_crisp_customer-after-reopen').first<any>()).toMatchObject({
      status: 'SENT',
      provider_message_ref: '9001',
      response_http_status: 200
    });
    db.close();
  });

  it('reopens the topic without changing a pre-existing AI pause or handoff epoch', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'conv', 'website-1', 'session-1', 'CLOSED', 'PAUSED_MANUAL', 4);
    mockProviders(() => 'pending', []);

    await processCrispEvent(lifecycleEvent('reopen-paused', 'pending'), makeEnv(db));

    const conversation = await db.prepare(
      'SELECT operator_thread_status, ai_mode, ai_handoff_epoch FROM conversations WHERE id = ?'
    ).bind('conv').first<any>();
    expect(conversation).toEqual({
      operator_thread_status: 'OPEN',
      ai_mode: 'PAUSED_MANUAL',
      ai_handoff_epoch: 4
    });
    db.close();
  });
});
