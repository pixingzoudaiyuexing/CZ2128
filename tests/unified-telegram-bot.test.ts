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

  function telegramRequest(payload: any) {
    return new Request('https://worker.example/webhooks/telegram/unified-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'unified-secret' },
      body: JSON.stringify(payload)
    });
  }

  it('uses the same bot private chat as the authenticated Admin control plane', async () => {
    const response = await Worker.fetch(telegramRequest({
      update_id: 1,
      message: {
        message_id: 1,
        text: '/start',
        from: { id: 1001, is_bot: false },
        chat: { id: 1001, type: 'private' }
      }
    }), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
    const send = vi.mocked(globalThis.fetch).mock.calls.find(call => String(call[0]).endsWith('/sendMessage'));
    expect(String(send?.[0])).toContain(`bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(String(send?.[1]?.body)).toContain('AI 知识库');
    expect(env.DB.receipts).toHaveLength(1);
  });

  it('does not expose Admin actions to an unapproved private user', async () => {
    const response = await Worker.fetch(telegramRequest({
      update_id: 2,
      message: {
        message_id: 2,
        text: '/start',
        from: { id: 2001, is_bot: false },
        chat: { id: 2001, type: 'private' }
      }
    }), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(env.DB.receipts).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('keeps support-group Topic messages on the normal Queue path', async () => {
    const response = await Worker.fetch(telegramRequest({
      update_id: 3,
      message: {
        message_id: 30,
        message_thread_id: 40,
        text: 'human reply',
        from: { id: 1001, is_bot: false },
        chat: { id: -10099, type: 'supergroup' }
      }
    }), env, {} as any);

    expect(response.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(1);
    expect(env.QUEUE.messages[0]).toMatchObject({
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:3',
      payload: { threadRef: '40', operatorRef: '1001', content: 'human reply' }
    });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('ignores every other group after webhook authentication', async () => {
    const response = await Worker.fetch(telegramRequest({
      update_id: 4,
      message: {
        message_id: 31,
        message_thread_id: 41,
        text: 'wrong group',
        from: { id: 1001, is_bot: false },
        chat: { id: -10088, type: 'supergroup' }
      }
    }), env, {} as any);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Ignored');
    expect(env.QUEUE.messages).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('hides self-rotation from Telegram settings in unified mode', async () => {
    const response = await Worker.fetch(telegramRequest({
      update_id: 5,
      callback_query: {
        id: 'cb-5',
        data: 'p:tg',
        from: { id: 1001 },
        message: { chat: { id: 1001, type: 'private' } }
      }
    }), env, {} as any);

    expect(response.status).toBe(200);
    const calls = vi.mocked(globalThis.fetch).mock.calls
      .filter(call => String(call[0]).endsWith('/sendMessage'))
      .map(call => JSON.parse(String(call[1]?.body)));
    const page = calls.find(body => String(body.text).startsWith('Telegram 设置'));
    expect(page.text).toContain('模式：单 Bot');
    const actions = page.reply_markup.inline_keyboard.flat().map((item: any) => item.callback_data);
    expect(actions).toContain('e:tgroup');
    expect(actions).not.toContain('e:tbot');
  });
});
