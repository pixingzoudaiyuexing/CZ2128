import { describe, it, expect, vi, beforeEach } from 'vitest';
import Worker from '../src/index';
import { RetryableProcessingError } from '../src/core/errors';
import * as consumer from '../src/queue/consumer';
import * as dlqConsumer from '../src/queue/dlq-consumer';
import * as dlqQuarantine from '../src/queue/dlq-quarantine';

vi.mock('../src/queue/consumer', () => ({
  handleQueueEvent: vi.fn(async (event: any) => {
    if (event.type === 'error_trigger') throw new Error('Simulated failure');
  })
}));

vi.mock('../src/queue/dlq-consumer', () => ({
  captureDlqMessage: vi.fn(async () => ({ id: 'dlq:v1:test' }))
}));

vi.mock('../src/queue/dlq-quarantine', () => ({
  persistDlqQuarantine: vi.fn(async () => ({ quarantineId: 'dlq-quarantine:v1:test' }))
}));

class MockQueue {
  messages: any[] = [];
  async send(msg: any) {
    this.messages.push(msg);
  }
}

class MockD1 {
  tables: Record<string, any[]> = {
    conversations: [], messages: [], event_receipts: [], outbound_operations: []
  };
  prepare(query: string) {
    const statement = {
      bind: () => statement,
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] })
    };
    return statement;
  }
}

describe('Worker Integration', () => {
  let env: any;
  let ctx: any;

  beforeEach(() => {
    vi.mocked(consumer.handleQueueEvent).mockImplementation(async (event: any) => {
      if (event.type === 'error_trigger') throw new Error('Simulated failure');
    });
    vi.mocked(dlqConsumer.captureDlqMessage).mockResolvedValue({ id: 'dlq:v1:test' } as any);
    vi.mocked(dlqQuarantine.persistDlqQuarantine).mockResolvedValue({
      quarantineId: 'dlq-quarantine:v1:test'
    } as any);
    env = {
      DB: new MockD1(),
      QUEUE: new MockQueue(),
      CHATWOOT_WEBHOOK_SECRET: 'secret',
      CRISP_WEBHOOK_SECRET: 'crisp-secret',
      CRISP_WEBSITE_ID: 'website-1',
      TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
      TELEGRAM_SECRET_PATH: 'my-path',
      BOT_GROUP_ID: '-100',
      DLQ_QUARANTINE: {}
    };
    ctx = {};
  });

  async function signChatwoot(body: string, timestamp: number): Promise<string> {
    const enc = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey('raw', enc.encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
    return Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function signCrisp(payload: unknown, timestamp: number): Promise<string> {
    const enc = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey('raw', enc.encode('crisp-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`[${timestamp};${JSON.stringify(payload)}]`));
    return Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  it('fetch() -> Chatwoot ingress -> QUEUE.send', async () => {
    const payload = JSON.stringify({
      event: 'message_created',
      id: 123,
      account: { id: 1 },
      conversation: { id: 2 },
      sender: { id: 3 },
      message_type: 'incoming',
      content: 'Hello'
    });
    const ts = Math.floor(Date.now() / 1000);
    const sigHex = await signChatwoot(payload, ts);

    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: { 'X-Chatwoot-Signature': `sha256=${sigHex}`, 'X-Chatwoot-Timestamp': String(ts), 'X-Chatwoot-Delivery': 'delivery-1' },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages.length).toBe(1);
    expect(env.QUEUE.messages[0]).toEqual({
      version: 1,
      source: 'chatwoot',
      type: 'message_created',
      eventId: 'delivery-1',
      payload: {
        accountRef: '1',
        conversationRef: '2',
        customerRef: '3',
        messageRef: '123',
        content: 'Hello',
        actorRole: 'CUSTOMER'
      }
    });
  });

  it('fetch() -> Crisp signed ingress -> QUEUE.send with website/session identity', async () => {
    const payload = {
      event: 'message:send',
      data: {
        website_id: 'website-1', session_id: 'session-1', fingerprint: 101,
        type: 'text', from: 'user', content: 'Hello Crisp', user: { user_id: 'visitor-1' }
      }
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signCrisp(payload, timestamp);
    const req = new Request('http://localhost/webhooks/crisp', {
      method: 'POST',
      headers: {
        'X-Crisp-Request-Timestamp': String(timestamp),
        'X-Crisp-Signature': signature
      },
      body: JSON.stringify(payload)
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(1);
    expect(env.QUEUE.messages[0]).toMatchObject({
      source: 'crisp', type: 'message_created',
      payload: { websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1', content: 'Hello Crisp' }
    });
  });

  it('rejects a Crisp request with stale timestamp before enqueue', async () => {
    const payload = { event: 'message:send', data: { website_id: 'website-1', session_id: 'session-1', fingerprint: 102, type: 'text', content: 'stale' } };
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = await signCrisp(payload, timestamp);
    const req = new Request('http://localhost/webhooks/crisp', {
      method: 'POST',
      headers: { 'X-Crisp-Request-Timestamp': String(timestamp), 'X-Crisp-Signature': signature },
      body: JSON.stringify(payload)
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it.each([
    ['user', { id: 5, type: 'user' }, false, 1],
    ['agent_bot', { id: 5, type: 'agent_bot' }, false, 0],
    ['system', { id: 5, type: 'system' }, false, 0],
    ['unknown', { id: 5, type: 'future_sender' }, false, 0],
    ['missing sender', undefined, false, 0],
    ['private user', { id: 5, type: 'user' }, true, 0]
  ])('filters Chatwoot outgoing sender: %s', async (_label, sender, isPrivate, expectedQueued) => {
    const payload = JSON.stringify({
      event: 'message_created',
      id: 124,
      account: { id: 1 },
      conversation: { id: 2, meta: { sender: { id: 3, name: 'Customer' } } },
      sender,
      message_type: 'outgoing',
      private: isPrivate,
      content: 'Operator reply'
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signChatwoot(payload, timestamp);
    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'X-Chatwoot-Signature': `sha256=${signature}`,
        'X-Chatwoot-Timestamp': String(timestamp),
        'X-Chatwoot-Delivery': `sender-${String(_label)}`
      },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(expectedQueued);
    if (expectedQueued === 1) {
      expect(env.QUEUE.messages[0].payload.actorRole).toBe('OPERATOR');
      expect(env.QUEUE.messages[0].payload.customerRef).toBe('3');
    }
  });

  it('derives stable but distinct Chatwoot lifecycle fallback identities', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const send = async (status: string) => {
      const payload = JSON.stringify({ event: 'conversation_status_changed', account: { id: 1 }, id: 2, status });
      const signature = await signChatwoot(payload, ts);
      const request = new Request('http://localhost/webhooks/chatwoot', {
        method: 'POST',
        headers: { 'X-Chatwoot-Signature': `sha256=${signature}`, 'X-Chatwoot-Timestamp': String(ts) },
        body: payload
      });
      return Worker.fetch(request, env, ctx);
    };

    await send('resolved');
    await send('open');
    const firstIds = env.QUEUE.messages.map((message: any) => message.eventId);
    expect(firstIds[0]).not.toBe(firstIds[1]);

    env.QUEUE.messages = [];
    await send('resolved');
    expect(env.QUEUE.messages[0].eventId).toBe(firstIds[0]);
  });

  it('fetch() -> Telegram ingress -> QUEUE.send', async () => {
    const payload = JSON.stringify({
      update_id: 456,
      message: { chat: { id: -100 }, from: { id: 7, is_bot: false }, message_thread_id: 8, message_id: 9, text: 'Reply' }
    });
    const req = new Request('http://localhost/webhooks/telegram/my-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(1);
    expect(env.QUEUE.messages[0]).toEqual({
      version: 1,
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:456',
      payload: { supportProfileVersion: 0, updateRef: '456', messageRef: '9', threadRef: '8', content: 'Reply' }
    });
  });

  it('ignores Telegram human messages outside a forum topic', async () => {
    const req = new Request('http://localhost/webhooks/telegram/my-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: JSON.stringify({
        update_id: 458,
        message: { chat: { id: -100 }, from: { id: 7, is_bot: false }, message_id: 10, text: 'Main group' }
      })
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('rejects using the Telegram bot token as the webhook path secret', async () => {
    env.TELEGRAM_SECRET_PATH = 'same-secret';
    env.TELEGRAM_BOT_TOKEN = 'same-secret';
    const req = new Request('http://localhost/webhooks/telegram/same-secret', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: JSON.stringify({
        update_id: 459,
        message: { chat: { id: -100 }, from: { id: 7, is_bot: false }, message_thread_id: 8, message_id: 11, text: 'Reply' }
      })
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('rejects Telegram update without update_id', async () => {
    const req = new Request('http://localhost/webhooks/telegram/my-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: JSON.stringify({ message: { chat: { id: -100 }, from: { is_bot: false } } })
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('drops bot-origin Telegram update after authentication', async () => {
    const req = new Request('http://localhost/webhooks/telegram/my-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: JSON.stringify({ update_id: 457, message: { chat: { id: -100 }, from: { is_bot: true } } })
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('does not trust an echo marker before Chatwoot HMAC verification', async () => {
    const payload = JSON.stringify({ event: 'message_created', source_id: 'cz2128:forged' });
    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'X-Chatwoot-Signature': `sha256=${'00'.repeat(32)}`,
        'X-Chatwoot-Timestamp': String(Math.floor(Date.now() / 1000))
      },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('drops a verified CZ2128 echo before enqueueing', async () => {
    const payload = JSON.stringify({ event: 'message_created', source_id: 'cz2128:op-1' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signChatwoot(payload, timestamp);
    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'X-Chatwoot-Signature': `sha256=${signature}`,
        'X-Chatwoot-Timestamp': String(timestamp)
      },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('rejects malformed verified Chatwoot messages before enqueueing', async () => {
    const payload = JSON.stringify({ event: 'message_created', account: { id: 1 }, id: 2, message_type: 'incoming' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signChatwoot(payload, timestamp);
    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'X-Chatwoot-Signature': `sha256=${signature}`,
        'X-Chatwoot-Timestamp': String(timestamp)
      },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    expect(env.QUEUE.messages).toHaveLength(0);
  });

  it('uses the canonical delayed retry error', async () => {
    vi.mocked(consumer.handleQueueEvent).mockRejectedValueOnce(new RetryableProcessingError('CONCURRENCY_LEASE_HELD', 37));
    const message = {
      body: { version: 1, source: 'internal', type: 'ai_trigger', eventId: '1', payload: { convId: 'c1', messageId: 'm1' } },
      ack: vi.fn(),
      retry: vi.fn()
    };

    if (Worker.queue) {
      await Worker.queue({ queue: 'cz2128-queue', messages: [message] } as any, env, ctx);
    }

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 37 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('uses a bounded infrastructure-safe delay for unknown Queue exceptions', async () => {
    vi.mocked(consumer.handleQueueEvent).mockRejectedValueOnce(new Error('private deterministic detail'));
    const message = {
      body: { version: 1, source: 'internal', type: 'ai_trigger', eventId: 'unknown', payload: { convId: 'c1', messageId: 'm1' } },
      ack: vi.fn(),
      retry: vi.fn()
    };
    if (Worker.queue) await Worker.queue({ queue: 'cz2128-queue', messages: [message] } as any, env, ctx);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('queue() -> runtime -> ack/retry', async () => {
    let acked = 0;
    let retried = 0;
    const batch = {
      queue: 'cz2128-queue',
      messages: [
        {
          body: { version: 1, source: 'telegram', type: 'message_created', eventId: '1', payload: {} },
          ack: () => acked++,
          retry: () => retried++
        },
        {
          body: { version: 1, source: 'chatwoot', type: 'error_trigger', eventId: '2', payload: {} },
          ack: () => acked++,
          retry: () => retried++
        }
      ]
    };

    if (Worker.queue) {
      await Worker.queue(batch as any, env, ctx);
    }

    expect(acked).toBe(1);
    expect(retried).toBe(1);
  });

  it('routes the main queue only to normal processing', async () => {
    const message = {
      id: 'main-message',
      body: { version: 1, source: 'internal', type: 'ai_trigger', eventId: 'main', payload: {} },
      ack: vi.fn(),
      retry: vi.fn()
    };
    if (Worker.queue) await Worker.queue({ queue: 'cz2128-queue', messages: [message] } as any, env, ctx);
    expect(consumer.handleQueueEvent).toHaveBeenCalledTimes(1);
    expect(dlqConsumer.captureDlqMessage).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('routes the DLQ only to sanitized receipt capture and ACKs after success', async () => {
    vi.mocked(consumer.handleQueueEvent).mockClear();
    const message = {
      id: 'dlq-message',
      body: { private: 'PRIVATE_DLQ_MESSAGE_BODY_123' },
      ack: vi.fn(),
      retry: vi.fn()
    };
    if (Worker.queue) await Worker.queue({ queue: 'cz2128-dlq', messages: [message] } as any, env, ctx);
    expect(dlqConsumer.captureDlqMessage).toHaveBeenCalledWith(env, message, undefined, 'cz2128-dlq');
    expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(dlqQuarantine.persistDlqQuarantine).not.toHaveBeenCalled();
    expect(vi.mocked(dlqConsumer.captureDlqMessage).mock.invocationCallOrder[0])
      .toBeLessThan(message.ack.mock.invocationCallOrder[0]);
  });

  it('ACKs after sanitized quarantine persistence when D1 receipt persistence fails', async () => {
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(dlqConsumer.captureDlqMessage).mockRejectedValueOnce(new Error('SUPER_SECRET_DLQ_TOKEN_456'));
    const message = { id: 'dlq-fail', body: {}, ack: vi.fn(), retry: vi.fn() };
    if (Worker.queue) await Worker.queue({ queue: 'cz2128-dlq', messages: [message] } as any, env, ctx);
    expect(dlqQuarantine.persistDlqQuarantine).toHaveBeenCalledWith(
      env.DLQ_QUARANTINE,
      message,
      'cz2128-dlq'
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
    expect(warnLog.mock.calls.flat().join(' ')).not.toContain('SUPER_SECRET_DLQ_TOKEN_456');
    warnLog.mockRestore();
  });

  it('does not ACK and requests bounded retry when D1 and quarantine persistence both fail', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(dlqConsumer.captureDlqMessage).mockRejectedValueOnce(new Error('PRIVATE_D1_FAILURE'));
    vi.mocked(dlqQuarantine.persistDlqQuarantine).mockRejectedValueOnce(new Error('SUPER_SECRET_DLQ_TOKEN_456'));
    const message = { id: 'dlq-dual-fail', body: {}, ack: vi.fn(), retry: vi.fn() };
    if (Worker.queue) await Worker.queue({ queue: 'cz2128-dlq', messages: [message] } as any, env, ctx);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).not.toContain('PRIVATE_D1_FAILURE');
    expect(logs).not.toContain('SUPER_SECRET_DLQ_TOKEN_456');
    errorLog.mockRestore();
  });

  it('fails safe for an unknown queue without invoking normal or DLQ handlers', async () => {
    vi.mocked(consumer.handleQueueEvent).mockClear();
    vi.mocked(dlqConsumer.captureDlqMessage).mockClear();
    const message = { id: 'unknown', body: {}, ack: vi.fn(), retry: vi.fn() };
    if (Worker.queue) await Worker.queue({ queue: 'unexpected-queue', messages: [message] } as any, env, ctx);
    expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
    expect(dlqConsumer.captureDlqMessage).not.toHaveBeenCalled();
    expect(dlqQuarantine.persistDlqQuarantine).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });

  it.each(['cz2128-4c-staging-queue', 'cz2128-4c-staging-dlq'])(
    'does not infer staging identity for %s when both variables are absent',
    async queue => {
      vi.mocked(consumer.handleQueueEvent).mockClear();
      vi.mocked(dlqConsumer.captureDlqMessage).mockClear();
      const message = { id: `unconfigured-${queue}`, body: {}, ack: vi.fn(), retry: vi.fn() };
      if (Worker.queue) await Worker.queue({ queue, messages: [message] } as any, env, ctx);
      expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
      expect(dlqConsumer.captureDlqMessage).not.toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    }
  );

  it('routes the approved staging main Queue only to normal processing', async () => {
    vi.mocked(consumer.handleQueueEvent).mockClear();
    vi.mocked(dlqConsumer.captureDlqMessage).mockClear();
    Object.assign(env, {
      EXPECTED_MAIN_QUEUE_NAME: 'cz2128-4c-staging-queue',
      EXPECTED_DLQ_QUEUE_NAME: 'cz2128-4c-staging-dlq'
    });
    const message = {
      id: 'staging-main-message',
      body: { version: 1, source: 'internal', type: 'ai_trigger', eventId: 'staging-main', payload: {} },
      ack: vi.fn(),
      retry: vi.fn()
    };
    if (Worker.queue) {
      await Worker.queue({ queue: 'cz2128-4c-staging-queue', messages: [message] } as any, env, ctx);
    }
    expect(consumer.handleQueueEvent).toHaveBeenCalledTimes(1);
    expect(dlqConsumer.captureDlqMessage).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('routes the approved staging DLQ with its exact identity', async () => {
    vi.mocked(consumer.handleQueueEvent).mockClear();
    vi.mocked(dlqConsumer.captureDlqMessage).mockClear();
    Object.assign(env, {
      EXPECTED_MAIN_QUEUE_NAME: 'cz2128-4c-staging-queue',
      EXPECTED_DLQ_QUEUE_NAME: 'cz2128-4c-staging-dlq'
    });
    const message = { id: 'staging-dlq-message', body: {}, ack: vi.fn(), retry: vi.fn() };
    if (Worker.queue) {
      await Worker.queue({ queue: 'cz2128-4c-staging-dlq', messages: [message] } as any, env, ctx);
    }
    expect(dlqConsumer.captureDlqMessage).toHaveBeenCalledWith(
      env,
      message,
      undefined,
      'cz2128-4c-staging-dlq'
    );
    expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it.each(['cz2128-queue', 'cz2128-dlq', 'unexpected-queue'])(
    'rejects non-staging Queue %s when the staging pair is selected',
    async queue => {
      vi.mocked(consumer.handleQueueEvent).mockClear();
      vi.mocked(dlqConsumer.captureDlqMessage).mockClear();
      Object.assign(env, {
        EXPECTED_MAIN_QUEUE_NAME: 'cz2128-4c-staging-queue',
        EXPECTED_DLQ_QUEUE_NAME: 'cz2128-4c-staging-dlq'
      });
      const message = { id: `rejected-${queue}`, body: {}, ack: vi.fn(), retry: vi.fn() };
      if (Worker.queue) await Worker.queue({ queue, messages: [message] } as any, env, ctx);
      expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
      expect(dlqConsumer.captureDlqMessage).not.toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    }
  );

  it('fails closed before routing when only one Queue identity variable is configured', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(consumer.handleQueueEvent).mockClear();
    vi.mocked(dlqConsumer.captureDlqMessage).mockClear();
    env.EXPECTED_MAIN_QUEUE_NAME = 'cz2128-4c-staging-queue';
    const message = { id: 'partial-config', body: {}, ack: vi.fn(), retry: vi.fn() };
    if (Worker.queue) {
      await Worker.queue({ queue: 'cz2128-4c-staging-queue', messages: [message] } as any, env, ctx);
    }
    expect(consumer.handleQueueEvent).not.toHaveBeenCalled();
    expect(dlqConsumer.captureDlqMessage).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it('scheduled() registers bounded attachment cleanup with waitUntil', async () => {
    const waitUntil = vi.fn();
    const scheduledEnv = {
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
      ATTACHMENTS_BUCKET: {}
    };
    if (Worker.scheduled) {
      await Worker.scheduled({} as any, scheduledEnv as any, { waitUntil } as any);
    }
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });
});
