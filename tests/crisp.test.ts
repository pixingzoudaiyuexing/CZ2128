import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrispMessage, createCrispPicker } from '../src/adapters/crisp/api';
import { verifyCrispWebhook } from '../src/adapters/crisp/webhook';
import { parseCrispMenu, resolveCrispMenuOption } from '../src/queue/crisp-handler';

const env = {
  CRISP_API_IDENTIFIER: 'identifier',
  CRISP_API_KEY: 'key'
} as any;

// Independent wire-level signer matching Crisp's documented Go/HTTP contract.
function signWire(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`[${timestamp};${rawBody}]`).digest('hex');
}

function request(body: string, timestamp: string, signature: string): Request {
  return new Request('https://gateway.example/webhooks/crisp', {
    method: 'POST',
    headers: {
      'X-Crisp-Request-Timestamp': timestamp,
      'X-Crisp-Signature': signature
    },
    body
  });
}

describe('Crisp adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('verifies canonical wire bytes with a fresh seconds timestamp and website binding', async () => {
    const rawBody = JSON.stringify({
      event: 'message:send',
      data: { website_id: 'website-1', session_id: 'session-1', fingerprint: 10, type: 'text', content: 'Hi' }
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = await verifyCrispWebhook(
      request(rawBody, timestamp, signWire(rawBody, timestamp, 'secret')), 'secret', 'website-1'
    );
    expect(result).toMatchObject({ valid: true, timestampFormat: 'seconds' });
    expect(result.payload?.data.session_id).toBe('session-1');
    expect(result.rawBody).toBe(rawBody);
  });

  it('verifies the exact raw request body with a fresh milliseconds timestamp', async () => {
    const rawBody = '{\n  "event": "message:send",\n  "data": { "website_id": "website-1", "session_id": "session-raw", "fingerprint": 11, "type": "text", "content": "Hi" }\n}';
    const timestamp = String(Date.now());
    const signature = signWire(rawBody, timestamp, 'secret');

    const result = await verifyCrispWebhook(request(rawBody, timestamp, signature), 'secret', 'website-1');

    expect(result).toMatchObject({ valid: true, timestampFormat: 'milliseconds' });
    expect(result.payload?.data.session_id).toBe('session-raw');
    expect(result.rawBody).toBe(rawBody);
  });

  it('does not canonicalize a non-canonical body while verifying its signature', async () => {
    const rawBody = '{ "event": "message:send", "data": { "website_id": "website-1" } }';
    const canonicalBody = JSON.stringify(JSON.parse(rawBody));
    expect(canonicalBody).not.toBe(rawBody);
    const timestamp = String(Date.now());
    const canonicalSignature = signWire(canonicalBody, timestamp, 'secret');

    await expect(verifyCrispWebhook(request(rawBody, timestamp, canonicalSignature), 'secret', 'website-1'))
      .resolves.toMatchObject({
        valid: false,
        failure: 'CRISP_VERIFY_SIGNATURE_MISMATCH',
        timestampFormat: 'milliseconds'
      });
  });

  it('rejects tampering, wrong website and stale replay in both supported timestamp units', async () => {
    const rawBody = JSON.stringify({ event: 'message:send', data: { website_id: 'website-1' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWire(rawBody, timestamp, 'secret');

    await expect(verifyCrispWebhook(request('{"tampered":true}', timestamp, signature), 'secret', 'website-1'))
      .resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_SIGNATURE_MISMATCH' });
    await expect(verifyCrispWebhook(request(rawBody, timestamp, signature), 'secret', 'other'))
      .resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_WEBSITE_MISMATCH' });

    await expect(verifyCrispWebhook(request(rawBody, timestamp, signature), 'wrong-secret', 'website-1'))
      .resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_SIGNATURE_MISMATCH' });

    const staleSeconds = String(Math.floor(Date.now() / 1000) - 301);
    await expect(verifyCrispWebhook(
      request(rawBody, staleSeconds, signWire(rawBody, staleSeconds, 'secret')), 'secret', 'website-1'
    )).resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_TIMESTAMP_STALE' });

    const staleMilliseconds = String(Date.now() - 301_000);
    await expect(verifyCrispWebhook(
      request(rawBody, staleMilliseconds, signWire(rawBody, staleMilliseconds, 'secret')), 'secret', 'website-1'
    )).resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_TIMESTAMP_STALE' });
  });

  it('fails closed when the configured Website binding is missing', async () => {
    const rawBody = JSON.stringify({ event: 'message:send', data: { website_id: 'website-1' } });
    const timestamp = String(Date.now());
    const signature = signWire(rawBody, timestamp, 'secret');

    await expect(verifyCrispWebhook(request(rawBody, timestamp, signature), 'secret', undefined))
      .resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_CONFIG_MISSING' });
  });

  it('fails closed on missing headers and malformed signature material', async () => {
    const rawBody = JSON.stringify({ event: 'message:send', data: { website_id: 'website-1' } });
    const withoutHeaders = new Request('https://gateway.example/webhooks/crisp', { method: 'POST', body: rawBody });
    await expect(verifyCrispWebhook(withoutHeaders, 'secret', 'website-1'))
      .resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_HEADERS_MISSING' });

    const timestamp = String(Date.now());
    await expect(verifyCrispWebhook(request(rawBody, timestamp, 'not-hex'), 'secret', 'website-1'))
      .resolves.toMatchObject({ valid: false, failure: 'CRISP_VERIFY_SIGNATURE_FORMAT_INVALID' });
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
      options: [{ pickerId: 'main', value: 'human', label: 'Human', response: 'A human will help.' }]
    }))).toMatchObject({ welcome: 'Welcome' });
    expect(parseCrispMenu('{bad-json')).toBeNull();
    expect(parseCrispMenu(JSON.stringify({ picker: { id: '', text: '', choices: [] } }))).toBeNull();
    expect(parseCrispMenu(JSON.stringify({
      picker: { id: 'x'.repeat(129), text: 'Choose', choices: [{ value: 'a', label: 'A' }] }
    }))).toBeNull();
  });

  it('binds equal option values to distinct Picker identities and rejects duplicate keys', () => {
    const menu = parseCrispMenu(JSON.stringify({
      options: [
        { pickerId: 'main', value: 'same', label: 'Main', response: 'main-response' },
        { pickerId: 'secondary', value: 'same', label: 'Secondary', response: 'secondary-response' }
      ]
    }));
    expect(resolveCrispMenuOption(menu, 'main', 'same')?.response).toBe('main-response');
    expect(resolveCrispMenuOption(menu, 'secondary', 'same')?.response).toBe('secondary-response');
    expect(parseCrispMenu(JSON.stringify({
      options: [
        { pickerId: 'main', value: 'same', label: 'A' },
        { pickerId: 'main', value: 'same', label: 'B' }
      ]
    }))).toBeNull();
  });
});
