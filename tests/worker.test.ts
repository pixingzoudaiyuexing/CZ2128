import { describe, it, expect, vi, beforeEach } from 'vitest';
import Worker from '../src/index';

vi.mock('../src/queue/consumer', () => ({
  handleQueueEvent: vi.fn(async (event: any) => {
    if (event.type === 'error_trigger') throw new Error('Simulated failure');
  })
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
  prepare(query: string) { return { bind: () => this, run: async () => ({ meta: { changes: 1 } }), first: async () => null }; }
}

describe('Worker Integration', () => {
  let env: any;
  let ctx: any;

  beforeEach(() => {
    env = {
      DB: new MockD1(),
      QUEUE: new MockQueue(),
      CHATWOOT_WEBHOOK_SECRET: 'secret',
      TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
      TELEGRAM_SECRET_PATH: 'my-path',
      BOT_GROUP_ID: '-100'
    };
    ctx = {};
  });

  it('fetch() -> Chatwoot ingress -> QUEUE.send', async () => {
    const payload = JSON.stringify({ event: 'message_created', id: 123 });
    const ts = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey('raw', enc.encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${payload}`));
    const sigHex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const req = new Request('http://localhost/webhooks/chatwoot', {
      method: 'POST',
      headers: { 'X-Chatwoot-Signature': `sha256=${sigHex}`, 'X-Chatwoot-Timestamp': String(ts), 'X-Chatwoot-Delivery': 'delivery-1' },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages.length).toBe(1);
    expect(env.QUEUE.messages[0].source).toBe('chatwoot');
    expect(env.QUEUE.messages[0].eventId).toBe('delivery-1');
  });

  it('fetch() -> Telegram ingress -> QUEUE.send', async () => {
    const payload = JSON.stringify({ update_id: 456, message: { chat: { id: -100 } } });
    const req = new Request('http://localhost/webhooks/telegram/my-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: payload
    });

    const res = await Worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(env.QUEUE.messages.length).toBe(1);
    expect(env.QUEUE.messages[0].source).toBe('telegram');
    expect(env.QUEUE.messages[0].eventId).toBe('tg_456');
  });

  it('queue() -> runtime -> ack/retry', async () => {
    let acked = 0;
    let retried = 0;
    const batch = {
      messages: [
        {
          body: { source: 'telegram', type: 'message_created', eventId: '1', payload: {} },
          ack: () => acked++,
          retry: () => retried++
        },
        {
          body: { source: 'chatwoot', type: 'error_trigger', eventId: '2', payload: {} },
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
});
