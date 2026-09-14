import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { decryptRuntimeSecret } from '../src/runtime-config/crypto';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { setSecretOverride } from '../src/runtime-config/service';
import { RuntimeDb, masterKey } from './helpers/runtime-db';
import Worker from '../src/index';

const adminPath = 'p'.repeat(43);
const adminSecret = 's'.repeat(43);

function env(db = new RuntimeDb()) {
  return {
    DB: db,
    RUNTIME_CONFIG_MASTER_KEY: masterKey(),
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

function message(updateId: number, text: string, options: { userId?: number; chatType?: string; path?: string; secret?: string } = {}) {
  const userId = options.userId ?? 1001;
  return new Request(`https://worker.example/webhooks/admin-telegram/${options.path ?? adminPath}`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': options.secret ?? adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: updateId, text, from: { id: userId }, chat: { id: userId, type: options.chatType ?? 'private' } }
    })
  });
}

function callback(updateId: number, data: string, options: { userId?: number; chatType?: string } = {}) {
  const userId = options.userId ?? 1001;
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`, data, from: { id: userId },
        message: { chat: { id: userId, type: options.chatType ?? 'private' } }
      }
    })
  });
}

function ok(result: any = true) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function defaultTelegramMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const target = String(url);
    if (target.includes('/getMe')) return ok({ id: 777, is_bot: true, username: 'new_support_bot' });
    if (target.includes('/getChatMember')) return ok({ status: 'administrator', can_manage_topics: true });
    if (target.includes('/getChat')) return ok({ id: -10099, type: 'supergroup', is_forum: true });
    if (target.startsWith('https://ai.example/')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    }
    return ok({ message_id: 1 });
  });
}

async function begin(envValue: any, updateId: number, action: string) {
  await handleAdminTelegramWebhook(callback(updateId, action), envValue);
}

describe('Telegram admin control plane', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is disabled without complete bootstrap configuration', async () => {
    const testEnv = env();
    delete testEnv.ADMIN_TELEGRAM_BOT_TOKEN;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleAdminTelegramWebhook(message(1, '/start'), testEnv);
    expect(response.status).toBe(404);
    expect(testEnv.DB.receipts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects bootstrap configurations that reuse the path as the header secret', async () => {
    const testEnv = env();
    testEnv.ADMIN_TELEGRAM_WEBHOOK_SECRET = testEnv.ADMIN_TELEGRAM_SECRET_PATH;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleAdminTelegramWebhook(message(7, '/start'), testEnv);
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects reuse of the Admin Bot as the Support Bot', async () => {
    const testEnv = env();
    testEnv.TELEGRAM_BOT_TOKEN = testEnv.ADMIN_TELEGRAM_BOT_TOKEN;
    const fetchMock = defaultTelegramMock();
    await handleAdminTelegramWebhook(message(8, '/start'), testEnv);
    const replies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => String(call[1]?.body)).join('\n');
    expect(replies).toContain('ADMIN_SUPPORT_BOT_MUST_DIFFER');
  });

  it.each([
    ['wrong path', message(2, '/start', { path: 'x'.repeat(43) }), 404],
    ['wrong webhook secret', message(3, '/start', { secret: 'x'.repeat(43) }), 401],
    ['unauthorized user', message(4, '/start', { userId: 2001 }), 200],
    ['group chat', message(5, '/start', { chatType: 'group' }), 200],
    ['supergroup chat', message(6, '/start', { chatType: 'supergroup' }), 200]
  ] as const)('rejects %s before admin execution', async (_label, request, status) => {
    const testEnv = env();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleAdminTelegramWebhook(request as any, testEnv);
    expect(response.status).toBe(status);
    expect(testEnv.DB.receipts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows an authorized private chat and renders the button control center', async () => {
    const testEnv = env();
    const fetchMock = defaultTelegramMock();
    const response = await handleAdminTelegramWebhook(message(10, '/start'), testEnv);
    expect(response.status).toBe(200);
    expect(testEnv.DB.receipts[0]).toMatchObject({ status: 'PROCESSED', action: 'MAIN' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.text).toBe('CZ2128 控制中心');
    expect(body.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data))
      .toEqual(expect.arrayContaining(['p:ai', 'p:tg', 'p:cw', 'p:att', 'p:sys', 'p:hist']));
  });

  it('reports a safe bootstrap error when the master key is missing', async () => {
    const testEnv = env();
    delete testEnv.RUNTIME_CONFIG_MASTER_KEY;
    const fetchMock = defaultTelegramMock();
    await handleAdminTelegramWebhook(message(11, '/start'), testEnv);
    const replies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => String(call[1]?.body)).join('\n');
    expect(replies).toContain('RUNTIME_CONFIG_MASTER_KEY_INVALID');
    expect(replies).not.toContain('undefined');
  });

  it('applies a replayed config input exactly once', async () => {
    const testEnv = env();
    defaultTelegramMock();
    await begin(testEnv, 20, 'e:ap');
    const input = message(21, 'New bounded system prompt');
    await handleAdminTelegramWebhook(input.clone() as any, testEnv);
    await handleAdminTelegramWebhook(input.clone() as any, testEnv);
    expect(testEnv.DB.runtime).toHaveLength(1);
    expect(testEnv.DB.runtime[0]).toMatchObject({ key: 'AI_SYSTEM_PROMPT', version: 1 });
    expect(testEnv.DB.history).toHaveLength(1);
    expect(testEnv.DB.receipts.filter((row: any) => row.update_id === '21')).toHaveLength(1);
  });

  it('expires interactive sessions after ten minutes', async () => {
    const testEnv = env();
    defaultTelegramMock();
    await begin(testEnv, 30, 'e:am');
    testEnv.DB.sessions[0].expires_at = Math.floor(Date.now() / 1000) - 1;
    await handleAdminTelegramWebhook(message(31, 'ignored-model'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
  });

  it('deletes secret input, persists only ciphertext and never echoes the secret', async () => {
    const testEnv = env();
    const secretValue = 'new-private-ai-key';
    const fetchMock = defaultTelegramMock();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await begin(testEnv, 40, 'e:ak');
    await handleAdminTelegramWebhook(message(41, secretValue), testEnv);
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.endsWith('/deleteMessage'))).toBe(true);
    const aiCall = fetchMock.mock.calls.find(call => String(call[0]).startsWith('https://ai.example/'));
    const aiBody = JSON.parse(String(aiCall?.[1]?.body));
    expect(aiBody).toMatchObject({ max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] });
    expect(testEnv.DB.runtime[0]).toMatchObject({ key: 'AI_API_KEY', value_text: null });
    const sentReplies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => String(call[1]?.body));
    expect(JSON.stringify({ db: testEnv.DB.runtime, history: testEnv.DB.history, replies: sentReplies }))
      .not.toContain(secretValue);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secretValue);
  });

  it('warns safely when Telegram cannot delete a secret input', async () => {
    const testEnv = env();
    const secretValue = 'another-private-key';
    const sentTexts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init) => {
      const target = String(url);
      if (target.endsWith('/deleteMessage')) return new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 200 });
      if (target.startsWith('https://ai.example/')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
      }
      if (target.endsWith('/sendMessage')) sentTexts.push(JSON.parse(String(init?.body)).text);
      return ok(true);
    });
    await begin(testEnv, 50, 'e:ak');
    await handleAdminTelegramWebhook(message(51, secretValue), testEnv);
    expect(sentTexts.join('\n')).toContain('could not be deleted');
    expect(sentTexts.join('\n')).not.toContain(secretValue);
  });

  it.each([
    ['AI candidate', 'e:am', 'runtime-model', 'https://ai.example/', 401],
    ['Chatwoot candidate', 'e:ct', 'runtime-chatwoot-token', 'https://chatwoot.example/api/v1/profile', 403]
  ] as const)('keeps active config unchanged when %s validation fails', async (_label, action, value, failingUrl, status) => {
    const testEnv = env();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const target = String(url);
      if (target === failingUrl || target.startsWith(failingUrl)) return new Response('private body', { status });
      return ok(true);
    });
    await begin(testEnv, status, action);
    await handleAdminTelegramWebhook(message(status + 1000, value), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
  });

  it('allows locally valid incomplete AI settings with an explicit no-provider-test warning', async () => {
    const testEnv = env();
    delete testEnv.AI_BASE_URL;
    delete testEnv.AI_MODEL;
    delete testEnv.AI_API_KEY;
    const sentTexts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init) => {
      if (String(url).endsWith('/sendMessage')) sentTexts.push(JSON.parse(String(init?.body)).text);
      return ok(true);
    });
    await begin(testEnv, 1400, 'e:ab');
    await handleAdminTelegramWebhook(message(1401, 'https://new-ai.example/v1'), testEnv);
    expect(testEnv.DB.runtime[0]).toMatchObject({ key: 'AI_BASE_URL', value_text: 'https://new-ai.example/v1' });
    expect(sentTexts.join('\n')).toContain('AI_CONFIG_INCOMPLETE');
    expect((await resolveEffectiveEnv(testEnv)).AI_BASE_URL).toBe('https://new-ai.example/v1');
  });

  it('validates and confirms a Chatwoot API URL before activation', async () => {
    const testEnv = env();
    const sentTexts: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init) => {
      const target = String(url);
      if (target.endsWith('/api/v1/profile')) {
        expect(new Headers(init?.headers).get('api_access_token')).toBe('cw-token');
        return new Response('{}', { status: 200 });
      }
      if (target.endsWith('/sendMessage')) sentTexts.push(JSON.parse(String(init?.body)).text);
      return ok(true);
    });
    await begin(testEnv, 1500, 'e:cu');
    await handleAdminTelegramWebhook(message(1501, 'https://new-chatwoot.example'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
    expect(sentTexts.join('\n')).toContain('不会自动重配外部 webhook');
    await handleAdminTelegramWebhook(callback(1502, 'c:yes'), testEnv);
    expect(testEnv.DB.runtime[0]).toMatchObject({
      key: 'CHATWOOT_API_URL', value_text: 'https://new-chatwoot.example', version: 1
    });
    expect(fetchMock.mock.calls.some(call => String(call[0]) === 'https://new-chatwoot.example/api/v1/profile')).toBe(true);
  });

  it.each([
    ['getMe', '/getMe', { ok: false, error_code: 401 }],
    ['group validation', '/getChat', { ok: true, result: { type: 'group', is_forum: false } }]
  ] as const)('keeps the old support profile when %s fails', async (_label, failingPath, payload) => {
    const testEnv = env();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.includes(failingPath)) return new Response(JSON.stringify(payload), { status: 200 });
      if (target.includes('/getMe')) return ok({ id: 777, is_bot: true });
      if (target.includes('/deleteMessage') || target.includes('/sendMessage') || target.includes('/answerCallbackQuery')) return ok(true);
      return ok({ status: 'administrator', can_manage_topics: true });
    });
    await begin(testEnv, 60, 'e:tbot');
    await handleAdminTelegramWebhook(message(61, '222222:new-support-abcdefghijklmnopqrstuvwxyz'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
    expect((await resolveEffectiveEnv(testEnv)).TELEGRAM_BOT_TOKEN).toBe(testEnv.TELEGRAM_BOT_TOKEN);
  });

  it('does not activate a bot when setWebhook fails', async () => {
    const testEnv = env();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.includes('/getMe')) return ok({ id: 777, is_bot: true });
      if (target.includes('/getChatMember')) return ok({ status: 'administrator', can_manage_topics: true });
      if (target.includes('/getChat')) return ok({ type: 'supergroup', is_forum: true });
      if (target.includes('/setWebhook')) return new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 200 });
      return ok(true);
    });
    await begin(testEnv, 70, 'e:tbot');
    await handleAdminTelegramWebhook(message(71, '222222:new-support-abcdefghijklmnopqrstuvwxyz'), testEnv);
    await handleAdminTelegramWebhook(callback(72, 'c:yes'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
  });

  it('rolls back the new webhook if D1 activation fails', async () => {
    const testEnv = env();
    const fetchMock = defaultTelegramMock();
    await begin(testEnv, 80, 'e:tbot');
    await handleAdminTelegramWebhook(message(81, '222222:new-support-abcdefghijklmnopqrstuvwxyz'), testEnv);
    testEnv.DB.failBatch = true;
    await handleAdminTelegramWebhook(callback(82, 'c:yes'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes('222222:new-support-abcdefghijklmnopqrstuvwxyz/setWebhook'))).toBe(true);
    expect(urls.some(url => url.includes('222222:new-support-abcdefghijklmnopqrstuvwxyz/deleteWebhook'))).toBe(true);
  });

  it('activates a new webhook identity even if old deleteWebhook fails', async () => {
    const testEnv = env();
    const newToken = '222222:new-support-abcdefghijklmnopqrstuvwxyz';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.includes('/getMe')) return ok({ id: 777, is_bot: true, username: 'new_bot' });
      if (target.includes('/getChatMember')) return ok({ status: 'administrator', can_manage_topics: true });
      if (target.includes('/getChat')) return ok({ type: 'supergroup', is_forum: true });
      if (target.includes(testEnv.TELEGRAM_BOT_TOKEN) && target.endsWith('/deleteWebhook')) {
        return new Response(JSON.stringify({ ok: false, error_code: 500 }), { status: 200 });
      }
      return ok(true);
    });
    await begin(testEnv, 90, 'e:tbot');
    await handleAdminTelegramWebhook(message(91, newToken), testEnv);
    const candidateSession = structuredClone(testEnv.DB.sessions[0]);
    const confirmation = callback(92, 'c:yes');
    await handleAdminTelegramWebhook(confirmation.clone() as any, testEnv);
    await handleAdminTelegramWebhook(confirmation.clone() as any, testEnv);
    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.TELEGRAM_BOT_TOKEN).toBe(newToken);
    expect(effective.TELEGRAM_SECRET_PATH).not.toBe('old-path');
    expect(effective.TELEGRAM_WEBHOOK_SECRET).not.toBe('old-secret');
    expect(candidateSession.candidate_value_text).toBeNull();
    expect(JSON.stringify(candidateSession)).not.toContain(newToken);
    expect(testEnv.DB.history.filter((row: any) => row.key === 'TELEGRAM_SUPPORT_PROFILE')).toHaveLength(1);
    expect(vi.mocked(globalThis.fetch).mock.calls
      .filter(call => String(call[0]).includes(`${newToken}/setWebhook`))).toHaveLength(1);

    testEnv.QUEUE = { send: vi.fn(async () => undefined) };
    const update = {
      update_id: 500, message: {
        message_id: 1, message_thread_id: 2, chat: { id: -10099 }, from: { id: 1001, is_bot: false }, text: 'test'
      }
    };
    const oldResponse = await Worker.fetch(new Request('https://worker.example/webhooks/telegram/old-path', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'old-secret' }, body: JSON.stringify(update)
    }), testEnv, {} as any);
    const newResponse = await Worker.fetch(new Request(`https://worker.example/webhooks/telegram/${effective.TELEGRAM_SECRET_PATH}`, {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': effective.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify(update)
    }), testEnv, {} as any);
    expect(oldResponse.status).toBe(401);
    expect(newResponse.status).toBe(200);
    expect(testEnv.QUEUE.send).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation and atomically resets topics for group migration', async () => {
    const testEnv = env();
    testEnv.DB.conversations.push({
      id: 'c1', operator_channel: 'telegram', operator_thread_ref: '7', operator_thread_status: 'CLOSED', version: 1
    });
    defaultTelegramMock();
    await begin(testEnv, 100, 'e:tgroup');
    await handleAdminTelegramWebhook(message(101, '-1001234'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
    expect(testEnv.DB.conversations[0].operator_thread_ref).toBe('7');
    const confirmation = callback(102, 'c:yes');
    await handleAdminTelegramWebhook(confirmation.clone() as any, testEnv);
    await handleAdminTelegramWebhook(confirmation.clone() as any, testEnv);
    expect(testEnv.DB.runtime[0]).toMatchObject({ key: 'BOT_GROUP_ID', value_text: '-1001234' });
    expect(testEnv.DB.conversations[0]).toMatchObject({ operator_thread_ref: null, operator_thread_status: 'OPEN' });
    expect(testEnv.DB.history.filter((row: any) => row.key === 'BOT_GROUP_ID')).toHaveLength(1);
  });

  it('leaves group and topic mappings unchanged when validation or D1 fails', async () => {
    const invalidEnv = env();
    invalidEnv.DB.conversations.push({ id: 'c1', operator_channel: 'telegram', operator_thread_ref: '7', operator_thread_status: 'OPEN', version: 1 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('/getMe')) return ok({ id: 777, is_bot: true });
      if (String(url).includes('/getChat')) return ok({ type: 'group', is_forum: false });
      return ok(true);
    });
    await begin(invalidEnv, 110, 'e:tgroup');
    await handleAdminTelegramWebhook(message(111, '-1001234'), invalidEnv);
    expect(invalidEnv.DB.runtime).toHaveLength(0);
    expect(invalidEnv.DB.conversations[0].operator_thread_ref).toBe('7');
    vi.restoreAllMocks();

    const failingEnv = env();
    failingEnv.DB.conversations.push({ id: 'c1', operator_channel: 'telegram', operator_thread_ref: '7', operator_thread_status: 'OPEN', version: 1 });
    defaultTelegramMock();
    await begin(failingEnv, 112, 'e:tgroup');
    await handleAdminTelegramWebhook(message(113, '-1001234'), failingEnv);
    failingEnv.DB.failBatch = true;
    await handleAdminTelegramWebhook(callback(114, 'c:yes'), failingEnv);
    expect(failingEnv.DB.runtime).toHaveLength(0);
    expect(failingEnv.DB.conversations[0].operator_thread_ref).toBe('7');
  });

  it('shows secret history without plaintext or ciphertext', async () => {
    const testEnv = env();
    await setSecretOverride(testEnv, 'AI_API_KEY', 'history-private-secret', 0, '1001', '120');
    const fetchMock = defaultTelegramMock();
    await handleAdminTelegramWebhook(callback(121, 'p:hist'), testEnv);
    const sent = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => String(call[1]?.body)).join('\n');
    expect(sent).toContain('SECRET UPDATED');
    expect(sent).not.toContain('history-private-secret');
    expect(sent).not.toContain(testEnv.DB.history[0].ciphertext);
    expect(await decryptRuntimeSecret(masterKey(), 'AI_API_KEY', testEnv.DB.history[0].ciphertext, testEnv.DB.history[0].nonce))
      .toBe('history-private-secret');
  });
});
