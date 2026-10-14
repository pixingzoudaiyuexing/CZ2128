import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { CRISP_QUIET_KEY, crispQuietMinutes, parseCrispQuietMinutes } from '../src/config/crisp-quiet';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { restoreEnvOverride, setPlainOverride } from '../src/runtime-config/service';
import { SqliteD1 } from './helpers/sqlite-d1';
import { masterKey } from './helpers/runtime-db';

const path = 'p'.repeat(43);
const secret = 's'.repeat(43);

function request(update: number, input: string, callback = true, user = 1001) {
  return new Request(`https://worker.example/webhooks/admin-telegram/${path}`, {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(callback ? {
      update_id: update, callback_query: { id: `c-${update}`, data: input, from: { id: user },
        message: { chat: { id: user, type: 'private' } } }
    } : { update_id: update, message: { message_id: update, text: input, from: { id: user },
      chat: { id: user, type: 'private' } } })
  });
}

describe('Telegram Admin independent Crisp human quiet setting', () => {
  let db: SqliteD1;
  let env: any;
  let replies: any[];
  let nextUpdate: number;
  beforeEach(() => {
    db = new SqliteD1(); db.migrate();
    nextUpdate = 2000;
    replies = [];
    env = { DB: db, RUNTIME_CONFIG_MASTER_KEY: masterKey(),
      ADMIN_TELEGRAM_BOT_TOKEN: '999999:synthetic-admin-token',
      ADMIN_TELEGRAM_SECRET_PATH: path, ADMIN_TELEGRAM_WEBHOOK_SECRET: secret,
      ADMIN_TELEGRAM_USER_IDS: '1001,1002', BOT_GROUP_ID: '-10099',
      AI_OPERATOR_PAUSE_TIMEOUT_SECONDS: '7200' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/api\.telegram\.org\//);
      if (String(url).endsWith('/sendMessage')) replies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: replies.length } });
    });
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const button = (text: string) => replies.at(-1).reply_markup.inline_keyboard.flat()
    .find((value: any) => value.text.includes(text)).callback_data as string;
  const call = async (data: string, user = 1001) => handleAdminTelegramWebhook(request(nextUpdate++, data, true, user), env);
  const input = async (text: string) => handleAdminTelegramWebhook(request(nextUpdate++, text, false), env);
  const active = () => db.prepare('SELECT value_text, version FROM runtime_config WHERE key = ?').bind(CRISP_QUIET_KEY).first<any>();
  const historyCount = () => db.prepare('SELECT COUNT(*) AS count FROM runtime_config_history WHERE key = ?').bind(CRISP_QUIET_KEY).first<{ count: number }>();

  it('shows default 15 minutes, source and the existing Telegram-menu entry', async () => {
    await call('p:tg');
    expect(button('Crisp 人工静默时间')).toBe('cq:o');
    await call('cq:o');
    expect(replies.at(-1).text).toContain('当前静默时间：15 分钟');
    expect(replies.at(-1).text).toContain('配置来源：默认值');
    expect(replies.at(-1).text).toContain('不改变 AI');
    expect(await active()).toBeNull();
  });

  it.each([5, 10, 15, 30, 60])('saves shortcut %i once and immediately renders its new D1 value', async minutes => {
    await call('cq:o');
    const data = button(`${minutes} 分钟`);
    const update = nextUpdate++;
    await handleAdminTelegramWebhook(request(update, data), env);
    await handleAdminTelegramWebhook(request(update, data), env);
    expect(await active()).toEqual({ value_text: String(minutes), version: 1 });
    expect(await historyCount()).toEqual({ count: 1 });
    expect(replies.at(-1).text).toContain(`当前静默时间：${minutes} 分钟`);
    expect(replies.at(-1).text).toContain('配置来源：D1');
    expect(crispQuietMinutes(await resolveEffectiveEnv({ ...env }))).toBe(minutes);
    expect(env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS).toBe('7200');
  });

  it('restores the original raw ENV value, retaining monotonic history and rejecting a stale ABA button', async () => {
    env[CRISP_QUIET_KEY] = '10';
    await call('cq:o', 1001);
    const stale = button('30 分钟');
    await call('cq:o', 1002);
    await call(button('60 分钟'), 1002);
    await call(button('恢复 ENV'), 1002);
    expect(await active()).toBeNull();
    expect(await historyCount()).toEqual({ count: 2 });
    expect(replies.at(-1).text).toContain('当前静默时间：10 分钟');
    expect(replies.at(-1).text).toContain('配置来源：ENV');
    await call(stale, 1001);
    expect(await active()).toBeNull();
    expect(await historyCount()).toEqual({ count: 2 });
    expect(replies.some(value => value.text.includes('被其他操作更新'))).toBe(true);
  });

  it('rejects old rendered callbacks even when a newer page has the same config version', async () => {
    await call('cq:o'); const stale = button('30 分钟');
    await call('cq:o');
    await call(stale);
    expect(await active()).toBeNull();
    expect(await historyCount()).toEqual({ count: 0 });
  });

  it('accepts custom 1 and 1440 minutes and rejects malformed input without mutation', async () => {
    await call('cq:o'); await call(button('自定义'));
    for (const value of ['0', '1441', '-1', '1.5', '1e2', '', 'Infinity', '１５', '<script>', '999999999999999999']) {
      await input(value || ' ');
      expect(await active()).toBeNull();
      expect(await historyCount()).toEqual({ count: 0 });
    }
    await input('1');
    expect(await active()).toEqual({ value_text: '1', version: 1 });
    await call(button('自定义')); await input('1440');
    expect(await active()).toEqual({ value_text: '1440', version: 2 });
  });

  it('cancels and navigates back without leaving an input able to save later numbers', async () => {
    await call('cq:o'); await call(button('自定义')); await input('/cancel');
    await input('30');
    expect(await active()).toBeNull();
    await call('cq:o'); await call(button('自定义')); await call('cq:b'); await input('60');
    expect(await active()).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first()).toEqual({ count: 0 });
  });

  it('expires both input and buttons without writing and gives a new settings entry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1792000000000);
    await call('cq:o'); const stale = button('30 分钟'); await call(button('自定义'));
    vi.setSystemTime(1792000601000);
    await input('30'); expect(await active()).toBeNull();
    await call(stale); expect(await active()).toBeNull();
    expect(replies.some(value => value.text.includes('已过期'))).toBe(true);
  });

  it('makes already-default restore a no-op and records rollback as a new version', async () => {
    await call('cq:o'); await call(button('恢复 ENV'));
    expect(await historyCount()).toEqual({ count: 0 });
    await call(button('30 分钟'));
    const old = await db.prepare('SELECT id FROM runtime_config_history WHERE key = ? AND version = 1').bind(CRISP_QUIET_KEY).first<{ id: number }>();
    await call(button('60 分钟')); await call(`rb:${old!.id}`);
    expect(await active()).toEqual({ value_text: '60', version: 2 });
    await call(button('确认回滚'));
    expect(await active()).toEqual({ value_text: '30', version: 3 });
    expect(await db.prepare('SELECT action FROM runtime_config_history WHERE key = ? AND version = 3').bind(CRISP_QUIET_KEY).first()).toEqual({ action: 'ROLLBACK' });
  });

  it('rejects stale rollback confirmation after another admin changes the setting', async () => {
    await call('cq:o'); await call(button('30 分钟'));
    const old = await db.prepare('SELECT id FROM runtime_config_history WHERE key=? AND version=1').bind(CRISP_QUIET_KEY).first<{ id: number }>();
    await call(`rb:${old!.id}`); const stale = button('确认回滚');
    await call('cq:o', 1002); await call(button('60 分钟'), 1002);
    await call(stale);
    expect(await active()).toEqual({ value_text: '60', version: 2 });
    expect(await historyCount()).toEqual({ count: 2 });
  });

  it('preserves another setting input session when an old quiet callback arrives', async () => {
    await call('cq:o'); const stale = button('30 分钟');
    await call('e:ak');
    const before = await db.prepare('SELECT action,target FROM admin_sessions WHERE admin_user_id=?').bind('1001').first();
    expect(before).not.toBeNull();
    await call(stale);
    expect(await db.prepare('SELECT action,target FROM admin_sessions WHERE admin_user_id=?').bind('1001').first()).toEqual(before);
    await call('cq:c');
    expect(await db.prepare('SELECT action,target FROM admin_sessions WHERE admin_user_id=?').bind('1001').first()).toEqual(before);
    expect(await active()).toBeNull();
  });

  it('rejects unauthorized users and bad webhook authentication before any session or config change', async () => {
    const fetchCount = vi.mocked(fetch).mock.calls.length;
    await call('cq:o', 5555);
    const bad = request(nextUpdate++, 'cq:o'); bad.headers.set('X-Telegram-Bot-Api-Secret-Token', 'bad');
    await handleAdminTelegramWebhook(bad, env);
    expect(await active()).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first()).toEqual({ count: 0 });
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCount);
  });

  it('redirects legacy Crisp notification callbacks without deleting their old values or history', async () => {
    await setPlainOverride(env, 'TELEGRAM_NOTIFY_CRISP_OPERATOR', 'silent', 0, 'seed', 'legacy');
    await call('e:tnc'); await call('x:tnc');
    expect(replies.at(-1).text).toContain('Crisp 人工静默时间');
    expect(await db.prepare("SELECT value_text,version FROM runtime_config WHERE key='TELEGRAM_NOTIFY_CRISP_OPERATOR'").first()).toEqual({ value_text: 'silent', version: 1 });
  });

  it('uses a finite default for corrupt D1 data without falling back to an older ENV duration', async () => {
    env[CRISP_QUIET_KEY] = '60';
    await setPlainOverride(env, CRISP_QUIET_KEY, '30', 0, 'seed', 'valid');
    db.exec(`UPDATE runtime_config SET value_text='NaN' WHERE key='${CRISP_QUIET_KEY}'`);
    expect(crispQuietMinutes(await resolveEffectiveEnv(env))).toBe(15);
    expect(parseCrispQuietMinutes('1e2')).toBeNull();
    await restoreEnvOverride(env, CRISP_QUIET_KEY, 1, 'seed', 'restore');
    expect(crispQuietMinutes(await resolveEffectiveEnv(env))).toBe(60);
  });
});
