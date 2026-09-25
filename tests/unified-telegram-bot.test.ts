import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Worker from '../src/index';
import { RuntimeDb, masterKey } from './helpers/runtime-db';

class MockQueue {
  messages: any[] = [];

  async send(message: any) {
    this.messages.push(message);
  }
}

function ok(result: any = true) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

describe('Unified Telegram Bot routing', () => {
  let env: any;

  beforeEach(() => {
    env = {
      DB: new RuntimeDb(),
      QUEUE: new MockQueue(),
      RUNTIME_CONFIG_MASTER_KEY: masterKey(),
      TELEGRAM_BOT_TOKEN: '111111:unified-bot-abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_WEBHOOK_SECRET: 'unified-secret',
      TELEGRAM_SECRET_PATH: 'unified-path',
      BOT_GROUP_ID: '-10099',
      ADMIN_TELEGRAM_USER_IDS: '1001,1002',
      TELEGRAM_NOTIFY_CRISP_OPERATOR: 'silent',
      TELEGRAM_NOTIFY_TELEGRAM_OPERATOR: 'normal',
      TELEGRAM_NOTIFY_MANUAL_OFF: 'silent',
      AI_BASE_URL: 'https://ai.example/v1',
      AI_MODEL: 'model',
      AI_API_KEY: 'key'
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ message_id: 1 }));
  });

  afterEach(() => vi.restoreAllMocks());

  function telegramRequest(payload: any, path = 'unified-path', secret = 'unified-secret') {
    return new Request(`https://worker.example/webhooks/telegram/${path}`, {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(payload)
    });
  }

  function privateMessage(updateId: number, userId: number, text = '/start') {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        from: { id: userId, is_bot: false },
        chat: { id: userId, type: 'private' }
      }
    };
  }

  function privateCallback(updateId: number, data: string, userId = 1001) {
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        data,
        from: { id: userId },
        message: { message_id: updateId, chat: { id: userId, type: 'private' } }
      }
    };
  }

  function supportMessage(updateId: number, chat: { id: number; type: string } = { id: -10099, type: 'supergroup' }) {
    return {
      update_id: updateId,
      message: {
        message_id: 100 + updateId,
        message_thread_id: 40,
        text: 'human reply',
        from: { id: 3001, is_bot: false },
        chat
      }
    };
  }

  it('routes an authorized private /start to the existing Admin menu and never Support Queue', async () => {
    const response = await Worker.fetch(telegramRequest(privateMessage(1, 1001)), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
    const send = vi.mocked(globalThis.fetch).mock.calls.find(call => String(call[0]).endsWith('/sendMessage'));
    expect(String(send?.[0])).toContain(`bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(String(send?.[1]?.body)).toContain('AI 知识库');
    expect(env.DB.receipts).toHaveLength(1);
    expect(env.DB.receipts[0]).toMatchObject({ update_id: '1', admin_user_id: '1001', status: 'PROCESSED' });
  });

  it('accepts an unauthorized private user without Admin receipt, provider action, or Queue event', async () => {
    const response = await Worker.fetch(telegramRequest(privateMessage(2, 2001)), env, {} as any);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Accepted');
    expect(env.DB.receipts).toHaveLength(0);
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('routes an authorized private callback through the existing Admin callback handler', async () => {
    const response = await Worker.fetch(telegramRequest(privateCallback(3, 'p:ai')), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(env.DB.receipts).toHaveLength(1);
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.some(call => String(call[0]).endsWith('/answerCallbackQuery'))).toBe(true);
    const page = calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)))
      .find(body => String(body.text).startsWith('AI 设置'));
    expect(page).toBeTruthy();
  });

  it('keeps exact BOT_GROUP_ID forum Topic human messages on the Support Queue path', async () => {
    const response = await Worker.fetch(telegramRequest(supportMessage(4)), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.DB.receipts).toHaveLength(0);
    expect(env.QUEUE.messages).toHaveLength(1);
    expect(env.QUEUE.messages[0]).toMatchObject({
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:4',
      payload: {
        supportProfileVersion: 0,
        updateRef: '4',
        threadRef: '40',
        operatorRef: '3001',
        content: 'human reply'
      }
    });
  });

  it('keeps Support AI on/off callbacks on the existing control_action Queue path', async () => {
    const response = await Worker.fetch(telegramRequest({
      update_id: 5,
      callback_query: {
        id: 'support-cb-5',
        data: 'ai:off',
        from: { id: 3001 },
        message: {
          from: { id: 111111, is_bot: true },
          message_id: 205,
          message_thread_id: 40,
          chat: { id: -10099, type: 'supergroup' }
        }
      }
    }), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.DB.receipts).toHaveLength(0);
    expect(env.QUEUE.messages).toEqual([expect.objectContaining({
      source: 'telegram',
      type: 'control_action',
      eventId: 'tg:0:5',
      payload: expect.objectContaining({
        supportProfileVersion: 0,
        updateRef: '5',
        callbackQueryRef: 'support-cb-5',
        threadRef: '40',
        operatorRef: '3001',
        action: 'AI_OFF'
      })
    })]);
  });

  it('ignores an unrelated supergroup with no Support Queue side effect', async () => {
    const response = await Worker.fetch(
      telegramRequest(supportMessage(6, { id: -10088, type: 'supergroup' })),
      env,
      {} as any
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Ignored');
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(env.DB.receipts).toHaveLength(0);
  });

  it.each([
    ['group', -10099],
    ['channel', -10099]
  ])('ignores Telegram %s chats even when their id equals BOT_GROUP_ID', async (type, id) => {
    const response = await Worker.fetch(
      telegramRequest(supportMessage(7, { id, type })),
      env,
      {} as any
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Ignored');
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(env.DB.receipts).toHaveLength(0);
  });

  it('rejects wrong webhook secret or path before Admin/Support routing', async () => {
    const wrongSecret = await Worker.fetch(
      telegramRequest(privateMessage(8, 1001), 'unified-path', 'wrong-secret'),
      env,
      {} as any
    );
    const wrongPath = await Worker.fetch(
      telegramRequest(supportMessage(9), 'wrong-path', 'unified-secret'),
      env,
      {} as any
    );

    expect(wrongSecret.status).toBe(401);
    expect(wrongPath.status).toBe(401);
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(env.DB.receipts).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('deduplicates repeated Admin update_id in admin_update_receipts', async () => {
    await Worker.fetch(telegramRequest(privateMessage(10, 1001)), env, {} as any);
    await Worker.fetch(telegramRequest(privateMessage(10, 1001)), env, {} as any);

    expect(env.DB.receipts).toHaveLength(1);
    expect(env.DB.receipts[0]).toMatchObject({ update_id: '10', status: 'PROCESSED' });
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(
      call => String(call[0]).endsWith('/sendMessage')
    )).toHaveLength(1);
  });

  it('preserves Support duplicate/retry identity semantics with stable tg:<profile>:<updateId>', async () => {
    await Worker.fetch(telegramRequest(supportMessage(11)), env, {} as any);
    await Worker.fetch(telegramRequest(supportMessage(11)), env, {} as any);

    expect(env.DB.receipts).toHaveLength(0);
    expect(env.QUEUE.messages).toHaveLength(2);
    expect(env.QUEUE.messages.map((message: any) => message.eventId)).toEqual(['tg:0:11', 'tg:0:11']);
  });

  it('shows single-Bot Telegram settings, keeps group migration, and hides identity rotation', async () => {
    const response = await Worker.fetch(telegramRequest(privateCallback(12, 'p:tg')), env, {} as any);

    expect(response.status).toBe(200);
    const calls = vi.mocked(globalThis.fetch).mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)));
    const page = calls.find(body => String(body.text).startsWith('Telegram 设置'));
    expect(page.text).toContain('模式：单 Bot');
    expect(page.text).toContain('私聊 = 后台管理');
    expect(page.text).toContain('客服群 = 对话');
    const actions = page.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data);
    expect(actions).toContain('e:tgroup');
    expect(actions).toContain('t:tgw');
    expect(actions).not.toContain('e:tbot');
  });

  it('fails closed on forged or stale Bot-rotation workflows in unified Admin mode', async () => {
    await Worker.fetch(telegramRequest(privateCallback(13, 'e:tbot')), env, {} as any);

    expect(env.DB.sessions).toHaveLength(0);
    expect(env.DB.runtime).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch).mock.calls.some(
      call => String(call[0]).endsWith('/setWebhook') || String(call[0]).endsWith('/deleteWebhook')
    )).toBe(false);

    env.DB.sessions.push({
      admin_user_id: '1001',
      action: 'ROTATE_BOT',
      target: 'TELEGRAM_SUPPORT_PROFILE',
      expected_version: 0,
      candidate_value_text: null,
      candidate_ciphertext: null,
      candidate_nonce: null,
      context_json: null,
      expires_at: 9999999999,
      updated_at: 0
    });
    await Worker.fetch(
      telegramRequest(privateMessage(14, 1001, '222222:should-never-be-processed-abcdefghijklmnopqrstuvwxyz')),
      env,
      {} as any
    );

    expect(env.DB.sessions).toHaveLength(0);
    expect(env.DB.runtime).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch).mock.calls.some(
      call => String(call[0]).endsWith('/setWebhook') || String(call[0]).endsWith('/deleteWebhook')
    )).toBe(false);
  });

  it('retains the legacy separate Admin webhook for migration/rollback compatibility', async () => {
    const legacyPath = 'legacy_admin_path_abcdefghijklmnopqrstuvwxyz';
    const legacySecret = 'legacy_admin_secret_abcdefghijklmnopqrstuvwxyz';
    const legacyToken = '999999:legacy-admin-bot-abcdefghijklmnopqrstuvwxyz';
    env.ADMIN_TELEGRAM_BOT_TOKEN = legacyToken;
    env.ADMIN_TELEGRAM_SECRET_PATH = legacyPath;
    env.ADMIN_TELEGRAM_WEBHOOK_SECRET = legacySecret;

    const response = await Worker.fetch(new Request(
      `https://worker.example/webhooks/admin-telegram/${legacyPath}`,
      {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': legacySecret },
        body: JSON.stringify(privateMessage(15, 1001))
      }
    ), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(env.DB.receipts).toHaveLength(1);
    const send = vi.mocked(globalThis.fetch).mock.calls.find(call => String(call[0]).endsWith('/sendMessage'));
    expect(String(send?.[0])).toContain(`bot${legacyToken}/sendMessage`);
  });
});
