import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { parseCrispKeywordRules } from '../src/config/crisp-keywords';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { setPlainOverride } from '../src/runtime-config/service';
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
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
  );
}

function rules(db: RuntimeDb) {
  const row = db.runtime.find(item => item.key === 'CRISP_KEYWORD_RULES');
  return row ? parseCrispKeywordRules(row.value_text)! : null;
}

function config(rulesValue: Array<{ id: string; keyword: string; reply: string; enabled: boolean }>) {
  return JSON.stringify({ version: 1, rules: rulesValue });
}

function sentBodies(fetchMock: ReturnType<typeof telegramMock>) {
  return fetchMock.mock.calls
    .filter(call => String(call[0]).endsWith('/sendMessage'))
    .map(call => JSON.parse(String((call[1] as RequestInit).body)));
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
  it('renders a reachable dedicated Restore ENV action and no-ops safely when ENV is already active', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    testEnv.CRISP_KEYWORD_RULES = config([{
      id: 'kw_aaaaaaaaaaaaaaaa', keyword: 'env-keyword', reply: 'env-reply', enabled: true
    }]);
    const fetchMock = telegramMock();

    await handleAdminTelegramWebhook(callback(45, 'p:kw'), testEnv);
    await handleAdminTelegramWebhook(callback(46, 'k:env'), testEnv);

    const bodies = sentBodies(fetchMock);
    const page = bodies.find(body => body.text.startsWith('Crisp 关键词自动回复'));
    expect(page.text).toContain('配置来源：ENV');
    expect(page.text).toContain('env-keyword');
    expect(page.reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data)).toContain('k:env');
    expect(bodies.at(-1).text).toContain('当前已经使用 ENV 关键词配置');
    expect(db.runtime).toHaveLength(0);
    expect(db.history).toHaveLength(0);
    expect(db.sessions).toHaveLength(0);
  });

  it('restores the original non-empty ENV keyword rules after an Admin D1 override', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    testEnv.CRISP_KEYWORD_RULES = config([{
      id: 'kw_bbbbbbbbbbbbbbbb', keyword: 'env-original', reply: 'original-reply', enabled: true
    }]);
    telegramMock();

    await handleAdminTelegramWebhook(callback(60, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(61, 'temporary'), testEnv);
    await handleAdminTelegramWebhook(message(62, 'temporary-reply'), testEnv);
    expect(rules(db)?.rules.map(rule => rule.keyword)).toEqual(['env-original', 'temporary']);
    expect((await resolveEffectiveEnv(testEnv)).runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES).toBe('D1');

    await handleAdminTelegramWebhook(callback(63, 'k:env'), testEnv);
    expect(db.sessions[0]).toMatchObject({
      action: 'KEYWORD_RESTORE_ENV_CONFIRM',
      target: 'CRISP_KEYWORD_RULES',
      expected_version: 1
    });
    await handleAdminTelegramWebhook(callback(64, 'k:envy'), testEnv);

    const effective = await resolveEffectiveEnv(testEnv);
    expect(db.runtime.some(row => row.key === 'CRISP_KEYWORD_RULES')).toBe(false);
    expect(effective.runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES).toBe('ENV');
    expect(parseCrispKeywordRules(effective.runtimeConfigSnapshot?.values.CRISP_KEYWORD_RULES || '')?.rules.map(rule => rule.keyword))
      .toEqual(['env-original']);
    expect(db.history.at(-1)).toMatchObject({
      key: 'CRISP_KEYWORD_RULES',
      action: 'RESTORE_ENV',
      is_deleted: 1,
      actor_user_id: '1001',
      source_update_id: '64'
    });
    expect(db.sessions).toHaveLength(0);
  });

  it('restores ENV after the last temporary rule is deleted and the D1 override is empty', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    testEnv.CRISP_KEYWORD_RULES = config([]);
    telegramMock();

    await handleAdminTelegramWebhook(callback(70, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(71, 'temporary-only'), testEnv);
    await handleAdminTelegramWebhook(message(72, 'temporary-reply'), testEnv);
    const id = rules(db)!.rules[0].id;
    await handleAdminTelegramWebhook(callback(73, `k:d:${id}`), testEnv);
    await handleAdminTelegramWebhook(callback(74, 'k:dy'), testEnv);

    expect(rules(db)?.rules).toEqual([]);
    expect((await resolveEffectiveEnv(testEnv)).runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES).toBe('D1');

    await handleAdminTelegramWebhook(callback(75, 'k:env'), testEnv);
    await handleAdminTelegramWebhook(callback(76, 'k:envy'), testEnv);

    const effective = await resolveEffectiveEnv(testEnv);
    expect(db.runtime.some(row => row.key === 'CRISP_KEYWORD_RULES')).toBe(false);
    expect(effective.runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES).toBe('ENV');
    expect(parseCrispKeywordRules(effective.runtimeConfigSnapshot?.values.CRISP_KEYWORD_RULES || '')?.rules).toEqual([]);
  });

  it('rejects a stale dedicated keyword restore without deleting the newer D1 version', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    const fetchMock = telegramMock();

    await handleAdminTelegramWebhook(callback(80, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(81, 'one'), testEnv);
    await handleAdminTelegramWebhook(message(82, 'reply-one'), testEnv);
    await handleAdminTelegramWebhook(callback(83, 'k:env'), testEnv);
    expect(db.sessions[0]).toMatchObject({ action: 'KEYWORD_RESTORE_ENV_CONFIRM', expected_version: 1 });

    await setPlainOverride(
      testEnv,
      'CRISP_KEYWORD_RULES',
      config([{ id: 'kw_cccccccccccccccc', keyword: 'newer', reply: 'newer-reply', enabled: true }]),
      1,
      'other-admin',
      'other-update'
    );
    await handleAdminTelegramWebhook(callback(84, 'k:envy'), testEnv);

    expect(db.runtime.find(row => row.key === 'CRISP_KEYWORD_RULES')).toMatchObject({ version: 2 });
    expect(rules(db)?.rules[0].keyword).toBe('newer');
    expect(db.history.filter(row => row.action === 'RESTORE_ENV')).toHaveLength(0);
    expect(db.sessions[0]).toMatchObject({ action: 'KEYWORD_RESTORE_ENV_CONFIRM', expected_version: 1 });
    expect(sentBodies(fetchMock).map(body => body.text).join('\n')).toContain('RUNTIME_CONFIG_VERSION_CONFLICT');
  });

  it('deduplicates a replayed keyword restore confirmation and writes one RESTORE_ENV history record', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    telegramMock();

    await handleAdminTelegramWebhook(callback(90, 'k:add'), testEnv);
    await handleAdminTelegramWebhook(message(91, 'one'), testEnv);
    await handleAdminTelegramWebhook(message(92, 'reply'), testEnv);
    await handleAdminTelegramWebhook(callback(93, 'k:env'), testEnv);
    const confirmation = callback(94, 'k:envy');
    await handleAdminTelegramWebhook(confirmation.clone() as any, testEnv);
    await handleAdminTelegramWebhook(confirmation.clone() as any, testEnv);

    expect(db.runtime.some(row => row.key === 'CRISP_KEYWORD_RULES')).toBe(false);
    expect(db.history.filter(row => row.action === 'RESTORE_ENV')).toHaveLength(1);
    expect(db.receipts.filter(row => row.update_id === '94')).toHaveLength(1);
  });

  it('rejects a forged keyword restore confirmation without a valid Admin session', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    const fetchMock = telegramMock();

    await handleAdminTelegramWebhook(callback(95, 'k:envy'), testEnv);

    expect(db.runtime).toHaveLength(0);
    expect(db.history).toHaveLength(0);
    expect(db.sessions).toHaveLength(0);
    expect(sentBodies(fetchMock).map(body => body.text).join('\n')).toContain('RUNTIME_CONFIG_VALUE_INVALID');
  });

  it('keeps unauthorized users outside the dedicated keyword Restore ENV flow', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    const fetchMock = telegramMock();

    await handleAdminTelegramWebhook(callback(95, 'k:env', 2002), testEnv);

    expect(db.runtime).toHaveLength(0);
    expect(db.history).toHaveLength(0);
    expect(db.sessions).toHaveLength(0);
    expect(db.receipts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(last.reply_markup.inline_keyboard.flat().some((button: any) => button.callback_data === 'k:env')).toBe(true);
    expect(last.reply_markup.inline_keyboard.flat().some((button: any) => button.callback_data === 'k:p:8')).toBe(true);
    expect(last.text.length).toBeLessThan(4096);
  });

});
