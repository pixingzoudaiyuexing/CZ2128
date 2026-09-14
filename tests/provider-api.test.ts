import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatwootMessage } from '../src/adapters/chatwoot/api';
import { closeTelegramTopic, sendTelegramMessage } from '../src/adapters/telegram/api';
import { ProviderDeliveryError } from '../src/core/errors';

const env = {
  CHATWOOT_API_URL: 'https://chatwoot.example',
  CHATWOOT_API_TOKEN: 'chatwoot-token',
  TELEGRAM_BOT_TOKEN: 'telegram-token'
} as any;

describe('provider API contracts', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['https://chatwoot.example', 'https://chatwoot.example/api/v1/accounts/1/conversations/2/messages'],
    ['https://chatwoot.example/', 'https://chatwoot.example/api/v1/accounts/1/conversations/2/messages'],
    ['https://chatwoot.example/tenant-a', 'https://chatwoot.example/tenant-a/api/v1/accounts/1/conversations/2/messages'],
    ['https://chatwoot.example/tenant-a/', 'https://chatwoot.example/tenant-a/api/v1/accounts/1/conversations/2/messages']
  ])('uses one canonical Chatwoot URL contract for %s', async (baseUrl, expected) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 91 }), { status: 200 })
    );
    await createChatwootMessage({ ...env, CHATWOOT_API_URL: baseUrl }, '1', '2', 'Reply', 'op-url');
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
  });

  it('stamps Chatwoot messages with the deterministic outbound operation id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 91 }), { status: 200 }));

    await createChatwootMessage(env, '1', '2', 'Reply', 'op-91');

    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('https://chatwoot.example/api/v1/accounts/1/conversations/2/messages');
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      content: 'Reply',
      message_type: 'outgoing',
      private: false,
      source_id: 'cz2128:op-91'
    });
  });

  it('classifies Chatwoot HTTP 503 as ambiguous without exposing its response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private customer text and token', { status: 503 }));

    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'op-92').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('AMBIGUOUS');
    expect(String(error)).not.toContain('private customer text');
    expect(String(error)).not.toContain('token');
  });

  it('classifies Telegram HTTP 503 as ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream failed', { status: 503 }));

    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('AMBIGUOUS');
  });

  it('classifies Telegram ok=false error_code=500 as ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 500 }), { status: 200 }));

    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('AMBIGUOUS');
  });

  it('classifies Chatwoot HTTP 429 as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', {
      status: 429, headers: { 'Retry-After': '30' }
    }));

    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'op-93').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('RETRYABLE');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(30);
  });

  it('classifies Telegram ok=false error_code=429 as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: 429, parameters: { retry_after: 10 }
    }), { status: 200, headers: { 'Retry-After': '30' } }));

    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('RETRYABLE');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(error.retryAfterSeconds).toBeLessThan(30);
  });

  it('classifies explicit HTTP 400 as final', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad request', { status: 400 }));

    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'op-94').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('FINAL');
  });

  it('classifies HTTP 408 and Telegram error_code=408 as ambiguous', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response('request timeout', { status: 408 }));
    const httpError = await createChatwootMessage(env, '1', '2', 'Reply', 'op-95').catch(value => value);
    expect(httpError).toBeInstanceOf(ProviderDeliveryError);
    expect(httpError.outcome).toBe('AMBIGUOUS');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 408 }), { status: 200 }));
    const apiError = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(apiError).toBeInstanceOf(ProviderDeliveryError);
    expect(apiError.outcome).toBe('AMBIGUOUS');
  });

  it('classifies a lost Telegram response as ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket closed with secret material'));

    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('AMBIGUOUS');
    expect(String(error)).not.toContain('secret material');
  });

  it('classifies a lost Chatwoot response as ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket closed with private URL'));
    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'lost-cw').catch(value => value);
    expect(error).toMatchObject({ outcome: 'AMBIGUOUS', code: 'OUTBOUND_TRANSPORT_AMBIGUOUS' });
    expect(String(error)).not.toContain('private URL');
  });

  it('honors Telegram HTTP 429 metadata before its header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: 429, parameters: { retry_after: 10 }, description: 'private'
    }), { status: 429, headers: { 'Retry-After': '30' } }));
    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toMatchObject({ outcome: 'RETRYABLE', code: 'OUTBOUND_RATE_LIMITED', httpStatus: 429 });
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(error.retryAfterSeconds).toBeLessThan(30);
  });

  it('does not accept a Telegram ok=false body as lifecycle success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 400, description: 'private detail' }), { status: 200 }));

    const error = await closeTelegramTopic(env, '-100', '7').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('FINAL');
    expect(String(error)).not.toContain('private detail');
  });

  it('classifies an invalid 2xx success response as ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 200 }));

    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'op-96').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('AMBIGUOUS');
  });

  it.each([408, 500, 502, 503, 504])('keeps Chatwoot visible HTTP %s ambiguous', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private body', { status }));
    const error = await createChatwootMessage(env, '1', '2', 'Reply', `cw-${status}`).catch(value => value);
    expect(error).toMatchObject({
      outcome: 'AMBIGUOUS',
      httpStatus: status,
      code: status === 408 ? 'OUTBOUND_TIMEOUT_AMBIGUOUS' : 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS'
    });
  });

  it.each([408, 500, 502, 503, 504])('keeps Telegram visible API %s ambiguous', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: status, description: 'private body'
    }), { status: 200 }));
    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toMatchObject({
      outcome: 'AMBIGUOUS',
      httpStatus: status,
      code: status === 408 ? 'OUTBOUND_TIMEOUT_AMBIGUOUS' : 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS'
    });
  });

  it.each([408, 500, 502, 503, 504])('keeps Telegram visible HTTP %s ambiguous', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private body', { status }));
    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toMatchObject({
      outcome: 'AMBIGUOUS',
      httpStatus: status,
      code: status === 408 ? 'OUTBOUND_TIMEOUT_AMBIGUOUS' : 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS'
    });
  });

  it.each([400, 401, 403, 404, 422])('keeps Chatwoot visible HTTP %s final', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private body', { status }));
    const error = await createChatwootMessage(env, '1', '2', 'Reply', `cw-${status}`).catch(value => value);
    expect(error).toMatchObject({ outcome: 'FINAL', code: 'OUTBOUND_PROVIDER_4XX_FINAL', httpStatus: status });
  });

  it.each([400, 401, 403, 404, 422])('keeps Telegram visible API %s final', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: status, description: 'private body'
    }), { status: 200 }));
    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toMatchObject({ outcome: 'FINAL', code: 'OUTBOUND_PROVIDER_4XX_FINAL', httpStatus: status });
  });

  it.each([400, 401, 403, 404, 422])('keeps Telegram visible HTTP %s final', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private body', { status }));
    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toMatchObject({ outcome: 'FINAL', code: 'OUTBOUND_PROVIDER_4XX_FINAL', httpStatus: status });
  });
});


describe('Adapter Lifecycle', () => {
  it('Chatwoot adapter calls lifecycle correctly', async () => {
    const testEnv = env as any;
    const calls: string[] = [];
    
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls.push('fetch');
      return new Response(JSON.stringify({ id: 999 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const lifecycle = {
      requestStarted: vi.fn().mockImplementation(async () => { calls.push('requestStarted'); }),
      responseObserved: vi.fn().mockImplementation(async (status) => { calls.push('responseObserved:' + status); })
    };

    await createChatwootMessage(env, '1', '2', 'Reply', 'op-lifecycle-cw', lifecycle);
    
    expect(calls).toEqual(['requestStarted', 'fetch', 'responseObserved:200']);
  });

  it('Telegram Support Bot adapter calls lifecycle correctly', async () => {
    const testEnv = env as any;
    const calls: string[] = [];
    
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls.push('fetch');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1234 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const lifecycle = {
      requestStarted: vi.fn().mockImplementation(async () => { calls.push('requestStarted'); }),
      responseObserved: vi.fn().mockImplementation(async (status) => { calls.push('responseObserved:' + status); })
    };

    await sendTelegramMessage(env, '123', null, 'Reply', lifecycle);
    
    expect(calls).toEqual(['requestStarted', 'fetch', 'responseObserved:200']);
  });
});
