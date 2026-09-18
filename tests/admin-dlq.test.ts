import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { captureDlqMessage } from '../src/queue/dlq-consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

const adminPath = 'p'.repeat(43);
const adminSecret = 's'.repeat(43);
const privacySentinels = [
  'PRIVATE_DLQ_MESSAGE_BODY_123',
  'SUPER_SECRET_DLQ_TOKEN_456',
  'PRIVATE_CHATWOOT_URL_789',
  'PRIVATE_ATTACHMENT_ACCESS_TOKEN_ABC',
  'PRIVATE_AI_TEXT_DEF'
];

function env(db: SqliteD1) {
  return {
    DB: db,
    RUNTIME_CONFIG_MASTER_KEY: '0'.repeat(43),
    ADMIN_TELEGRAM_BOT_TOKEN: '999999:admin-token-abcdefghijklmnopqrstuvwxyz',
    ADMIN_TELEGRAM_WEBHOOK_SECRET: adminSecret,
    ADMIN_TELEGRAM_SECRET_PATH: adminPath,
    ADMIN_TELEGRAM_USER_IDS: '1001',
    TELEGRAM_BOT_TOKEN: '111111:support-token-abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_WEBHOOK_SECRET: 'support-secret',
    TELEGRAM_SECRET_PATH: 'support-path',
    BOT_GROUP_ID: '-10099',
    CHATWOOT_API_URL: 'https://chatwoot.example',
    CHATWOOT_API_TOKEN: 'cw-token'
  } as any;
}

function callback(updateId: number, data: string, userId = 1001) {
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        data,
        from: { id: userId },
        message: { chat: { id: userId, type: 'private' } }
      }
    })
  });
}

function telegramOk(result: unknown = { message_id: 1 }) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function quarantineBucket(options: { invalid?: boolean } = {}) {
  const list = vi.fn(async () => ({
    truncated: false,
    objects: [{
      key: `terminal-dlq/v1/${'a'.repeat(64)}.json`,
      uploaded: new Date('2026-09-18T00:00:00Z'),
      customMetadata: options.invalid ? { raw: privacySentinels[0] } : {
        schemaVersion: '1',
        quarantineId: `dlq-quarantine:v1:${'a'.repeat(64)}`,
        canonicalReceiptId: `dlq:v1:${'b'.repeat(64)}`,
        queueName: 'cz2128-dlq',
        eventSource: 'chatwoot',
        eventType: 'message_created',
        queueAttempts: '4',
        messageTimestamp: '1789689600',
        reason: 'D1_DLQ_RECEIPT_PERSIST_FAILED',
        state: 'QUARANTINED'
      }
    }]
  }));
  return { list, get: vi.fn(() => { throw new Error('quarantine body read forbidden'); }) };
}

describe('Admin DLQ inspection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows bounded summary, list and read-only detail without leaking raw DLQ payload', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    testEnv.DLQ_QUARANTINE = quarantineBucket() as any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(telegramOk());
    db.exec(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, created_at, updated_at, version)
      VALUES ('conv-1', 'chatwoot', 'account-1', 'conversation-1', 'customer-1', 'telegram', 1, 1, 1);
    `);
    await captureDlqMessage({ DB: db as any }, {
      id: 'cf-admin-dlq',
      body: {
        version: 1,
        source: 'chatwoot',
        type: 'message_created',
        eventId: 'event-admin',
        payload: {
          accountRef: 'account-1',
          conversationRef: 'conversation-1',
          content: privacySentinels[0],
          token: privacySentinels[1],
          url: privacySentinels[2],
          accessToken: privacySentinels[3],
          aiText: privacySentinels[4]
        }
      }
    } as any, Math.floor(Date.now() / 1000));

    await handleAdminTelegramWebhook(callback(1, 'p:rel'), testEnv);
    await handleAdminTelegramWebhook(callback(2, 'r:dlqo'), testEnv);
    await handleAdminTelegramWebhook(callback(3, 'r:d:0'), testEnv);

    const adminCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('bot999999'));
    const supportCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('bot111111'));
    expect(adminCalls.length).toBeGreaterThan(0);
    expect(supportCalls).toHaveLength(0);

    const rendered = adminCalls.map(call => String(call[1]?.body || '')).join('\n');
    expect(rendered).toContain('DLQ OPEN: 1');
    expect(rendered).toContain('Open DLQ (Latest 10)');
    expect(rendered).toContain('DLQ Receipt');
    expect(rendered).toContain('Event ref: event-admin');
    for (const sentinel of privacySentinels) expect(rendered).not.toContain(sentinel);

    for (const call of adminCalls) {
      const body = JSON.parse(String(call[1]?.body || '{}'));
      const keyboard = body.reply_markup?.inline_keyboard || [];
      for (const row of keyboard) {
        for (const button of row) {
          const data = String(button.callback_data || '');
          expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
          expect(data).not.toContain('dlq:v1:');
          for (const sentinel of privacySentinels) expect(data).not.toContain(sentinel);
        }
      }
    }

    const before = await db.prepare('SELECT * FROM dlq_receipts').all();
    await handleAdminTelegramWebhook(callback(4, 'r:o:retry_yes'), testEnv);
    await handleAdminTelegramWebhook(callback(5, 'r:dd'), testEnv);
    const after = await db.prepare('SELECT * FROM dlq_receipts').all();
    expect(after.results).toEqual(before.results);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('bot111111'))).toHaveLength(0);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM outbound_operations').first<any>()).c).toBe(0);
    db.close();
  });

  it('exposes no DLQ data to an unauthorized user', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    testEnv.DLQ_QUARANTINE = quarantineBucket() as any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(telegramOk());
    db.exec(`
      INSERT INTO dlq_receipts
      (id, queue_name, safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
      VALUES ('dlq:v1:private', 'cz2128-dlq', 'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, 1, 1);
    `);
    await handleAdminTelegramWebhook(callback(10, 'r:dlqo', 9999), testEnv);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT delivery_count FROM dlq_receipts').first<any>()).delivery_count).toBe(1);
    db.close();
  });

  it('shows only sanitized quarantine metadata through the authenticated read-only surface', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const bucket = quarantineBucket();
    testEnv.DLQ_QUARANTINE = bucket as any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(telegramOk());

    await handleAdminTelegramWebhook(callback(20, 'r:dlqq'), testEnv);

    expect(bucket.list).toHaveBeenCalledWith({
      prefix: 'terminal-dlq/v1/',
      limit: 1000,
      include: ['customMetadata']
    });
    expect(bucket.get).not.toHaveBeenCalled();
    const rendered = fetchMock.mock.calls.map(call => String(call[1]?.body || '')).join('\n');
    expect(rendered).toContain('Terminal DLQ Quarantine');
    expect(rendered).toContain(`dlq-quarantine:v1:${'a'.repeat(64)}`);
    expect(rendered).toContain('D1_DLQ_RECEIPT_PERSIST_FAILED');
    expect(rendered).toContain('QUARANTINED');
    for (const sentinel of privacySentinels) expect(rendered).not.toContain(sentinel);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM outbound_operations').first<any>()).c).toBe(0);
    db.close();
  });

  it('does not expose quarantine metadata to an unauthorized user', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const bucket = quarantineBucket();
    testEnv.DLQ_QUARANTINE = bucket as any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(telegramOk());
    await handleAdminTelegramWebhook(callback(21, 'r:dlqq', 9999), testEnv);
    expect(bucket.list).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });
});
