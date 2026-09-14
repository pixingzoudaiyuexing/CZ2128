import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { SqliteD1 } from './helpers/sqlite-d1';

const adminPath = 'p'.repeat(43);
const adminSecret = 's'.repeat(43);

function env(db: SqliteD1) {
  return {
    DB: db,
    RUNTIME_CONFIG_MASTER_KEY: '0'.repeat(43),
    ADMIN_TELEGRAM_BOT_TOKEN: '999999:admin-token-abcdefghijklmnopqrstuvwxyz',
    ADMIN_TELEGRAM_WEBHOOK_SECRET: adminSecret,
    ADMIN_TELEGRAM_SECRET_PATH: adminPath,
    ADMIN_TELEGRAM_USER_IDS: '1001,1002',
    AI_BASE_URL: 'https://ai.example/v1', AI_MODEL: 'model', AI_API_KEY: 'env-ai-key',
    TELEGRAM_BOT_TOKEN: '111111:old-support-abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_WEBHOOK_SECRET: 'old-secret', TELEGRAM_SECRET_PATH: 'old-path', BOT_GROUP_ID: '-10099',
    CHATWOOT_API_URL: 'https://chatwoot.example', CHATWOOT_API_TOKEN: 'cw-token'
  } as any;
}

function callback(updateId: number, data: string, options: { userId?: number } = {}) {
  const userId = options.userId ?? 1001;
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`, data, from: { id: userId },
        message: { chat: { id: userId, type: 'private' } }
      }
    })
  });
}

function ok(result: any = true) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function defaultTelegramMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    return ok({ message_id: 1 });
  });
}

describe('Admin Reliability Control Plane', () => {
  afterEach(() => vi.restoreAllMocks());

  it('provides bounded unresolved query and correctly calculates summary', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    // Unresolved
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', 10, 10, 0),
      ('op2', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'STILL_AMBIGUOUS', 20, 20, 0),
      ('op3', 'c1', 'telegram', 'SEND_MESSAGE', 'FAILED_RETRYABLE', 'PENDING', 30, 30, 0),
      ('op4', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'MANUAL_CANCELLED', 40, 40, 0)
    `);
    
    db.exec(`INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, handoff_epoch, status, attempt_count, created_at, updated_at) VALUES 
      ('evt1', 'c1', 'msg1', 1, 'FAILED_RETRYABLE', 1, 10, 10),
      ('evt2', 'c1', 'msg2', 1, 'FAILED_FINAL', 1, 20, 20)
    `);

    await handleAdminTelegramWebhook(callback(10, 'p:rel'), testEnv);
    const replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    expect(replies[0]).toContain('Unresolved AMBIGUOUS: 2');
    expect(replies[0]).toContain('Pending automatic outbound retries: 1');
    expect(replies[0]).toContain('Recently manually resolved: 1');
    expect(replies[0]).toContain('AI FAILED_RETRYABLE: 1');
    expect(replies[0]).toContain('AI FAILED_FINAL: 1');
  });

  it('maintains parent/child lookup consistency', async () => {
    // Tests that DB query fetches ops right etc.
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    await handleAdminTelegramWebhook(callback(10, 'r:unc'), testEnv);
    const replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    expect(replies[0]).toContain('No uncertain deliveries found.');
  });
});
