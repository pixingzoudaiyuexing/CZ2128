import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { createKnowledgeEntry, searchKnowledge } from '../src/knowledge/repository';
import { SqliteD1 } from './helpers/sqlite-d1';
import { masterKey } from './helpers/runtime-db';

const PATH = 'p'.repeat(43);
const SECRET = 's'.repeat(43);

describe('knowledge Admin webhook with SQLite persistence and FTS', () => {
  let db: SqliteD1;
  let env: any;
  let replies: any[];
  let update: number;

  beforeEach(() => {
    db = new SqliteD1(); db.migrateThroughKnowledge();
    replies = []; update = 3000;
    env = { DB: db, RUNTIME_CONFIG_MASTER_KEY: masterKey(),
      ADMIN_TELEGRAM_BOT_TOKEN: '999999:synthetic-admin-token', ADMIN_TELEGRAM_SECRET_PATH: PATH,
      ADMIN_TELEGRAM_WEBHOOK_SECRET: SECRET, ADMIN_TELEGRAM_USER_IDS: '1001' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/api\.telegram\.org\//);
      if (String(url).endsWith('/sendMessage')) replies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: replies.length } });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); db.close(); });

  function request(id: number, input: string, callback: boolean, user = 1001) {
    return new Request(`https://worker.example/webhooks/admin-telegram/${PATH}`, {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify(callback ? {
        update_id: id, callback_query: { id: `callback-${id}`, data: input, from: { id: user },
          message: { chat: { id: user, type: 'private' } } }
      } : { update_id: id, message: { message_id: id, text: input, from: { id: user },
        chat: { id: user, type: 'private' } } })
    });
  }
  const call = (input: string, user = 1001) => handleAdminTelegramWebhook(request(update++, input, true, user), env);
  const input = (text: string) => handleAdminTelegramWebhook(request(update++, text, false), env);
  const button = (text: string): string => replies.at(-1).reply_markup.inline_keyboard.flat()
    .find((item: any) => item.text.includes(text)).callback_data;

  it('creates, edits, disables, enables and deletes one entry while FTS and audit follow the UI', async () => {
    await call('p:kb');
    await call(button('添加知识'));
    await input('Synthetic refund policy');
    const finalInputId = update++;
    await handleAdminTelegramWebhook(request(finalInputId, 'Refunds take three business days.', false), env);
    await handleAdminTelegramWebhook(request(finalInputId, 'Refunds take three business days.', false), env);
    const entry = await db.prepare('SELECT id,version FROM knowledge_entries').first<any>();
    expect(entry.version).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').first()).toEqual({ n: 1 });
    expect((await searchKnowledge(env, 'refund'))[0]?.id).toBe(entry.id);
    await call(button('查看条目'));
    const staleToggle = button('停用');
    await call(button('修改正文'));
    await input('Refunds take five business days.');
    await call(button('返回条目'));
    expect(replies.at(-1).text).toContain('five business days');
    await call(staleToggle);
    expect(replies.at(-1).text).toContain('KNOWLEDGE_VERSION_CONFLICT');
    await call(`b:v:${entry.id}`);
    await call(button('停用'));
    expect(await searchKnowledge(env, 'refund')).toEqual([]);
    await call(button('返回条目'));
    await call(button('启用'));
    expect((await searchKnowledge(env, 'refund'))[0]?.body).toBe('Refunds take five business days.');
    await call(button('返回条目'));
    await call(button('删除'));
    await call(button('取消'));
    expect(await db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').first()).toEqual({ n: 1 });
    await call(`b:v:${entry.id}`);
    await call(button('删除'));
    await call(button('确认删除'));
    expect(await searchKnowledge(env, 'refund')).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').first()).toEqual({ n: 0 });
    expect((await db.prepare('SELECT action,version FROM knowledge_entry_history WHERE entry_id=? ORDER BY version')
      .bind(entry.id).all()).results).toEqual([
      { action: 'CREATE', version: 1 }, { action: 'UPDATE', version: 2 },
      { action: 'DISABLE', version: 3 }, { action: 'ENABLE', version: 4 }, { action: 'DELETE', version: 5 }
    ]);
  });

  it('rejects unauthorized callbacks and an expired input session without creating knowledge', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1792000000000);
    await call('b:add', 9009);
    expect(replies).toHaveLength(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_update_receipts').first()).toEqual({ n: 0 });
    await call('b:add');
    await input('Synthetic expired title');
    vi.advanceTimersByTime(601000);
    await input('This body arrives too late.');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM knowledge_entry_history').first()).toEqual({ n: 0 });
  });

  it('paginates real persisted entries without exposing the second page on the first', async () => {
    for (let index = 0; index < 11; index += 1) {
      await createKnowledgeEntry(env, `Synthetic topic ${index}`, `Policy number ${index}`, '1001', `fixture-${index}`);
    }
    await call('p:kb');
    const firstIds = replies.at(-1).reply_markup.inline_keyboard.flat()
      .filter((item: any) => item.callback_data.startsWith('b:v:')).map((item: any) => item.callback_data);
    expect(firstIds).toHaveLength(10);
    await call(button('下一页'));
    const secondIds = replies.at(-1).reply_markup.inline_keyboard.flat()
      .filter((item: any) => item.callback_data.startsWith('b:v:')).map((item: any) => item.callback_data);
    expect(secondIds).toHaveLength(1);
    expect(firstIds).not.toContain(secondIds[0]);
    expect(button('上一页')).toBe('b:p:0');
  });
});
