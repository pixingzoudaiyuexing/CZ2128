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

  it('classifies explicit provider 5xx without exposing its response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private customer text and token', { status: 503 }));

    const error = await createChatwootMessage(env, '1', '2', 'Reply', 'op-92').catch(value => value);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error.outcome).toBe('RETRYABLE');
    expect(String(error)).not.toContain('private customer text');
    expect(String(error)).not.toContain('token');
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
});
