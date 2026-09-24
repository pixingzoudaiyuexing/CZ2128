import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { parseCrispKeywordRules } from '../src/config/crisp-keywords';
import { RuntimeDb, masterKey } from './helpers/runtime-db';

const adminPath = 'p'.repeat(43);
const adminSecret = 's'.repeat(43);

function env(db = new RuntimeDb()) {
  return {
    DB: db,
    RUNTIME_CONFIG_MASTER_KEY: masterKey(),
    ADMIN_TELEGRAM_BOT_TOKEN: '999999:admin-token-abcdefghijklmnopqrstuvwxyz',
    ADMIN_TELEGRAM_WEBHOOK_SECRET: adminSecret,
    ADMIN_TELEGRAM_SECRET_PATH: adminPath,
    ADMIN_TELEGRAM_USER_IDS: '1001',
    TELEGRAM_BOT_TOKEN: '111111:support-token-abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_WEBHOOK_SECRET: 'support-secret',
    TELEGRAM_SECRET_PATH: 'support-path',
    BOT_GROUP_ID: '-10099'
  } as any;
}

function message(updateId: number, text: string, userId = 1001) {
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: updateId, text, from: { id: userId }, chat: { id: userId, type: 'private' } }
    })
  });
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

function telegramMock() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
  );
}

function rules(db: RuntimeDb) {
  const row = db.runtime.find(item => item.key === 'CRISP_KEYWORD_RULES');
  return row ? parseCrispKeywordRules(row.value_text)! : null;
}

describe('Crisp keyword Admin Bot flow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds, edits, disables/enables and deletes a rule only after confirmation', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    telegramMock();

    await handleAdminTelegramWebhook(callback(1, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(2, '订阅地址'), testEnv);
    await handleAdminTelegramWebhook(message(3, '请在用户中心复制您的专属地址。'), testEnv);

    expect(rules(db)?.rules).toHaveLength(1);
    const current = rules(db)!.rules[0];
    expect(current).toMatchObject({ keyword: '订阅地址', enabled: true });
    const id = current.id;

    await handleAdminTelegramWebhook(callback(4, `k:ek:${id}`), testEnv);
    await handleAdminTelegramWebhook(message(5, 'Subscription Link'), testEnv);
    expect(rules(db)!.rules[0].keyword).toBe('Subscription Link');

    await handleAdminTelegramWebhook(callback(6, `k:er:${id}`), testEnv);
    await handleAdminTelegramWebhook(message(7, 'Updated reply'), testEnv);
    expect(rules(db)!.rules[0].reply).toBe('Updated reply');

    await handleAdminTelegramWebhook(callback(8, `k:t:${id}`), testEnv);
    expect(rules(db)!.rules[0].enabled).toBe(false);
    await handleAdminTelegramWebhook(callback(9, `k:t:${id}`), testEnv);
    expect(rules(db)!.rules[0].enabled).toBe(true);

    await handleAdminTelegramWebhook(callback(10, `k:d:${id}`), testEnv);
    expect(rules(db)!.rules).toHaveLength(1);
    await handleAdminTelegramWebhook(callback(11, 'k:dy'), testEnv);
    expect(rules(db)!.rules).toHaveLength(0);
    expect(db.history.filter(row => row.key === 'CRISP_KEYWORD_RULES').length).toBeGreaterThanOrEqual(6);
  });

  it('rejects a duplicate normalized keyword without changing the active config', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    telegramMock();

    await handleAdminTelegramWebhook(callback(20, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(21, 'Renew'), testEnv);
    await handleAdminTelegramWebhook(message(22, 'reply one'), testEnv);
    const version = db.runtime[0].version;

    await handleAdminTelegramWebhook(callback(23, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(24, '  RENEW  '), testEnv);

    expect(rules(db)!.rules).toHaveLength(1);
    expect(db.runtime[0].version).toBe(version);
    expect(db.sessions[0]).toMatchObject({ action: 'KEYWORD_ADD_KEYWORD' });
  });

  it('keeps non-admin users outside keyword configuration', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    const fetchMock = telegramMock();

    await handleAdminTelegramWebhook(callback(30, 'k:add', 2002), testEnv);
    await handleAdminTelegramWebhook(message(31, 'blocked', 2002), testEnv);

    expect(db.runtime).toHaveLength(0);
    expect(db.sessions).toHaveLength(0);
    expect(db.receipts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses runtime-config CAS so a stale admin session cannot overwrite a newer rules version', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    telegramMock();

    await handleAdminTelegramWebhook(callback(40, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(41, 'one'), testEnv);
    await handleAdminTelegramWebhook(message(42, 'reply'), testEnv);
    const id = rules(db)!.rules[0].id;

    await handleAdminTelegramWebhook(callback(43, `k:ek:${id}`), testEnv);
    db.runtime[0].version += 1;
    await handleAdminTelegramWebhook(message(44, 'stale-edit'), testEnv);

    expect(rules(db)!.rules[0].keyword).toBe('one');
    expect(db.sessions[0]).toMatchObject({ action: 'KEYWORD_EDIT_KEYWORD' });
  });
  it('paginates 100 rules into bounded pages and hides add at the limit', async () => {
    const db = new RuntimeDb();
    const config = {
      version: 1,
      rules: Array.from({ length: 100 }, (_, index) => ({
        id: `kw_${String(index + 1).padStart(16, '0')}`,
        keyword: `keyword-${index + 1}`,
        reply: `reply-${index + 1}`,
        enabled: true
      }))
    };
    db.runtime.push({
      key: 'CRISP_KEYWORD_RULES',
      value_kind: 'PLAIN',
      value_text: JSON.stringify(config),
      ciphertext: null,
      nonce: null,
      version: 1,
      updated_by: 'seed',
      updated_at: 1
    });
    const testEnv = env(db);
    const fetchMock = telegramMock();

    await handleAdminTelegramWebhook(callback(50, 'p:kw'), testEnv);
    await handleAdminTelegramWebhook(callback(51, 'k:p:9'), testEnv);

    const sends = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String((call[1] as RequestInit).body)));
    const last = sends.at(-1);
    expect(last.text).toContain('规则：100/100');
    expect(last.text).toContain('第 10/10 页');
    expect(last.text).toContain('91. ✅ keyword-91');
    expect(last.text).toContain('100. ✅ keyword-100');
    expect(last.text).not.toContain('keyword-90');
    expect(last.reply_markup.inline_keyboard.flat().some((button: any) => button.callback_data === 'k:add')).toBe(false);
    expect(last.reply_markup.inline_keyboard.flat().some((button: any) => button.callback_data === 'k:p:8')).toBe(true);
    expect(last.text.length).toBeLessThan(4096);
  });

});
