import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverAttachmentToChatwoot,
  deliverAttachmentToCrisp,
  deliverAttachmentToTelegram,
  loadAttachmentBuffer
} from '../src/attachments/delivery';
import { getAttachmentConfig } from '../src/config/attachments';
import { AttachmentRow } from '../src/core/attachments';
import { ProviderDeliveryError } from '../src/core/errors';

const env = {
  CHATWOOT_API_URL: 'https://chatwoot.example',
  CHATWOOT_API_TOKEN: 'chatwoot-secret',
  TELEGRAM_BOT_TOKEN: 'telegram-secret',
  BOT_GROUP_ID: '-100'
} as any;
const config = getAttachmentConfig(env);

function attachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'att_1', conversation_id: 'conv', source_provider: 'telegram',
    source_message_ref: 'message', source_attachment_ref: 'source', attachment_type: 'document',
    original_filename: 'private.txt', safe_filename: 'safe.txt', mime_type: 'text/plain',
    size_bytes: 3, storage_key: 'attachments/att_1', access_token_hash: 'hash', status: 'STORED',
    destination_provider: 'chatwoot', destination_message_ref: null, attempt_count: 1,
    expires_at: 1, last_error: null, created_at: 1, updated_at: 1,
    ...overrides
  };
}

describe('attachment multipart delivery', () => {

  it('calls OutboundAttemptLifecycle correctly for attachment delivery', async () => {


    const calls: string[] = [];
    
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls.push('fetch');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const lifecycle = {
      requestStarted: vi.fn().mockImplementation(async () => { calls.push('requestStarted'); }),
      responseObserved: vi.fn().mockImplementation(async (status) => { calls.push('responseObserved:' + status); })
    };

    const attach = { id: 'mock.png', file_name: 'test.png', mime_type: 'image/png' } as any;

    await deliverAttachmentToTelegram(env, { provider: 'TELEGRAM', maxSizeBytes: 4096 } as any, attach, '123', new Uint8Array([1, 2, 3]).buffer, lifecycle);
    
    expect(calls).toEqual(['requestStarted', 'fetch', 'responseObserved:200']);
  });

  afterEach(() => vi.restoreAllMocks());

  it('marks Telegram human attachment messages to Crisp as non-automated while preserving identity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { fingerprint: 123 } }), { status: 200 })
    );
    await deliverAttachmentToCrisp(
      {
        CRISP_API_IDENTIFIER: 'identifier',
        CRISP_API_KEY: 'key'
      } as any,
      'website-1',
      'session-1',
      'attachment_crisp:att-human',
      'Attachment from human operator',
      undefined,
      { nickname: '人工客服', avatar: 'https://cdn.example/operator.png' }
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      type: 'text',
      from: 'operator',
      automated: false,
      user: { nickname: '人工客服', avatar: 'https://cdn.example/operator.png' }
    });
  });

  it('uploads Chatwoot attachments[] with source_id correlation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 44 }), { status: 200 }));
    const result = await deliverAttachmentToChatwoot(
      env, config, attachment(), '1', '2', 'attachment_chatwoot:att_1', new Uint8Array([1, 2, 3]).buffer
    );

    expect(result.providerMessageRef).toBe('44');
    expect(fetchMock.mock.calls[0][0]).toBe('https://chatwoot.example/api/v1/accounts/1/conversations/2/messages');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('api_access_token')).toBe('chatwoot-secret');
    const form = init.body as FormData;
    expect(form.get('source_id')).toBe('cz2128:attachment_chatwoot:att_1');
    expect(form.get('message_type')).toBe('outgoing');
    expect((form.get('attachments[]') as File).size).toBe(3);
  });

  it('uses the canonical Chatwoot base path for attachment delivery', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 44 }), { status: 200 })
    );
    await deliverAttachmentToChatwoot(
      { ...env, CHATWOOT_API_URL: 'https://chatwoot.example/tenant-a/' },
      config,
      attachment(),
      '1',
      '2',
      'attachment_chatwoot:att_1',
      new Uint8Array([1, 2, 3]).buffer
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://chatwoot.example/tenant-a/api/v1/accounts/1/conversations/2/messages'
    );
  });

  it.each([
    ['photo', 'image/jpeg', 10 * 1024 * 1024, 'sendPhoto', 'photo'],
    ['photo', 'image/jpeg', 10 * 1024 * 1024 + 1, 'sendDocument', 'document'],
    ['document', 'application/pdf', 3, 'sendDocument', 'document'],
    ['video', 'video/mp4', 3, 'sendVideo', 'video'],
    ['audio', 'audio/mpeg', 3, 'sendAudio', 'audio'],
    ['voice', 'audio/ogg', 3, 'sendVoice', 'voice']
  ] as const)('maps %s multipart to Telegram %s', async (type, mime, size, method, field) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: { message_id: 55 }
    }), { status: 200 }));
    const bytes = new Uint8Array(Math.min(size, 3)).buffer;
    const result = await deliverAttachmentToTelegram(
      env, config, attachment({ attachment_type: type, mime_type: mime, size_bytes: size }), '7', bytes
    );
    expect(result.providerMessageRef).toBe('55');
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bottelegram-secret/${method}`);
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get(field)).toBeInstanceOf(Blob);
    expect(form.get('message_thread_id')).toBe('7');
  });

  it.each([
    [429, 'RETRYABLE'],
    [400, 'FINAL'],
    [401, 'FINAL'],
    [403, 'FINAL'],
    [404, 'FINAL'],
    [422, 'FINAL'],
    [408, 'AMBIGUOUS'],
    [500, 'AMBIGUOUS'],
    [502, 'AMBIGUOUS'],
    [503, 'AMBIGUOUS'],
    [504, 'AMBIGUOUS']
  ] as const)('classifies Chatwoot attachment HTTP %s as %s', async (status, outcome) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private provider body', { status }));
    const error = await deliverAttachmentToChatwoot(
      env, config, attachment(), '1', '2', 'op', new Uint8Array([1]).buffer
    ).then(() => null, value => value as ProviderDeliveryError);
    expect(error).toBeInstanceOf(ProviderDeliveryError);
    expect(error?.outcome).toBe(outcome);
    expect(String(error)).not.toContain('private provider body');
  });

  it('classifies Telegram JSON API 429 as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      parameters: { retry_after: 10 },
      description: 'private provider detail'
    }), { status: 200, headers: { 'Retry-After': '30' } }));
    const error = await deliverAttachmentToTelegram(
      env, config, attachment(), '7', new Uint8Array([1]).buffer
    ).then(() => null, value => value as ProviderDeliveryError);

    expect(error?.outcome).toBe('RETRYABLE');
    expect(error?.retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(error?.retryAfterSeconds).toBeLessThan(30);
    expect(String(error)).not.toContain('private provider detail');
  });

  it('keeps the destination timeout active while a Telegram 429 body stalls', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        requestSignal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          }
        });
        return new Response(body, { status: 429 });
      });

      const pending = deliverAttachmentToTelegram(
        env,
        { ...config, destinationTimeoutMs: 10 },
        attachment(),
        '7',
        new Uint8Array([1]).buffer
      ).then(() => null, value => value as ProviderDeliveryError);

      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(11);
      await Promise.resolve();

      expect(requestSignal?.aborted).toBe(true);
      expect(settled).toBe(true);
      const outcome = await pending;
      expect(outcome).toMatchObject({
        outcome: 'RETRYABLE',
        code: 'OUTBOUND_RATE_LIMITED',
        retryAfterSeconds: expect.any(Number)
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([408, 500, 502, 503, 504])('keeps Telegram attachment API %s ambiguous', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: status, description: 'private provider detail'
    }), { status: 200 }));
    const error = await deliverAttachmentToTelegram(
      env, config, attachment(), '7', new Uint8Array([1]).buffer
    ).then(() => null, value => value as ProviderDeliveryError);
    expect(error).toMatchObject({ outcome: 'AMBIGUOUS', httpStatus: status });
  });

  it.each([400, 401, 403, 404, 422])('keeps Telegram attachment API %s final', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: status, description: 'private provider detail'
    }), { status: 200 }));
    const error = await deliverAttachmentToTelegram(
      env, config, attachment(), '7', new Uint8Array([1]).buffer
    ).then(() => null, value => value as ProviderDeliveryError);
    expect(error).toMatchObject({ outcome: 'FINAL', httpStatus: status });
  });

  it('classifies transport loss and invalid success as ambiguous', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValueOnce(new Error('secret transport detail'));
    const transport = await deliverAttachmentToTelegram(
      env, config, attachment(), '7', new Uint8Array([1]).buffer
    ).then(() => null, value => value as ProviderDeliveryError);
    expect(transport?.outcome).toBe('AMBIGUOUS');
    expect(String(transport)).not.toContain('secret transport detail');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    const invalid = await deliverAttachmentToTelegram(
      env, config, attachment(), '7', new Uint8Array([1]).buffer
    ).then(() => null, value => value as ProviderDeliveryError);
    expect(invalid?.outcome).toBe('AMBIGUOUS');
  });

  it('keeps the destination timeout active while parsing the success response', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const response = new Response(null, { status: 200 });
        response.json = () => new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        return response;
      });
      const pending = deliverAttachmentToChatwoot(
        env,
        { ...config, destinationTimeoutMs: 10 },
        attachment(),
        '1',
        '2',
        'op',
        new Uint8Array([1]).buffer
      ).then(() => null, value => value as ProviderDeliveryError);

      await vi.advanceTimersByTimeAsync(11);
      const error = await pending;
      expect(error?.outcome).toBe('AMBIGUOUS');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds R2 reads before creating destination multipart', async () => {
    const missing = { get: async () => null };
    await expect(loadAttachmentBuffer(missing as any, attachment(), config.maxBytes)).rejects.toThrow('R2_OBJECT_MISSING');

    const oversized = { get: async () => ({ size: config.maxBytes + 1 }) };
    await expect(loadAttachmentBuffer(oversized as any, attachment(), config.maxBytes)).rejects.toThrow('R2_OBJECT_TOO_LARGE');

    const failure = { get: async () => { throw new Error('private R2 detail'); } };
    await expect(loadAttachmentBuffer(failure as any, attachment(), config.maxBytes)).rejects.toThrow('R2_READ_TRANSIENT');
  });
});
