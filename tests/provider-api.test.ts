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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));

    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'op-93').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('RETRYABLE');
  });

  it('classifies Telegram ok=false error_code=429 as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 200 }));

    const error = await sendTelegramMessage(env, '-100', '7', 'Hello').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('RETRYABLE');
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
});
