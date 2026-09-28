import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { restoreEnvOverride, setPlainOverride, setSecretOverride } from '../src/runtime-config/service';
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
    ADMIN_TELEGRAM_USER_IDS: '1001,1002',
    AI_BASE_URL: 'https://ai.example/v1',
    AI_MODEL: 'model-current',
    AI_API_KEY: 'env-ai-key',
    AI_REQUEST_TIMEOUT_MS: '30000',
    TELEGRAM_BOT_TOKEN: '111111:support-token-abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_WEBHOOK_SECRET: 'old-secret',
    TELEGRAM_SECRET_PATH: 'old-path',
    BOT_GROUP_ID: '-10099'
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

function message(updateId: number, text: string, userId = 1001) {
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        from: { id: userId },
        chat: { id: userId, type: 'private' }
      }
    })
  });
}

function telegramOk(result: any = true): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function modelResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function mockNetwork(provider: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.telegram.org/')) return telegramOk({ message_id: 1 });
    return provider(url, init);
  });
}

function telegramBodies(fetchMock: any): any[] {
  return fetchMock.mock.calls
    .filter((call: any[]) => String(call[0]).includes('/sendMessage'))
    .map((call: any[]) => JSON.parse(String(call[1]?.body)));
}

function providerCalls(fetchMock: any): any[][] {
  return fetchMock.mock.calls.filter((call: any[]) => !String(call[0]).startsWith('https://api.telegram.org/'));
}

describe('Telegram Admin AI model selector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses model discovery as the default 修改模型 flow and renders a selectable list', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['model-b', 'model-a']));

    await handleAdminTelegramWebhook(callback(2000, 'p:ai'), testEnv);
    const aiPage = telegramBodies(fetchMock).at(-1);
    expect(aiPage.reply_markup.inline_keyboard.flat()).toContainEqual({ text: '修改模型', callback_data: 'am:r' });

    await handleAdminTelegramWebhook(callback(2001, 'am:r'), testEnv);
    const list = telegramBodies(fetchMock).at(-1);
    expect(list.text).toContain('AI 模型');
    expect(list.text).toContain('1. model-a');
    expect(list.text).toContain('2. model-b');
    expect(list.reply_markup.inline_keyboard.flat().map((x: any) => x.callback_data))
      .toEqual(expect.arrayContaining(['am:s:0', 'am:s:1', 'am:r', 'e:am', 'p:ai']));
    expect(testEnv.DB.sessions[0]).toMatchObject({ action: 'AI_MODEL_SELECT', target: 'AI_MODEL', expected_version: 0 });
  });

  it('requests exactly the effective D1 AI_BASE_URL /models endpoint', async () => {
    const testEnv = env();
    await setPlainOverride(testEnv, 'AI_BASE_URL', 'https://runtime-ai.example/v1/', 0, 'seed', 'seed-base');
    const fetchMock = mockNetwork((url) => {
      expect(url).toBe('https://runtime-ai.example/v1/models');
      return modelResponse(['runtime-model']);
    });
    await handleAdminTelegramWebhook(callback(2010, 'am:r'), testEnv);
    expect(providerCalls(fetchMock)).toHaveLength(1);
  });

  it('uses the effective encrypted D1 AI_API_KEY in Authorization without storing it in selector session', async () => {
    const testEnv = env();
    const runtimeKey = 'runtime-private-ai-key';
    await setSecretOverride(testEnv, 'AI_API_KEY', runtimeKey, 0, 'seed', 'seed-key');
    const fetchMock = mockNetwork((_url, init) => {
      expect((init?.headers as any).Authorization).toBe(`Bearer ${runtimeKey}`);
      return modelResponse(['runtime-model']);
    });
    await handleAdminTelegramWebhook(callback(2020, 'am:r'), testEnv);
    expect(providerCalls(fetchMock)).toHaveLength(1);
    expect(JSON.stringify(testEnv.DB.sessions)).not.toContain(runtimeKey);
    expect(JSON.stringify(telegramBodies(fetchMock))).not.toContain(runtimeKey);
  });

  it('keeps Authorization and provider bodies out of Telegram errors', async () => {
    const testEnv = env();
    const secret = 'do-not-leak-this-key';
    testEnv.AI_API_KEY = secret;
    const fetchMock = mockNetwork(() => new Response('private body', { status: 401 }));
    await handleAdminTelegramWebhook(callback(2030, 'am:r'), testEnv);
    expect(JSON.stringify(telegramBodies(fetchMock))).not.toContain(secret);
    expect(JSON.stringify(telegramBodies(fetchMock))).not.toContain('private body');
    expect(telegramBodies(fetchMock).at(-1).text).toContain('API 凭据被上游拒绝');
  });

  it('marks the current model in the selector without placing it in callback_data', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['other', 'model-current']));
    await handleAdminTelegramWebhook(callback(2040, 'am:r'), testEnv);
    const buttons = telegramBodies(fetchMock).at(-1).reply_markup.inline_keyboard.flat();
    expect(buttons.some((button: any) => button.text === '✅ model-current')).toBe(true);
    expect(buttons.map((button: any) => button.callback_data)).not.toContain('model-current');
  });

  it('never places a raw long provider model id into Telegram callback_data', async () => {
    const testEnv = env();
    const longModel = `deployment-${'x'.repeat(180)}`;
    const fetchMock = mockNetwork(() => modelResponse([longModel]));
    await handleAdminTelegramWebhook(callback(2050, 'am:r'), testEnv);
    const buttons = telegramBodies(fetchMock).at(-1).reply_markup.inline_keyboard.flat();
    const select = buttons.find((button: any) => button.callback_data?.startsWith('am:s:'));
    expect(select.callback_data).toBe('am:s:0');
    expect(select.callback_data.length).toBeLessThanOrEqual(64);
    expect(select.callback_data).not.toContain(longModel);
  });

  it('paginates eight models per page without refetching the provider', async () => {
    const testEnv = env();
    const ids = Array.from({ length: 25 }, (_, i) => `model-${String(i).padStart(2, '0')}`);
    const fetchMock = mockNetwork(() => modelResponse(ids));
    await handleAdminTelegramWebhook(callback(2060, 'am:r'), testEnv);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('第 1 / 4 页');
    await handleAdminTelegramWebhook(callback(2061, 'am:p:1'), testEnv);
    const second = telegramBodies(fetchMock).at(-1);
    expect(second.text).toContain('第 2 / 4 页');
    expect(second.text).toContain('9. model-08');
    expect(providerCalls(fetchMock)).toHaveLength(1);
  });

  it('bounds large model lists to 200 and displays a truncation warning', async () => {
    const testEnv = env();
    const ids = Array.from({ length: 240 }, (_, i) => `model-${String(i).padStart(3, '0')}`);
    const fetchMock = mockNetwork(() => modelResponse(ids));
    await handleAdminTelegramWebhook(callback(2070, 'am:r'), testEnv);
    const models = JSON.parse(testEnv.DB.sessions[0].candidate_value_text);
    expect(models).toHaveLength(200);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('上游模型数量较多，仅显示前 200 个。');
  });

  it('further bounds unusually long ids to the existing 20KB Admin session capacity', async () => {
    const testEnv = env();
    const ids = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}-${'x'.repeat(240)}`);
    const fetchMock = mockNetwork(() => modelResponse(ids));
    await handleAdminTelegramWebhook(callback(2080, 'am:r'), testEnv);
    const session = testEnv.DB.sessions[0];
    const models = JSON.parse(session.candidate_value_text);
    expect(session.candidate_value_text.length).toBeLessThanOrEqual(19000);
    expect(models.length).toBeLessThan(200);
    expect(JSON.parse(session.context_json)).toMatchObject({ truncated: true, sessionBounded: true });
    expect(telegramBodies(fetchMock).at(-1).text).toContain(`仅显示前 ${models.length} 个`);
  });

  it('selects a server-side session model and writes AI_MODEL through Runtime Config CAS/history', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['model-a', 'model-b']));
    await handleAdminTelegramWebhook(callback(2090, 'am:r'), testEnv);
    await handleAdminTelegramWebhook(callback(2091, 'am:s:1'), testEnv);
    expect(testEnv.DB.runtime.find((row: any) => row.key === 'AI_MODEL')).toMatchObject({
      value_text: 'model-b', version: 1
    });
    expect(testEnv.DB.history.at(-1)).toMatchObject({
      key: 'AI_MODEL', version: 1, value_text: 'model-b', action: 'SET',
      actor_user_id: '1001', source_update_id: '2091'
    });
    expect(testEnv.DB.sessions).toHaveLength(0);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('建议点击「测试 AI」');
  });

  it('fails closed when AI_MODEL changes after discovery and before selection', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['model-a', 'model-b']));
    await handleAdminTelegramWebhook(callback(2100, 'am:r'), testEnv);
    await setPlainOverride(testEnv, 'AI_MODEL', 'newer-model', 0, 'other-admin', 'external-update');
    await handleAdminTelegramWebhook(callback(2101, 'am:s:0'), testEnv);
    expect(testEnv.DB.runtime.find((row: any) => row.key === 'AI_MODEL')?.value_text).toBe('newer-model');
    expect(testEnv.DB.history.filter((row: any) => row.key === 'AI_MODEL')).toHaveLength(1);
    expect(testEnv.DB.sessions).toHaveLength(0);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('模型配置已被其他操作更新');
  });

  it('fails closed even if another operation changes AI_MODEL and restores ENV before selection', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['model-a']));
    await handleAdminTelegramWebhook(callback(2105, 'am:r'), testEnv);

    await setPlainOverride(testEnv, 'AI_MODEL', 'temporary-model', 0, 'other-admin', 'external-set');
    await restoreEnvOverride(testEnv, 'AI_MODEL', 1, 'other-admin', 'external-restore');
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);

    await handleAdminTelegramWebhook(callback(2106, 'am:s:0'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(testEnv.DB.history.filter((row: any) => row.key === 'AI_MODEL')).toHaveLength(2);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('模型配置已被其他操作更新');
  });

  it('fails closed when the model-selection session expires', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['model-a']));
    await handleAdminTelegramWebhook(callback(2110, 'am:r'), testEnv);
    testEnv.DB.sessions[0].expires_at = Math.floor(Date.now() / 1000) - 1;
    await handleAdminTelegramWebhook(callback(2111, 'am:s:0'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('模型列表已过期，请重新获取。');
  });

  it('refreshes by fetching the provider again and replacing the temporary session list', async () => {
    const testEnv = env();
    let request = 0;
    const fetchMock = mockNetwork(() => modelResponse(request++ === 0 ? ['first-model'] : ['second-model']));
    await handleAdminTelegramWebhook(callback(2120, 'am:r'), testEnv);
    expect(JSON.parse(testEnv.DB.sessions[0].candidate_value_text)).toEqual(['first-model']);
    await handleAdminTelegramWebhook(callback(2121, 'am:r'), testEnv);
    expect(JSON.parse(testEnv.DB.sessions[0].candidate_value_text)).toEqual(['second-model']);
    expect(providerCalls(fetchMock)).toHaveLength(2);
  });

  it('does not fetch when AI API address is incomplete', async () => {
    const testEnv = env();
    delete testEnv.AI_BASE_URL;
    const fetchMock = mockNetwork(() => { throw new Error('provider must not be called'); });
    await handleAdminTelegramWebhook(callback(2130, 'am:r'), testEnv);
    expect(providerCalls(fetchMock)).toHaveLength(0);
    expect(telegramBodies(fetchMock).at(-1).text).toBe('请先配置 AI API 地址和 API Key。');
  });

  it('does not fetch when AI API key is incomplete', async () => {
    const testEnv = env();
    delete testEnv.AI_API_KEY;
    const fetchMock = mockNetwork(() => { throw new Error('provider must not be called'); });
    await handleAdminTelegramWebhook(callback(2131, 'am:r'), testEnv);
    expect(providerCalls(fetchMock)).toHaveLength(0);
    expect(telegramBodies(fetchMock).at(-1).text).toBe('请先配置 AI API 地址和 API Key。');
  });

  it.each([
    [401, 'API 凭据被上游拒绝'],
    [403, 'API 凭据被上游拒绝'],
    [404, '不支持模型列表接口'],
    [405, '不支持模型列表接口'],
    [429, '被限流'],
    [500, '暂时不可用']
  ] as const)('renders a safe Chinese discovery error for HTTP %s and leaves AI_MODEL untouched', async (status, text) => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => new Response('sensitive body', { status }));
    await handleAdminTelegramWebhook(callback(2200 + status, 'am:r'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain(text);
    expect(JSON.stringify(telegramBodies(fetchMock))).not.toContain('sensitive body');
  });

  it.each([
    ['malformed JSON', () => new Response('{broken', { status: 200 }), '响应格式无效'],
    ['empty directory', () => modelResponse([]), '没有返回可用的模型 ID']
  ] as const)('renders a safe Admin error for %s and preserves AI_MODEL', async (_label, response, text) => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => response());
    await handleAdminTelegramWebhook(callback(2132 + fetchMock.mock.calls.length, 'am:r'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain(text);
  });

  it('renders a safe transport error and preserves AI_MODEL', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => { throw new Error('private transport detail'); });
    await handleAdminTelegramWebhook(callback(2134, 'am:r'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('无法连接上游模型服务');
    expect(JSON.stringify(telegramBodies(fetchMock))).not.toContain('private transport detail');
  });

  it('renders a safe timeout error and preserves AI_MODEL', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => {
      const error = new Error('private timeout detail');
      error.name = 'AbortError';
      throw error;
    });
    await handleAdminTelegramWebhook(callback(2133, 'am:r'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('获取上游模型列表超时');
    expect(JSON.stringify(telegramBodies(fetchMock))).not.toContain('private timeout detail');
  });

  it('invalidates an old selector session when refresh fails', async () => {
    const testEnv = env();
    let request = 0;
    const fetchMock = mockNetwork(() => request++ === 0
      ? modelResponse(['old-model'])
      : new Response('', { status: 503 }));

    await handleAdminTelegramWebhook(callback(2135, 'am:r'), testEnv);
    expect(testEnv.DB.sessions[0]?.action).toBe('AI_MODEL_SELECT');
    await handleAdminTelegramWebhook(callback(2136, 'am:r'), testEnv);
    expect(testEnv.DB.sessions.some((row: any) => row.action === 'AI_MODEL_SELECT')).toBe(false);

    await handleAdminTelegramWebhook(callback(2137, 'am:s:0'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('模型列表已过期');
  });

  it('preserves manual model input as a fallback after discovery is unsupported', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => new Response('', { status: 404 }));
    await handleAdminTelegramWebhook(callback(2140, 'am:r'), testEnv);
    expect(telegramBodies(fetchMock).at(-1).reply_markup.inline_keyboard.flat())
      .toContainEqual({ text: '⌨️ 手动输入模型', callback_data: 'e:am' });
    await handleAdminTelegramWebhook(callback(2141, 'e:am'), testEnv);
    await handleAdminTelegramWebhook(message(2142, 'manual-deployment-name'), testEnv);
    expect(testEnv.DB.runtime.find((row: any) => row.key === 'AI_MODEL')?.value_text)
      .toBe('manual-deployment-name');
  });

  it('rejects unauthorized Admin model discovery before provider or Telegram calls', async () => {
    const testEnv = env();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleAdminTelegramWebhook(callback(2150, 'am:r', 9999), testEnv);
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(testEnv.DB.receipts).toHaveLength(0);
    expect(testEnv.DB.sessions).toHaveLength(0);
  });

  it('dedupes a replayed Telegram selection update so mutation/history occur once', async () => {
    const testEnv = env();
    mockNetwork(() => modelResponse(['model-a']));
    await handleAdminTelegramWebhook(callback(2160, 'am:r'), testEnv);
    const select = callback(2161, 'am:s:0');
    await handleAdminTelegramWebhook(select.clone() as any, testEnv);
    await handleAdminTelegramWebhook(select.clone() as any, testEnv);
    expect(testEnv.DB.runtime.filter((row: any) => row.key === 'AI_MODEL')).toHaveLength(1);
    expect(testEnv.DB.history.filter((row: any) => row.key === 'AI_MODEL')).toHaveLength(1);
    expect(testEnv.DB.receipts.filter((row: any) => row.update_id === '999999:2161')).toHaveLength(1);
  });

  it('fails closed if the stored selector session model list is tampered', async () => {
    const testEnv = env();
    const fetchMock = mockNetwork(() => modelResponse(['model-a']));
    await handleAdminTelegramWebhook(callback(2170, 'am:r'), testEnv);
    testEnv.DB.sessions[0].candidate_value_text = JSON.stringify(['model-a', 'bad\nmodel']);
    await handleAdminTelegramWebhook(callback(2171, 'am:s:0'), testEnv);
    expect(testEnv.DB.runtime.some((row: any) => row.key === 'AI_MODEL')).toBe(false);
    expect(telegramBodies(fetchMock).at(-1).text).toContain('操作失败');
  });
});
