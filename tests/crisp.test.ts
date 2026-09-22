import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrispMessage, createCrispPicker } from '../src/adapters/crisp/api';
import { verifyCrispWebhook } from '../src/adapters/crisp/webhook';
import { parseCrispMenu } from '../src/queue/crisp-handler';

const env = {
  CRISP_API_IDENTIFIER: 'identifier',
  CRISP_API_KEY: 'key'
} as any;

async function sign(body: unknown, timestamp: number, secret: string): Promise<string> {
  const trace = `[${timestamp};${JSON.stringify(body)}]`;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(trace)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function request(body: string, timestamp: number, signature: string, website = 'website-1'): Request {
  return new Request('https://gateway.example/webhooks/crisp', {
    method: 'POST',
    headers: {
      'X-Crisp-Request-Timestamp': String(timestamp),
      'X-Crisp-Signature': signature
    },
    body
  });
}

describe('Crisp adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifies the official Crisp signature and website binding', async () => {
    const payload = {
      event: 'message:send',
      data: { website_id: 'website-1', session_id: 'session-1', fingerprint: 10, type: 'text', content: 'Hi' }
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(payload, timestamp, 'secret');
    const result = await verifyCrispWebhook(
      request(JSON.stringify(payload), timestamp, signature), 'secret', 'website-1'
    );
    expect(result.valid).toBe(true);
    expect(result.payload?.data.session_id).toBe('session-1');
  });

  it('rejects tampering, wrong website and stale replay', async () => {
    const payload = { event: 'message:send', data: { website_id: 'website-1' } };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(payload, timestamp, 'secret');
    await expect(verifyCrispWebhook(request('{"tampered":true}', timestamp, signature), 'secret', 'website-1'))
      .resolves.toMatchObject({ valid: false });
    await expect(verifyCrispWebhook(request(JSON.stringify(payload), timestamp, signature), 'secret', 'other'))
      .resolves.toMatchObject({ valid: false });
    const oldTimestamp = timestamp - 301;
    const oldSignature = await sign(payload, oldTimestamp, 'secret');
    await expect(verifyCrispWebhook(request(JSON.stringify(payload), oldTimestamp, oldSignature), 'secret', 'website-1'))
      .resolves.toMatchObject({ valid: false });
  });

  it('sends an automated Crisp text with deterministic API shape', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { fingerprint: 99 } }), { status: 200 })
    );
    const lifecycle = { requestStarted: vi.fn(), responseObserved: vi.fn() };
    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'op-99', lifecycle)).resolves.toEqual({ messageId: '99' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.crisp.chat/v1/website/website-1/conversation/session-1/message');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('identifier:key')}`);
    expect(new Headers(init?.headers).get('X-Crisp-Tier')).toBe('plugin');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      type: 'text', from: 'operator', origin: 'chat', content: 'Reply', automated: true,
      user: { user_id: 'cz2128' }, properties: { cz2128_operation_id: 'op-99' }
    });
    expect(lifecycle.requestStarted).toHaveBeenCalledOnce();
    expect(lifecycle.responseObserved).toHaveBeenCalledWith(200);
  });

  it('sends a Crisp picker and fails closed on invalid success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { fingerprint: 10 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    await createCrispPicker(env, 'website-1', 'session-1', 'main', 'Choose', [
      { value: 'human', label: 'Contact human' }
    ], 'picker-op');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      type: 'picker', content: { id: 'main', text: 'Choose', choices: [{ value: 'human', selected: false }] }
    });
    await expect(createCrispMessage(env, 'website-1', 'session-1', 'Reply', 'invalid-op')).rejects.toMatchObject({
      code: 'OUTBOUND_INVALID_SUCCESS_AMBIGUOUS', provider: 'CRISP'
    });
  });

  it('parses menu configuration and fails closed on malformed JSON', () => {
    expect(parseCrispMenu(JSON.stringify({
      welcome: 'Welcome',
      picker: { id: 'main', text: 'Choose', choices: [{ value: 'human', label: 'Human' }] },
      options: [{ value: 'human', label: 'Human', response: 'A human will help.' }]
    }))).toMatchObject({ welcome: 'Welcome' });
    expect(parseCrispMenu('{bad-json')).toBeNull();
    expect(parseCrispMenu(JSON.stringify({ picker: { id: '', text: '', choices: [] } }))).toBeNull();
    expect(parseCrispMenu(JSON.stringify({
      picker: { id: 'x'.repeat(129), text: 'Choose', choices: [{ value: 'a', label: 'A' }] }
    }))).toBeNull();
  });
});
