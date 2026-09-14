import { describe, expect, it, vi } from 'vitest';
import Worker from '../src/index';

async function chatwootRequest(payload: any): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://worker.example/webhooks/chatwoot', {
    method: 'POST',
    headers: {
      'X-Chatwoot-Signature': `sha256=${hex}`,
      'X-Chatwoot-Timestamp': String(timestamp),
      'X-Chatwoot-Delivery': 'delivery'
    },
    body
  });
}

function env() {
  const messages: any[] = [];
  return {
    messages,
    value: {
      DB: {
        prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }), all: async () => ({ results: [] }) })
      },
      QUEUE: { send: vi.fn(async event => { messages.push(event); }) },
      CHATWOOT_WEBHOOK_SECRET: 'secret', CHATWOOT_API_URL: 'https://chatwoot.example',
      TELEGRAM_WEBHOOK_SECRET: 'tg-secret', TELEGRAM_SECRET_PATH: 'path',
      TELEGRAM_BOT_TOKEN: 'bot', BOT_GROUP_ID: '-100'
    } as any
  };
}

describe('attachment webhook normalization', () => {
  it('returns uniform private 404 responses for malformed attachment paths', async () => {
    const testEnv = env();
    for (const path of ['/attachments/', '/attachments/not-a-token', '/attachments/nested/token']) {
      const response = await Worker.fetch(new Request(`https://worker.example${path}`), testEnv.value, {} as any);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });

  it('normalizes Chatwoot attachment-only messages and caps descriptors at ten', async () => {
    const testEnv = env();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const attachments = Array.from({ length: 12 }, (_, id) => ({
      id, file_type: 'file', data_url: `https://chatwoot.example/files/${id}`,
      file_name: `private-${id}.txt`, content_type: 'text/plain', file_size: 3
    }));
    const request = await chatwootRequest({
      event: 'message_created', id: 5, account: { id: 1 }, conversation: { id: 2 },
      sender: { id: 3 }, message_type: 'incoming', attachments
    });

    const response = await Worker.fetch(request, testEnv.value, {} as any);
    expect(response.status).toBe(200);
    expect(testEnv.messages[0].payload.content).toBeUndefined();
    expect(testEnv.messages[0].payload.attachments).toHaveLength(10);
    const log = JSON.parse(String(warn.mock.calls[0][0]));
    expect(log).toMatchObject({ msg: expect.stringContaining('Attachment count'), error_category: 'ATTACHMENT_COUNT_LIMIT' });
    expect(JSON.stringify(log)).not.toContain('private-');
  });

  it('normalizes Telegram attachment-only and chooses one photo variant', async () => {
    const testEnv = env();
    const request = new Request('https://worker.example/webhooks/telegram/path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: JSON.stringify({
        update_id: 9,
        message: {
          message_id: 10, message_thread_id: 11, chat: { id: -100 }, from: { id: 1, is_bot: false },
          photo: [
            { file_id: 'small', file_unique_id: 'small-u', file_size: 1 },
            { file_id: 'large', file_unique_id: 'large-u', file_size: 2 }
          ]
        }
      })
    });

    const response = await Worker.fetch(request, testEnv.value, {} as any);
    expect(response.status).toBe(200);
    expect(testEnv.messages[0]).toMatchObject({
      eventId: 'tg:0:9', payload: { supportProfileVersion: 0 }
    });
    expect(testEnv.messages[0].payload.content).toBeUndefined();
    expect(testEnv.messages[0].payload.attachments).toEqual([expect.objectContaining({
      sourceAttachmentRef: 'large-u', locator: { provider: 'telegram', fileId: 'large' }
    })]);
  });

  it('keeps Telegram caption exactly once beside attachment metadata', async () => {
    const testEnv = env();
    const request = new Request('https://worker.example/webhooks/telegram/path', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
      body: JSON.stringify({
        update_id: 12,
        message: {
          message_id: 13, message_thread_id: 11, chat: { id: -100 }, from: { id: 1, is_bot: false },
          caption: 'caption once', document: { file_id: 'file', file_unique_id: 'unique', file_size: 2 }
        }
      })
    });
    await Worker.fetch(request, testEnv.value, {} as any);
    expect(testEnv.messages[0]).toMatchObject({
      eventId: 'tg:0:12', payload: { supportProfileVersion: 0 }
    });
    expect(testEnv.messages[0].payload.content).toBe('caption once');
    expect(JSON.stringify(testEnv.messages[0]).match(/caption once/g)).toHaveLength(1);
  });
});
