import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Worker from '../src/index';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { setSecretOverride } from '../src/runtime-config/service';
import { RuntimeDb, masterKey } from './helpers/runtime-db';

const CURRENT_TOKEN = '111111:current-unified-abcdefghijklmnopqrstuvwxyz';
const LEGACY_TOKEN = '999999:legacy-admin-abcdefghijklmnopqrstuvwxyz';
const NEW_TOKEN = '222222:new-unified-abcdefghijklmnopqrstuvwxyz';
const ADMIN_PATH = 'legacy_admin_path_abcdefghijklmnopqrstuvwxyz';
const ADMIN_SECRET = 'legacy_admin_secret_abcdefghijklmnopqrstuvwxyz';

class MockQueue {
  messages: any[] = [];
  async send(message: any) {
    this.messages.push(message);
  }
}

function ok(result: any = true) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function baseEnv() {
  return {
    DB: new RuntimeDb(),
    QUEUE: new MockQueue(),
    RUNTIME_CONFIG_MASTER_KEY: masterKey(),
    TELEGRAM_BOT_TOKEN: CURRENT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: 'current-secret',
    TELEGRAM_SECRET_PATH: 'current-path',
    BOT_GROUP_ID: '-10099',
    ADMIN_TELEGRAM_BOT_TOKEN: LEGACY_TOKEN,
    ADMIN_TELEGRAM_WEBHOOK_SECRET: ADMIN_SECRET,
    ADMIN_TELEGRAM_SECRET_PATH: ADMIN_PATH,
    ADMIN_TELEGRAM_USER_IDS: '1001',
    TELEGRAM_NOTIFY_CRISP_OPERATOR: 'silent',
    TELEGRAM_NOTIFY_TELEGRAM_OPERATOR: 'normal',
    TELEGRAM_NOTIFY_MANUAL_OFF: 'silent',
    AI_BASE_URL: 'https://ai.example/v1',
    AI_MODEL: 'model',
    AI_API_KEY: 'key'
  } as any;
}

function privateMessage(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      from: { id: 1001, is_bot: false },
      chat: { id: 1001, type: 'private' }
    }
  };
}

function privateCallback(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: 1001 },
      message: { message_id: updateId, chat: { id: 1001, type: 'private' } }
    }
  };
}

function supportMessage(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      message_thread_id: 40,
      text: 'operator reply',
      from: { id: 3001, is_bot: false },
      chat: { id: -10099, type: 'supergroup' }
    }
  };
}

function supportAiCallback(updateId: number) {
  return {
    update_id: updateId,
    callback_query: {
      id: `support-cb-${updateId}`,
      data: 'ai:off',
      from: { id: 3001 },
      message: {
        from: { id: 222222, is_bot: true },
        message_id: 200 + updateId,
        message_thread_id: 40,
        chat: { id: -10099, type: 'supergroup' }
      }
    }
  };
}

function unifiedRequest(payload: any, path = 'current-path', secret = 'current-secret') {
  return new Request(`https://worker.example/webhooks/telegram/${path}`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(payload)
  });
}

function legacyRequest(payload: any) {
  return new Request(`https://worker.example/webhooks/admin-telegram/${ADMIN_PATH}`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': ADMIN_SECRET },
    body: JSON.stringify(payload)
  });
}

function tokenFromUrl(url: string): string | null {
  const match = url.match(/api\.telegram\.org\/bot(.+?)\//);
  return match?.[1] || null;
}

interface ProviderOptions {
  failSetWebhook?: boolean;
  failDelete?: Record<string, number>;
  invalidForum?: boolean;
  missingTopicPermission?: boolean;
}

function providerMock(options: ProviderOptions = {}) {
  const remainingDeleteFailures = new Map(
    Object.entries(options.failDelete || {}).map(([token, count]) => [token, count])
  );
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const target = String(url);
    const token = tokenFromUrl(target);
    if (target.endsWith('/getMe')) {
      if (token === NEW_TOKEN) return ok({ id: 222222, is_bot: true, username: 'new_unified_bot' });
      return ok({ id: 111111, is_bot: true, username: 'existing_bot' });
    }
    if (target.endsWith('/getChat')) {
      return ok(options.invalidForum
        ? { id: -10099, type: 'group', is_forum: false }
        : { id: -10099, type: 'supergroup', is_forum: true });
    }
    if (target.endsWith('/getChatMember')) {
      return ok(options.missingTopicPermission
        ? { status: 'member', can_manage_topics: false }
        : { status: 'administrator', can_manage_topics: true });
    }
    if (target.endsWith('/setWebhook') && options.failSetWebhook) {
      return new Response(JSON.stringify({ ok: false, error_code: 500 }), { status: 200 });
    }
    if (target.endsWith('/deleteWebhook') && token) {
      const remaining = remainingDeleteFailures.get(token) || 0;
      if (remaining > 0) {
        remainingDeleteFailures.set(token, remaining - 1);
        return new Response(JSON.stringify({ ok: false, error_code: 500 }), { status: 200 });
      }
    }
    return ok({ message_id: 1 });
  });
}

async function beginUnifiedRotation(env: any, startId: number, candidate = NEW_TOKEN) {
  await Worker.fetch(unifiedRequest(privateCallback(startId, 'e:tbot')), env, {} as any);
  await Worker.fetch(unifiedRequest(privateMessage(startId + 1, candidate)), env, {} as any);
}

async function beginLegacyRotation(env: any, startId: number, candidate = NEW_TOKEN) {
  await Worker.fetch(legacyRequest(privateCallback(startId, 'e:tbot')), env, {} as any);
  await Worker.fetch(legacyRequest(privateMessage(startId + 1, candidate)), env, {} as any);
}

function webhookCalls(fetchMock: any, method: 'setWebhook' | 'deleteWebhook'): any[][] {
  return fetchMock.mock.calls.filter((call: any[]) => String(call[0]).endsWith(`/${method}`));
}

describe('one-click unified Telegram Bot rotation', () => {
  let env: any;

  beforeEach(() => {
    env = baseEnv();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['Unified/current token', 'unified', CURRENT_TOKEN],
    ['Unified/legacy token', 'unified', LEGACY_TOKEN],
    ['Legacy/current token', 'legacy', CURRENT_TOKEN],
    ['Legacy/legacy token', 'legacy', LEGACY_TOKEN]
  ] as const)('rejects existing identity %s with no destructive provider mutation', async (_label, ingress, candidate) => {
    const fetchMock = providerMock();
    if (ingress === 'unified') {
      await Worker.fetch(unifiedRequest(privateCallback(10, 'e:tbot')), env, {} as any);
      const baseline = fetchMock.mock.calls.length;
      await Worker.fetch(unifiedRequest(privateMessage(11, candidate)), env, {} as any);
      const newCalls = fetchMock.mock.calls.slice(baseline).map(call => String(call[0]));
      expect(newCalls.some(url => url.endsWith('/deleteMessage'))).toBe(false);
      expect(newCalls.some(url => url.endsWith('/setWebhook') || url.endsWith('/deleteWebhook'))).toBe(false);
    } else {
      await Worker.fetch(legacyRequest(privateCallback(10, 'e:tbot')), env, {} as any);
      const baseline = fetchMock.mock.calls.length;
      await Worker.fetch(legacyRequest(privateMessage(11, candidate)), env, {} as any);
      const newCalls = fetchMock.mock.calls.slice(baseline).map(call => String(call[0]));
      expect(newCalls.some(url => url.endsWith('/deleteMessage'))).toBe(false);
      expect(newCalls.some(url => url.endsWith('/setWebhook') || url.endsWith('/deleteWebhook'))).toBe(false);
    }
    expect(env.DB.runtime).toHaveLength(0);
    expect(env.DB.history).toHaveLength(0);
  });

  it.each([
    ['forum validation', { invalidForum: true }],
    ['topic permission', { missingTopicPermission: true }]
  ] as const)('candidate %s failure leaves profile and webhooks untouched', async (_label, options) => {
    const fetchMock = providerMock(options);
    await beginUnifiedRotation(env, 20);
    expect(env.DB.runtime).toHaveLength(0);
    expect(env.DB.history).toHaveLength(0);
    expect(webhookCalls(fetchMock, 'setWebhook')).toHaveLength(0);
    expect(webhookCalls(fetchMock, 'deleteWebhook')).toHaveLength(0);
  });

  it('setWebhook failure leaves D1 and both old webhooks untouched', async () => {
    const fetchMock = providerMock({ failSetWebhook: true });
    await beginUnifiedRotation(env, 30);
    await Worker.fetch(unifiedRequest(privateCallback(32, 'c:yes')), env, {} as any);

    expect(env.DB.runtime).toHaveLength(0);
    expect(env.DB.history).toHaveLength(0);
    expect(webhookCalls(fetchMock, 'setWebhook')).toHaveLength(1);
    expect(webhookCalls(fetchMock, 'deleteWebhook')).toHaveLength(0);
  });

  it('D1 activation failure compensates only the candidate webhook and leaves old identities active', async () => {
    const fetchMock = providerMock();
    await beginUnifiedRotation(env, 40);
    env.DB.failBatch = true;
    await Worker.fetch(unifiedRequest(privateCallback(42, 'c:yes')), env, {} as any);

    expect(env.DB.runtime).toHaveLength(0);
    expect(env.DB.history).toHaveLength(0);
    const deletes = webhookCalls(fetchMock, 'deleteWebhook').map(call => tokenFromUrl(String(call[0])));
    expect(deletes).toEqual([NEW_TOKEN]);
    expect(deletes).not.toContain(CURRENT_TOKEN);
    expect(deletes).not.toContain(LEGACY_TOKEN);
  });

  it('performs a complete one-click cutover and the new Bot immediately handles Admin, Support and AI callbacks', async () => {
    const fetchMock = providerMock();
    await beginUnifiedRotation(env, 50);
    const confirmationBodies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)));
    expect(confirmationBodies.some(body =>
      String(body.text).includes('新 Bot 将立即接管后台和客服群') &&
      String(body.text).includes('旧 Admin Bot webhook 将停用')
    )).toBe(true);
    expect(JSON.stringify(confirmationBodies)).not.toContain(NEW_TOKEN);

    await Worker.fetch(unifiedRequest(privateCallback(52, 'c:yes')), env, {} as any);

    expect(env.DB.runtime).toHaveLength(1);
    expect(env.DB.runtime[0]).toMatchObject({ key: 'TELEGRAM_SUPPORT_PROFILE', version: 1 });
    expect(env.DB.sessions).toHaveLength(0);
    expect(env.DB.receipts.at(-1)).toMatchObject({ action: 'BOT_ROTATION_SUCCESS', status: 'PROCESSED' });

    const setCalls = webhookCalls(fetchMock, 'setWebhook');
    expect(setCalls).toHaveLength(1);
    const setBody = JSON.parse(String(setCalls[0][1]?.body));
    expect(tokenFromUrl(String(setCalls[0][0]))).toBe(NEW_TOKEN);
    expect(setBody).toMatchObject({
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true
    });

    const deletes = webhookCalls(fetchMock, 'deleteWebhook');
    expect(deletes.map(call => tokenFromUrl(String(call[0])))).toEqual([CURRENT_TOKEN, LEGACY_TOKEN]);
    for (const call of deletes) {
      expect(JSON.parse(String(call[1]?.body))).toEqual({ drop_pending_updates: false });
    }
    expect(deletes.some(call => tokenFromUrl(String(call[0])) === NEW_TOKEN)).toBe(false);
    const allCalls = fetchMock.mock.calls as any[][];
    expect(allCalls.indexOf(setCalls[0])).toBeLessThan(allCalls.indexOf(deletes[0]));

    const effective = await resolveEffectiveEnv(env);
    const newPath = effective.TELEGRAM_SECRET_PATH;
    const newSecret = effective.TELEGRAM_WEBHOOK_SECRET;

    await Worker.fetch(unifiedRequest(privateMessage(53, '/start'), newPath, newSecret), env, {} as any);
    expect(fetchMock.mock.calls.some(call =>
      String(call[0]).includes(`bot${NEW_TOKEN}/sendMessage`) &&
      String(call[1]?.body).includes('CZ2128 控制中心')
    )).toBe(true);

    await Worker.fetch(unifiedRequest(supportMessage(54), newPath, newSecret), env, {} as any);
    expect(env.QUEUE.messages.at(-1)).toMatchObject({
      eventId: 'tg:1:54',
      type: 'message_created',
      payload: { supportProfileVersion: 1, updateRef: '54', threadRef: '40' }
    });

    await Worker.fetch(unifiedRequest(supportAiCallback(55), newPath, newSecret), env, {} as any);
    expect(env.QUEUE.messages.at(-1)).toMatchObject({
      eventId: 'tg:1:55',
      type: 'control_action',
      payload: { supportProfileVersion: 1, action: 'AI_OFF', callbackQueryRef: 'support-cb-55' }
    });
  });

  it('deduplicates identical old Support/Admin retirement targets and never deletes the new Bot', async () => {
    env.ADMIN_TELEGRAM_BOT_TOKEN = CURRENT_TOKEN;
    const fetchMock = providerMock();
    await beginUnifiedRotation(env, 60);
    await Worker.fetch(unifiedRequest(privateCallback(62, 'c:yes')), env, {} as any);

    const deletes = webhookCalls(fetchMock, 'deleteWebhook');
    expect(deletes).toHaveLength(1);
    expect(tokenFromUrl(String(deletes[0][0]))).toBe(CURRENT_TOKEN);
    expect(deletes.some(call => tokenFromUrl(String(call[0])) === NEW_TOKEN)).toBe(false);
    expect(env.DB.receipts.at(-1)).toMatchObject({ action: 'BOT_ROTATION_SUCCESS' });
  });

  it.each([
    ['old Support', CURRENT_TOKEN, 'OLD_SUPPORT', LEGACY_TOKEN],
    ['legacy Admin', LEGACY_TOKEN, 'LEGACY_ADMIN', CURRENT_TOKEN]
  ] as const)('keeps the new profile authoritative when %s retirement fails and retries only that target', async (
    _label,
    failingToken,
    pendingCategory,
    alreadyRetiredToken
  ) => {
    const fetchMock = providerMock({ failDelete: { [failingToken]: 1 } });
    await beginUnifiedRotation(env, 70);
    await Worker.fetch(unifiedRequest(privateCallback(72, 'c:yes')), env, {} as any);

    expect(env.DB.runtime[0]).toMatchObject({ key: 'TELEGRAM_SUPPORT_PROFILE', version: 1 });
    expect(env.DB.sessions).toHaveLength(1);
    expect(env.DB.sessions[0]).toMatchObject({
      action: 'RETIRE_BOT_WEBHOOKS',
      expected_version: 1
    });
    expect(JSON.parse(env.DB.sessions[0].context_json)).toEqual({
      previousSupportVersion: 0,
      pending: [pendingCategory]
    });
    expect(env.DB.receipts.at(-1)).toMatchObject({
      action: 'BOT_ROTATION_RETIREMENT_INCOMPLETE',
      status: 'PROCESSED'
    });
    const partialReplies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)).text);
    expect(partialReplies.some(text => String(text).includes('退役未完全成功'))).toBe(true);
    expect(partialReplies.some(text => String(text).includes('操作已确认并完成'))).toBe(false);

    const effective = await resolveEffectiveEnv(env);
    const newPath = effective.TELEGRAM_SECRET_PATH;
    const newSecret = effective.TELEGRAM_WEBHOOK_SECRET;
    const setCountBeforeRetry = webhookCalls(fetchMock, 'setWebhook').length;
    const historyCountBeforeRetry = env.DB.history.length;
    const retiredCountBeforeRetry = webhookCalls(fetchMock, 'deleteWebhook')
      .filter(call => tokenFromUrl(String(call[0])) === alreadyRetiredToken).length;

    await Worker.fetch(unifiedRequest(privateMessage(73, '/start'), newPath, newSecret), env, {} as any);
    expect(env.DB.sessions[0]?.action).toBe('RETIRE_BOT_WEBHOOKS');
    await Worker.fetch(unifiedRequest(privateCallback(74, 't:trr'), newPath, newSecret), env, {} as any);

    expect(webhookCalls(fetchMock, 'setWebhook')).toHaveLength(setCountBeforeRetry);
    expect(env.DB.history).toHaveLength(historyCountBeforeRetry);
    expect(env.DB.runtime[0].version).toBe(1);
    expect(webhookCalls(fetchMock, 'deleteWebhook')
      .filter(call => tokenFromUrl(String(call[0])) === alreadyRetiredToken)).toHaveLength(retiredCountBeforeRetry);
    expect(webhookCalls(fetchMock, 'deleteWebhook')
      .filter(call => tokenFromUrl(String(call[0])) === failingToken)).toHaveLength(2);
    expect(env.DB.sessions).toHaveLength(0);
    expect(env.DB.receipts.at(-1)).toMatchObject({
      action: 'BOT_ROTATION_RETIREMENT_COMPLETE',
      status: 'PROCESSED'
    });
  });

  it('retries retirement from encrypted prior profile history on a later generation without re-rotating', async () => {
    const priorToken = '333333:prior-runtime-abcdefghijklmnopqrstuvwxyz';
    await setSecretOverride(
      env,
      'TELEGRAM_SUPPORT_PROFILE',
      JSON.stringify({
        bot_token: priorToken,
        webhook_secret: 'prior_runtime_secret_abcdefghijklmnopqrstuvwxyz',
        webhook_path: 'prior_runtime_path_abcdefghijklmnopqrstuvwxyz'
      }),
      0,
      'seed',
      'seed-1',
      'BOT_ROTATE'
    );
    const before = await resolveEffectiveEnv(env);
    const fetchMock = providerMock({ failDelete: { [priorToken]: 1 } });

    await Worker.fetch(
      unifiedRequest(privateCallback(90, 'e:tbot'), before.TELEGRAM_SECRET_PATH, before.TELEGRAM_WEBHOOK_SECRET),
      env,
      {} as any
    );
    await Worker.fetch(
      unifiedRequest(privateMessage(91, NEW_TOKEN), before.TELEGRAM_SECRET_PATH, before.TELEGRAM_WEBHOOK_SECRET),
      env,
      {} as any
    );
    await Worker.fetch(
      unifiedRequest(privateCallback(92, 'c:yes'), before.TELEGRAM_SECRET_PATH, before.TELEGRAM_WEBHOOK_SECRET),
      env,
      {} as any
    );

    expect(env.DB.runtime[0]).toMatchObject({ key: 'TELEGRAM_SUPPORT_PROFILE', version: 2 });
    expect(JSON.parse(env.DB.sessions[0].context_json)).toEqual({
      previousSupportVersion: 1,
      pending: ['OLD_SUPPORT']
    });

    const active = await resolveEffectiveEnv(env);
    const setCountBeforeRetry = webhookCalls(fetchMock, 'setWebhook').length;
    await Worker.fetch(
      unifiedRequest(privateCallback(93, 't:trr'), active.TELEGRAM_SECRET_PATH, active.TELEGRAM_WEBHOOK_SECRET),
      env,
      {} as any
    );

    expect(env.DB.runtime[0].version).toBe(2);
    expect(env.DB.history.filter((row: any) => row.key === 'TELEGRAM_SUPPORT_PROFILE').map((row: any) => row.version))
      .toEqual([1, 2]);
    expect(webhookCalls(fetchMock, 'setWebhook')).toHaveLength(setCountBeforeRetry);
    expect(webhookCalls(fetchMock, 'deleteWebhook')
      .filter(call => tokenFromUrl(String(call[0])) === priorToken)).toHaveLength(2);
    expect(env.DB.sessions).toHaveLength(0);
    expect(env.DB.receipts.at(-1)).toMatchObject({ action: 'BOT_ROTATION_RETIREMENT_COMPLETE' });
  });

  it('legacy Admin can initiate a genuinely new third-Bot rotation and its own webhook is retired in the same confirmation', async () => {
    const fetchMock = providerMock();
    await beginLegacyRotation(env, 80);
    await Worker.fetch(legacyRequest(privateCallback(82, 'c:yes')), env, {} as any);

    const effective = await resolveEffectiveEnv(env);
    expect(effective.TELEGRAM_BOT_TOKEN).toBe(NEW_TOKEN);
    expect(env.DB.runtime[0]).toMatchObject({ version: 1 });
    expect(webhookCalls(fetchMock, 'deleteWebhook').map(call => tokenFromUrl(String(call[0]))))
      .toEqual([CURRENT_TOKEN, LEGACY_TOKEN]);
    expect(env.DB.receipts.at(-1)).toMatchObject({ action: 'BOT_ROTATION_SUCCESS', status: 'PROCESSED' });
  });
});
