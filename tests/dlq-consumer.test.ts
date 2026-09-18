import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDlqMessage } from '../src/queue/dlq-consumer';
import { completeEventReceipt } from '../src/queue/consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

const sentinels = [
  'PRIVATE_DLQ_MESSAGE_BODY_123',
  'SUPER_SECRET_DLQ_TOKEN_456',
  'PRIVATE_CHATWOOT_URL_789',
  'PRIVATE_ATTACHMENT_ACCESS_TOKEN_ABC',
  'PRIVATE_AI_TEXT_DEF'
];

function message(id: string, body: unknown) {
  return { id, body } as Pick<Message<unknown>, 'id' | 'body'>;
}

function validChatwootEvent(eventId = 'event-1') {
  return {
    version: 1,
    source: 'chatwoot',
    type: 'message_created',
    eventId,
    payload: {
      accountRef: 'account-1',
      conversationRef: 'conversation-1',
      customerRef: 'customer-1',
      messageRef: 'message-1',
      content: sentinels[0],
      attachments: [{ locator: { dataUrl: sentinels[2] }, accessToken: sentinels[3] }],
      aiText: sentinels[4],
      token: sentinels[1]
    }
  };
}

describe('DLQ sanitized receipt capture', () => {
  const databases: SqliteD1[] = [];

  function database(): SqliteD1 {
    const db = new SqliteD1();
    db.migrate();
    databases.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('persists only bounded metadata and updates the original receipt atomically', async () => {
    const db = database();
    db.exec(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, created_at, updated_at, version)
      VALUES ('conv-1', 'chatwoot', 'account-1', 'conversation-1', 'customer-1', 'telegram', 1, 1, 1);
      INSERT INTO event_receipts
      (source, source_event_ref, status, attempt_count, last_error, processed_at)
      VALUES ('chatwoot', 'event-1', 'FAILED', 3, 'D1_WRITE_FAILED', NULL);
    `);

    const captured = await captureDlqMessage({ DB: db as any }, message('cf-1', validChatwootEvent()), 100);
    const receipt = await db.prepare('SELECT * FROM dlq_receipts WHERE id = ?').bind(captured.id).first<any>();
    expect(receipt).toMatchObject({
      queue_name: 'cz2128-dlq',
      event_source: 'chatwoot',
      source_event_ref: 'event-1',
      event_type: 'message_created',
      conversation_id: 'conv-1',
      operation_id: null,
      safe_error_code: 'D1_WRITE_FAILED',
      status: 'OPEN',
      delivery_count: 1,
      first_seen_at: 100,
      last_seen_at: 100,
      resolved_at: null
    });

    const original = await db.prepare(
      `SELECT status, attempt_count, last_error, processed_at, event_type,
              conversation_id, last_attempt_at, dead_lettered_at
       FROM event_receipts WHERE source = 'chatwoot' AND source_event_ref = 'event-1'`
    ).first<any>();
    expect(original).toEqual({
      status: 'FAILED',
      attempt_count: 3,
      last_error: 'D1_WRITE_FAILED',
      processed_at: null,
      event_type: 'message_created',
      conversation_id: 'conv-1',
      last_attempt_at: 100,
      dead_lettered_at: 100
    });

    const durable = JSON.stringify({
      dlq: await db.prepare('SELECT * FROM dlq_receipts').all(),
      event: await db.prepare('SELECT * FROM event_receipts').all(),
      audit: await db.prepare('SELECT * FROM reliability_audit').all()
    });
    for (const sentinel of sentinels) expect(durable).not.toContain(sentinel);
  });

  it('deduplicates a logical event while advancing count and timestamps', async () => {
    const db = database();
    await captureDlqMessage({ DB: db as any }, message('cf-first', validChatwootEvent('same-event')), 100);
    await captureDlqMessage({ DB: db as any }, message('cf-second', validChatwootEvent('same-event')), 200);
    const rows = await db.prepare('SELECT * FROM dlq_receipts').all<any>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ delivery_count: 2, first_seen_at: 100, last_seen_at: 200 });
  });

  it.each([
    ['undefined body', undefined],
    ['wrong body', 'not-an-object'],
    ['bad version', { ...validChatwootEvent(), version: 2 }],
    ['unknown source', { ...validChatwootEvent(), source: 'unknown' }],
    ['unknown type', { ...validChatwootEvent(), type: 'unknown' }],
    ['missing event id', { ...validChatwootEvent(), eventId: undefined }],
    ['oversized event id', { ...validChatwootEvent(), eventId: 'x'.repeat(257) }],
    ['bad payload', { ...validChatwootEvent(), payload: { accountRef: 'account-1' } }]
  ])('captures malformed metadata without retaining raw body: %s', async (_name, body) => {
    const db = database();
    const captured = await captureDlqMessage({ DB: db as any }, message(`malformed-${_name}`, body), 300);
    const receipt = await db.prepare('SELECT * FROM dlq_receipts WHERE id = ?').bind(captured.id).first<any>();
    expect(receipt).toMatchObject({
      event_source: null,
      source_event_ref: null,
      event_type: null,
      conversation_id: null,
      operation_id: null,
      safe_error_code: 'QUEUE_RETRY_EXHAUSTED',
      status: 'OPEN'
    });
    expect(JSON.stringify(receipt)).not.toContain('not-an-object');
  });

  it('uses the Cloudflare message identity for repeat malformed deliveries', async () => {
    const db = database();
    const body = { secret: sentinels[1] };
    await captureDlqMessage({ DB: db as any }, message('same-cloudflare-id', body), 10);
    await captureDlqMessage({ DB: db as any }, message('same-cloudflare-id', body), 20);
    const rows = await db.prepare('SELECT * FROM dlq_receipts').all<any>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].delivery_count).toBe(2);
    expect(JSON.stringify(rows.results[0])).not.toContain(sentinels[1]);
  });

  it('succeeds when the original event receipt is absent', async () => {
    const db = database();
    const captured = await captureDlqMessage({ DB: db as any }, message('missing-original', validChatwootEvent()), 400);
    const receipt = await db.prepare('SELECT * FROM dlq_receipts WHERE id = ?').bind(captured.id).first<any>();
    expect(receipt.status).toBe('OPEN');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM event_receipts').first<{ c: number }>())?.c).toBe(0);
  });

  it('leaves no half-state when the required D1 batch fails', async () => {
    const db = database();
    db.exec(`
      INSERT INTO event_receipts
      (source, source_event_ref, status, attempt_count, last_error)
      VALUES ('chatwoot', 'event-1', 'FAILED', 3, 'D1_WRITE_FAILED');
    `);
    const failingDb = {
      prepare: db.prepare.bind(db),
      batch: vi.fn().mockRejectedValue(new Error('PRIVATE_SQL_FAILURE'))
    };
    await expect(captureDlqMessage(
      { DB: failingDb as any }, message('cf-batch-failure', validChatwootEvent()), 450
    )).rejects.toThrow('PRIVATE_SQL_FAILURE');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM dlq_receipts').first<{ c: number }>())?.c).toBe(0);
    const original = await db.prepare(
      `SELECT dead_lettered_at, last_attempt_at FROM event_receipts
       WHERE source = 'chatwoot' AND source_event_ref = 'event-1'`
    ).first<any>();
    expect(original).toEqual({ dead_lettered_at: null, last_attempt_at: null });
  });

  it('marks the DLQ receipt RESOLVED when the canonical event is already PROCESSED', async () => {
    const db = database();
    db.exec(`
      INSERT INTO event_receipts
      (source, source_event_ref, status, attempt_count, last_error, processed_at)
      VALUES ('chatwoot', 'event-1', 'PROCESSED', 2, NULL, 390);
    `);
    const captured = await captureDlqMessage({ DB: db as any }, message('processed-copy', validChatwootEvent()), 400);
    const receipt = await db.prepare('SELECT * FROM dlq_receipts WHERE id = ?').bind(captured.id).first<any>();
    expect(receipt.status).toBe('RESOLVED');
    expect(receipt.resolved_at).toBe(400);
    const original = await db.prepare(
      `SELECT status, attempt_count, processed_at, dead_lettered_at FROM event_receipts
       WHERE source = 'chatwoot' AND source_event_ref = 'event-1'`
    ).first<any>();
    expect(original).toEqual({ status: 'PROCESSED', attempt_count: 2, processed_at: 390, dead_lettered_at: 400 });
  });

  it('uses canonical state at D1 write time instead of a stale pre-write read', async () => {
    const db = database();
    db.exec(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, created_at, updated_at, version)
      VALUES ('conv-1', 'chatwoot', 'account-1', 'conversation-1', 'customer-1', 'telegram', 1, 1, 1);
      INSERT INTO event_receipts
      (source, source_event_ref, status, attempt_count, lease_until, claim_token)
      VALUES ('chatwoot', 'event-1', 'PROCESSING', 1, 999, 'claim');
    `);
    const writeTimeDb = {
      prepare: db.prepare.bind(db),
      async batch(statements: any[]) {
        db.exec(`
          UPDATE event_receipts SET status = 'PROCESSED', processed_at = 450,
                 lease_until = NULL, claim_token = NULL
          WHERE source = 'chatwoot' AND source_event_ref = 'event-1';
        `);
        return db.batch(statements as any);
      }
    };
    const captured = await captureDlqMessage(
      { DB: writeTimeDb as any }, message('write-time-state', validChatwootEvent()), 500
    );
    const receipt = await db.prepare('SELECT * FROM dlq_receipts WHERE id = ?')
      .bind(captured.id).first<any>();
    expect(receipt).toMatchObject({ status: 'RESOLVED', resolved_at: 500 });
  });

  it('converges an existing OPEN receipt in the canonical completion batch', async () => {
    const db = database();
    db.exec(`
      INSERT INTO event_receipts
      (source, source_event_ref, status, attempt_count, lease_until, claim_token)
      VALUES ('chatwoot', 'event-1', 'PROCESSING', 1, 999, 'claim');
      INSERT INTO dlq_receipts
      (id, queue_name, event_source, source_event_ref, event_type, safe_error_code,
       status, delivery_count, first_seen_at, last_seen_at)
      VALUES ('dlq:v1:open', 'cz2128-dlq', 'chatwoot', 'event-1', 'message_created',
              'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, 100, 100);
    `);
    expect(await completeEventReceipt(
      { DB: db as any }, { source: 'chatwoot', eventId: 'event-1' }, 'claim', 600
    )).toBe(true);
    const receipt = await db.prepare(
      `SELECT status, resolved_at FROM dlq_receipts WHERE id = 'dlq:v1:open'`
    ).first<any>();
    expect(receipt).toEqual({ status: 'RESOLVED', resolved_at: 600 });
    expect(await completeEventReceipt(
      { DB: db as any }, { source: 'chatwoot', eventId: 'event-1' }, 'claim', 700
    )).toBe(false);
    expect(await db.prepare(
      `SELECT status, resolved_at FROM dlq_receipts WHERE id = 'dlq:v1:open'`
    ).first<any>()).toEqual({ status: 'RESOLVED', resolved_at: 600 });
  });

  it('resolves internal conversation IDs for Telegram, AI and attachment events without persisting private fields', async () => {
    const db = database();
    db.exec(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, operator_thread_ref, created_at, updated_at, version)
      VALUES ('conv-1', 'chatwoot', 'a', 'c', 'customer', 'telegram', 'thread-1', 1, 1, 1);
      INSERT INTO attachments
      (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
       attachment_type, original_filename, safe_filename, mime_type, storage_key,
       access_token_hash, status, destination_provider, created_at, updated_at)
      VALUES ('attachment-1', 'conv-1', 'telegram', 'm', 'a', 'document', 'x', 'x',
              'text/plain', 'attachments/x', 'hash', 'STORED', 'chatwoot', 1, 1);
    `);
    const events = [
      { version: 1, source: 'telegram', type: 'message_created', eventId: 'tg', payload: { threadRef: 'thread-1', content: sentinels[0] } },
      { version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai', payload: { convId: 'conv-1', messageId: 'm', text: sentinels[4] } },
      { version: 1, source: 'internal', type: 'attachment_transfer', eventId: 'att', payload: { attachmentId: 'attachment-1', accessToken: sentinels[3], locator: sentinels[2] } }
    ];
    for (let index = 0; index < events.length; index++) {
      const captured = await captureDlqMessage({ DB: db as any }, message(`cf-${index}`, events[index]), 500 + index);
      const receipt = await db.prepare('SELECT * FROM dlq_receipts WHERE id = ?').bind(captured.id).first<any>();
      expect(receipt.conversation_id).toBe('conv-1');
    }
    const rows = JSON.stringify(await db.prepare('SELECT * FROM dlq_receipts').all());
    for (const sentinel of sentinels) expect(rows).not.toContain(sentinel);
  });

  it('requires only D1 and performs zero provider, R2 or Queue actions', async () => {
    const db = database();
    const forbidden = vi.fn(() => {
      throw new Error('DLQ provider boundary crossed');
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(forbidden as any);
    const testEnv = {
      DB: db,
      get QUEUE() { forbidden(); return undefined; },
      get ATTACHMENTS_BUCKET() { forbidden(); return undefined; },
      get TELEGRAM_BOT_TOKEN() { forbidden(); return undefined; },
      get CHATWOOT_API_TOKEN() { forbidden(); return undefined; },
      get AI_API_KEY() { forbidden(); return undefined; }
    };
    await captureDlqMessage(testEnv as any, message('provider-zero', validChatwootEvent()), 600);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
  });
});
