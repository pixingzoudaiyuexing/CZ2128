import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { decryptRuntimeSecret } from '../src/runtime-config/crypto';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { setPlainOverride, setSecretOverride } from '../src/runtime-config/service';
import { RuntimeDb, masterKey } from './helpers/runtime-db';
import Worker from '../src/index';
import { resolveCrispWelcome } from '../src/config/crisp-welcome';

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
    CRISP_OPERATOR_NICKNAME: 'ENV 人工客服',
    CRISP_OPERATOR_AVATAR_URL: 'https://example.com/env-operator.png',
    CRISP_AI_NICKNAME: 'ENV 智能客服',
    CRISP_AI_AVATAR_URL: 'https://example.com/env-ai.png',
    TELEGRAM_NOTIFY_CRISP_OPERATOR: 'silent',
    TELEGRAM_NOTIFY_TELEGRAM_OPERATOR: 'normal',
    TELEGRAM_NOTIFY_MANUAL_OFF: 'silent',
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

const crisp12RestoreCases = [
  ['CRISP_OPERATOR_NICKNAME', 'con', 'ENV 人工客服', 'Runtime 人工客服'],
  ['CRISP_OPERATOR_AVATAR_URL', 'coa', 'https://example.com/env-operator.png', 'https://example.com/runtime-operator.png'],
  ['CRISP_AI_NICKNAME', 'can', 'ENV 智能客服', 'Runtime 智能客服'],
  ['CRISP_AI_AVATAR_URL', 'caa', 'https://example.com/env-ai.png', 'https://example.com/runtime-ai.png'],
  ['TELEGRAM_NOTIFY_CRISP_OPERATOR', 'tnc', 'silent', 'normal'],
  ['TELEGRAM_NOTIFY_TELEGRAM_OPERATOR', 'tnt', 'normal', 'silent'],
  ['TELEGRAM_NOTIFY_MANUAL_OFF', 'tnm', 'silent', 'normal']
] as const;

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
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.map((item: any) => item.text)).toEqual([
      '🤖 AI 设置', '💬 Telegram 设置', '🔵 Crisp 设置', '📎 附件设置',
      '💡 关键词回复', '🛡 可靠性管理', '⚙️ 系统状态', '📜 操作历史'
    ]);
    expect(buttons.map((item: any) => item.callback_data)).toEqual([
      'p:ai', 'p:tg', 'p:crisp', 'p:att', 'p:kw', 'p:rel', 'p:sys', 'p:hist'
    ]);
    expect(buttons.map((item: any) => item.callback_data)).not.toContain('p:cw');
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
    expect(sentTexts.join('\n')).toContain('未能自动删除');
    expect(sentTexts.join('\n')).not.toContain(secretValue);
  });

  it('keeps active config unchanged when AI candidate validation fails', async () => {
    const testEnv = env();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.startsWith('https://ai.example/')) return new Response('private body', { status: 401 });
      return ok(true);
    });
    await begin(testEnv, 401, 'e:am');
    await handleAdminTelegramWebhook(message(1401, 'runtime-model'), testEnv);
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

  it('shows Crisp bootstrap status without exposing sensitive values or Chatwoot settings', async () => {
    const testEnv = env();
    testEnv.CRISP_WEBSITE_ID = 'private-website-id';
    testEnv.CRISP_API_IDENTIFIER = 'private-identifier';
    testEnv.CRISP_API_KEY = 'private-api-key';
    testEnv.CRISP_WEBHOOK_SECRET = 'private-webhook-secret';
    const fetchMock = defaultTelegramMock();

    await handleAdminTelegramWebhook(callback(1500, 'p:crisp'), testEnv);

    const body = JSON.parse(String(fetchMock.mock.calls.find(call => String(call[0]).endsWith('/sendMessage'))?.[1]?.body));
    expect(body.text).toContain('🔵 Crisp 设置');
    expect(body.text).toContain('网站 ID：已配置');
    expect(body.text).toContain('API 身份标识：已配置');
    expect(body.text).toContain('API 密钥：已配置');
    expect(body.text).toContain('Webhook 签名密钥：已配置');
    expect(body.text).not.toContain('private-website-id');
    expect(body.text).not.toContain('private-identifier');
    expect(body.text).not.toContain('private-api-key');
    expect(body.text).not.toContain('private-webhook-secret');
    expect(body.text).not.toContain('Chatwoot');
    expect(testEnv.DB.runtime).toHaveLength(0);
  });

  it('makes every Crisp-12 generic Restore ENV action reachable from the normal Admin keyboards', async () => {
    const testEnv = env();
    const fetchMock = defaultTelegramMock();

    await handleAdminTelegramWebhook(callback(1501, 'p:crisp'), testEnv);
    await handleAdminTelegramWebhook(callback(1502, 'p:crispr'), testEnv);
    await handleAdminTelegramWebhook(callback(1503, 'p:tg'), testEnv);
    await handleAdminTelegramWebhook(callback(1504, 'p:tgr'), testEnv);

    const bodies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)));
    const crispPage = bodies.find(body => body.text.includes('🔵 Crisp 设置'));
    const crispRestore = bodies.find(body => body.text === '恢复 Crisp ENV 默认值');
    const telegramPage = bodies.find(body => body.text.startsWith('Telegram 设置'));
    const telegramRestore = bodies.find(body => body.text === '恢复 Telegram 通知 ENV 默认值');

    expect(crispPage.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data)).toContain('p:crispr');
    expect(crispRestore.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data))
      .toEqual(['x:con', 'x:coa', 'x:can', 'x:caa', 'p:crisp']);
    expect(telegramPage.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data)).toContain('p:tgr');
    expect(telegramRestore.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data))
      .toEqual(['x:tnc', 'x:tnt', 'x:tnm', 'p:tg']);
  });

  it.each(crisp12RestoreCases)(
    'restores %s from D1 to its original ENV value through the Admin Restore callback',
    async (key, code, envValue, runtimeValue) => {
      const testEnv = env();
      (testEnv as any)[key] = envValue;
      defaultTelegramMock();

      await begin(testEnv, 1520, `e:${code}`);
      await handleAdminTelegramWebhook(message(1521, runtimeValue), testEnv);

      let effective = await resolveEffectiveEnv(testEnv);
      expect((effective as any)[key]).toBe(runtimeValue);
      expect((effective.runtimeConfigSnapshot?.sources as any)[key]).toBe('D1');

      await handleAdminTelegramWebhook(callback(1522, `x:${code}`), testEnv);

      effective = await resolveEffectiveEnv(testEnv);
      expect(testEnv.DB.runtime.some((row: any) => row.key === key)).toBe(false);
      expect((effective as any)[key]).toBe(envValue);
      expect((effective.runtimeConfigSnapshot?.sources as any)[key]).toBe('ENV');
      expect(testEnv.DB.history.at(-1)).toMatchObject({
        key,
        action: 'RESTORE_ENV',
        is_deleted: 1,
        actor_user_id: '1001',
        source_update_id: '1522'
      });
    }
  );

  it.each(crisp12RestoreCases)(
    'treats Restore ENV for already-ENV %s as a safe no-op',
    async (key, code) => {
      const testEnv = env();
      const fetchMock = defaultTelegramMock();

      await handleAdminTelegramWebhook(callback(1530, `x:${code}`), testEnv);

      expect(testEnv.DB.runtime).toHaveLength(0);
      expect(testEnv.DB.history).toHaveLength(0);
      expect(testEnv.DB.sessions).toHaveLength(0);
      const texts = fetchMock.mock.calls
        .filter(call => String(call[0]).endsWith('/sendMessage'))
        .map(call => JSON.parse(String(call[1]?.body)).text);
      expect(texts).toContain('当前已经使用 ENV。');
    }
  );

  it.each(['p:cw', 'p:cwr', 'e:cu', 'e:ct', 'e:ch', 'x:cu', 'x:ct', 'x:ch'])(
    'blocks legacy Chatwoot callback %s without opening a mutation session',
    async action => {
      const testEnv = env();
      const fetchMock = defaultTelegramMock();
      await handleAdminTelegramWebhook(callback(1510 + action.length, action), testEnv);
      const replies = fetchMock.mock.calls
        .filter(call => String(call[0]).endsWith('/sendMessage'))
        .map(call => JSON.parse(String(call[1]?.body)).text).join('\n');
      expect(replies).toContain('当前仅支持 Crisp，旧 Chatwoot 配置入口已停用');
      expect(testEnv.DB.runtime).toHaveLength(0);
      expect(testEnv.DB.sessions).toHaveLength(0);
    }
  );

  it.each(['SET', 'CONFIRM_SET', 'CONFIRM_RESTORE', 'CONFIRM_ROLLBACK'])(
    'blocks a legacy Chatwoot %s session before any configuration mutation',
    async action => {
      const testEnv = env();
      const fetchMock = defaultTelegramMock();
      testEnv.DB.sessions.push({
        admin_user_id: '1001', action, target: 'CHATWOOT_API_URL', expected_version: 0,
        candidate_value_text: action === 'CONFIRM_SET' ? 'https://blocked.example' : null,
        candidate_ciphertext: null, candidate_nonce: null, context_json: null,
        expires_at: Math.floor(Date.now() / 1000) + 600, updated_at: 1
      });
      if (action === 'SET') {
        await handleAdminTelegramWebhook(message(1600 + action.length, 'https://blocked.example'), testEnv);
      } else {
        await handleAdminTelegramWebhook(callback(1600 + action.length, 'c:yes'), testEnv);
      }
      const replies = fetchMock.mock.calls
        .filter(call => String(call[0]).endsWith('/sendMessage'))
        .map(call => JSON.parse(String(call[1]?.body)).text).join('\n');
      expect(replies).toContain('当前仅支持 Crisp，旧 Chatwoot 配置入口已停用');
      expect(testEnv.DB.runtime).toHaveLength(0);
      expect(testEnv.DB.sessions).toHaveLength(0);
    }
  );

  it('preserves historical Chatwoot config and blocks rollback from history', async () => {
    const testEnv = env();
    await setPlainOverride(testEnv, 'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS', 'files.example', 0, 'seed', 'seed-1');
    const historyId = testEnv.DB.history[0].id;
    const fetchMock = defaultTelegramMock();

    await handleAdminTelegramWebhook(callback(1700, `rb:${historyId}`), testEnv);
    await handleAdminTelegramWebhook(callback(1701, 'p:hist'), testEnv);

    expect(testEnv.DB.runtime).toHaveLength(1);
    expect(testEnv.DB.runtime[0]).toMatchObject({ key: 'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS', version: 1 });
    expect(testEnv.DB.history).toHaveLength(1);
    const sentBodies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)));
    expect(sentBodies.map(body => body.text).join('\n')).toContain('历史 Chatwoot 记录');
    expect(sentBodies.map(body => body.text).join('\n')).toContain('当前仅支持 Crisp，旧 Chatwoot 配置入口已停用');
    const callbackData = sentBodies.flatMap(body => body.reply_markup?.inline_keyboard?.flat().map((item: any) => item.callback_data) || []);
    expect(callbackData).not.toContain(`rb:${historyId}`);
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
    const setWebhookCall = vi.mocked(globalThis.fetch).mock.calls
      .find(call => String(call[0]).includes(`${newToken}/setWebhook`));
    expect(JSON.parse(String(setWebhookCall?.[1]?.body))).toMatchObject({ drop_pending_updates: true });

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
    expect(testEnv.QUEUE.send.mock.calls[0][0]).toMatchObject({
      eventId: 'tg:1:500',
      payload: { supportProfileVersion: 1 }
    });
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
    expect(sent).toContain('密钥已更新');
    expect(sent).not.toContain('history-private-secret');
    expect(sent).not.toContain(testEnv.DB.history[0].ciphertext);
    expect(await decryptRuntimeSecret(masterKey(), 'AI_API_KEY', testEnv.DB.history[0].ciphertext, testEnv.DB.history[0].nonce))
      .toBe('history-private-secret');
  });

  it('manages Crisp welcome text, explicit disable, re-enable and ENV restore through the Chinese UI', async () => {
    const testEnv = env();
    testEnv.CRISP_WELCOME_TEXT = 'ENV 默认欢迎语';
    const fetchMock = defaultTelegramMock();

    await handleAdminTelegramWebhook(callback(1800, 'p:crisp'), testEnv);
    await handleAdminTelegramWebhook(callback(1801, 'p:cwelcome'), testEnv);
    const sentBodies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)));
    expect(sentBodies.at(-2).text).toContain('欢迎语：已启用');
    expect(sentBodies.at(-2).reply_markup.inline_keyboard.flat().map((item: any) => item.text))
      .toContain('👋 欢迎语');
    expect(sentBodies.at(-1).text).toContain('状态：已启用');
    expect(sentBodies.at(-1).text).toContain('ENV 默认欢迎语');

    await begin(testEnv, 1802, 'e:cw');
    await handleAdminTelegramWebhook(message(1803, '新的运行时欢迎语'), testEnv);
    let effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'ENABLED', text: '新的运行时欢迎语', source: 'D1'
    });

    await handleAdminTelegramWebhook(callback(1804, 'w:off'), testEnv);
    effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'DISABLED', text: '新的运行时欢迎语', source: 'D1'
    });

    await begin(testEnv, 1805, 'e:cw');
    await handleAdminTelegramWebhook(message(1806, '停用期间修改后的欢迎语'), testEnv);
    effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'DISABLED', text: '停用期间修改后的欢迎语', source: 'D1'
    });

    await handleAdminTelegramWebhook(callback(1807, 'w:on'), testEnv);
    effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'ENABLED', text: '停用期间修改后的欢迎语', source: 'D1'
    });

    await handleAdminTelegramWebhook(callback(1808, 'x:cw'), testEnv);
    effective = await resolveEffectiveEnv(testEnv);
    expect(resolveCrispWelcome(effective)).toEqual({
      status: 'ENABLED', text: 'ENV 默认欢迎语', source: 'ENV'
    });
    expect(testEnv.DB.history.filter((row: any) => row.key === 'CRISP_WELCOME_CONFIG').map((row: any) => row.version))
      .toEqual([1, 2, 3, 4, 5]);
  });

  it('does not let unauthorized users or expired sessions modify Crisp welcome config', async () => {
    const testEnv = env();
    testEnv.CRISP_WELCOME_TEXT = 'ENV welcome';
    defaultTelegramMock();

    await handleAdminTelegramWebhook(callback(1810, 'w:off', { userId: 2001 }), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);

    await begin(testEnv, 1811, 'e:cw');
    testEnv.DB.sessions[0].expires_at = Math.floor(Date.now() / 1000) - 1;
    await handleAdminTelegramWebhook(message(1812, 'stale session text'), testEnv);
    expect(testEnv.DB.runtime).toHaveLength(0);
  });

  it('renders the current Crisp Picker menu read-only in Chinese without raw JSON', async () => {
    const testEnv = env();
    testEnv.CRISP_MENU_JSON = JSON.stringify({
      picker: {
        id: 'main',
        text: '请选择服务',
        choices: [
          { value: 'plans', label: '查看套餐' },
          { value: 'human', label: '人工客服' }
        ]
      },
      options: [
        { pickerId: 'main', value: 'plans', label: '查看套餐', response: '套餐说明' },
        {
          pickerId: 'main',
          value: 'human',
          label: '人工客服',
          handoff: true,
          next: { id: 'human-next', text: '请选择', choices: [{ value: 'urgent', label: '紧急' }] }
        }
      ]
    });
    const fetchMock = defaultTelegramMock();

    await handleAdminTelegramWebhook(callback(1820, 'p:cmenu'), testEnv);

    const body = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body))).at(-1);
    expect(body.text).toContain('📋 客服菜单');
    expect(body.text).toContain('顶层菜单标题：请选择服务');
    expect(body.text).toContain('查看套餐');
    expect(body.text).toContain('预设回复');
    expect(body.text).toContain('进入下一级菜单');
    expect(body.text).toContain('请求人工客服');
    expect(body.text).toContain('本轮菜单仅提供只读查看');
    expect(body.text).not.toContain('"picker"');
    expect(body.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data))
      .toEqual(['p:crisp']);
  });

});
