import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAttachmentConfig } from '../src/config/attachments';
import { AttachmentRow } from '../src/core/attachments';
import {
  AttachmentProcessingError,
  classifyAttachmentSourceHttpFailure,
  downloadChatwootAttachment,
  downloadCrispAttachment,
  downloadTelegramAttachment,
  storeAttachmentStream
} from '../src/attachments/source';

const env = {
  CHATWOOT_API_URL: 'https://chatwoot.example',
  CHATWOOT_API_TOKEN: 'chatwoot-secret',
  TELEGRAM_BOT_TOKEN: 'telegram-secret',
  CHATWOOT_ATTACHMENT_ALLOWED_HOSTS: 'cdn.example'
} as any;

const row = {
  id: 'att_1',
  storage_key: 'attachments/att_1',
  mime_type: 'application/octet-stream'
} as AttachmentRow;

function stream(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    }
  });
}

class MultipartBucket {
  uploadedParts: Uint8Array[] = [];
  completed = 0;
  aborted = 0;
  failUpload = false;

  async createMultipartUpload(key: string) {
    expect(key).toBe('attachments/att_1');
    return {
      uploadPart: async (_number: number, value: Uint8Array) => {
        if (this.failUpload) throw new Error('R2 private detail');
        this.uploadedParts.push(value.slice());
        return { partNumber: this.uploadedParts.length, etag: `part-${this.uploadedParts.length}` };
      },
      complete: async () => { this.completed += 1; },
      abort: async () => { this.aborted += 1; }
    };
  }
}

describe('attachment source security', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows an exact allowlisted DNS hostname that starts with fc', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream([1]), { status: 200, headers: { 'Content-Length': '1' } })
    );
    const fcdnEnv = { ...env, CHATWOOT_API_URL: 'https://fcdn.example.com' } as any;

    const result = await downloadChatwootAttachment(
      fcdnEnv,
      'https://fcdn.example.com/file',
      getAttachmentConfig(fcdnEnv)
    );
    result.finish();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://0.0.0.0/file',
    'https://127.0.0.1/file',
    'https://10.0.0.1/file',
    'https://172.16.0.1/file',
    'https://192.168.1.1/file',
    'https://169.254.169.254/latest/meta-data',
    'https://[fe90::1]/file',
    'https://[febf::1]/file',
    'https://[fc00::1]/file',
    'https://[fd00::1]/file',
    'https://[ff00::1]/file',
    'https://[::1]/file',
    'https://[::ffff:127.0.0.1]/file',
    'https://[::ffff:169.254.1.1]/file',
    'https://[::ffff:192.168.1.1]/file'
  ])('rejects an exact-allowlisted special IP literal %s', async url => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const literalEnv = { ...env, CHATWOOT_API_URL: new URL(url).origin } as any;

    await expect(
      downloadChatwootAttachment(literalEnv, url, getAttachmentConfig(literalEnv))
    ).rejects.toMatchObject({ code: 'ATTACHMENT_SOURCE_INVALID', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://arbitrary.example/file',
    'http://chatwoot.example/file',
    'https://localhost/file',
    'https://127.0.0.1/file',
    'https://10.0.0.1/file',
    'https://172.16.0.1/file',
    'https://192.168.1.1/file',
    'https://[::1]/file',
    'https://169.254.169.254/latest/meta-data',
    'https://[fe80::1]/file'
  ])('rejects disallowed Chatwoot source URL %s', async url => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const config = getAttachmentConfig({ ...env, CHATWOOT_ATTACHMENT_ALLOWED_HOSTS: 'cdn.example,127.0.0.1' } as any);
    await expect(downloadChatwootAttachment(env, url, config)).rejects.toMatchObject({
      code: 'ATTACHMENT_SOURCE_INVALID', retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses manual redirects and strips credentials at an allowed storage origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://cdn.example/file.bin' } }))
      .mockResolvedValueOnce(new Response(stream([1, 2, 3]), { status: 200, headers: { 'Content-Length': '3' } }));

    const result = await downloadChatwootAttachment(env, 'https://chatwoot.example/files/1', getAttachmentConfig(env));
    expect(result.contentLength).toBe(3);
    result.finish();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('api_access_token')).toBe('chatwoot-secret');
    const redirectedHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(redirectedHeaders.has('api_access_token')).toBe(false);
    expect(redirectedHeaders.has('Authorization')).toBe(false);
    expect(redirectedHeaders.has('Cookie')).toBe(false);
  });

  it('does not reintroduce credentials when a redirect chain returns to Chatwoot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://cdn.example/file.bin' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://chatwoot.example/files/2' } }))
      .mockResolvedValueOnce(new Response(stream([1]), { status: 200, headers: { 'Content-Length': '1' } }));

    const result = await downloadChatwootAttachment(env, 'https://chatwoot.example/files/1', getAttachmentConfig(env));
    result.finish();

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('api_access_token')).toBe('chatwoot-secret');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('api_access_token')).toBe(false);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).has('api_access_token')).toBe(false);
  });

  it('rejects redirects to unlisted hosts and redirect chains over three hops', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://evil.example/file' } }));
    await expect(downloadChatwootAttachment(env, 'https://chatwoot.example/files/1', getAttachmentConfig(env))).rejects.toMatchObject({
      code: 'ATTACHMENT_SOURCE_INVALID'
    });

    fetchMock.mockReset();
    for (let index = 0; index < 4; index++) {
      fetchMock.mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: `https://cdn.example/redirect-${index}` }
      }));
    }
    await expect(downloadChatwootAttachment(env, 'https://chatwoot.example/files/1', getAttachmentConfig(env))).rejects.toMatchObject({
      code: 'ATTACHMENT_SOURCE_INVALID'
    });
  });

  it('rejects Content-Length over the hard limit before streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream([1]), {
      status: 200,
      headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) }
    }));
    await expect(downloadChatwootAttachment(env, 'https://chatwoot.example/file', getAttachmentConfig(env))).rejects.toMatchObject({
      code: 'ATTACHMENT_SOURCE_TOO_LARGE', retryable: false
    });
  });

  it.each([408, 429, 500, 502, 503, 504])('classifies source HTTP %s as retryable', status => {
    expect(classifyAttachmentSourceHttpFailure(status)).toMatchObject({ retryable: true });
  });

  it.each([400, 401, 403, 404, 410, 422])('classifies source HTTP %s as final', status => {
    expect(classifyAttachmentSourceHttpFailure(status)).toMatchObject({ retryable: false });
  });

  it('honors Chatwoot source Retry-After without reading the private body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private source body', {
      status: 429, headers: { 'Retry-After': '30' }
    }));
    const error = await downloadChatwootAttachment(
      env, 'https://chatwoot.example/file', getAttachmentConfig(env)
    ).then(() => null, value => value as AttachmentProcessingError);
    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_RATE_LIMITED', retryable: true });
    expect(error?.retryAfterSeconds).toBeGreaterThanOrEqual(30);
    expect(String(error)).not.toContain('private source body');
  });

  it('uses Telegram getFile retry_after before the HTTP header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: false, error_code: 429, parameters: { retry_after: 10 }, description: 'private'
    }), { status: 429, headers: { 'Retry-After': '30' } }));
    const error = await downloadTelegramAttachment(env, 'file-id', 1, getAttachmentConfig(env))
      .then(() => null, value => value as AttachmentProcessingError);
    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_RATE_LIMITED', retryable: true });
    expect(error?.retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(error?.retryAfterSeconds).toBeLessThan(30);
  });

  it('classifies source transport failure as retryable without leaking details', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('dns failure with private URL'));
    const error = await downloadChatwootAttachment(
      env, 'https://chatwoot.example/file', getAttachmentConfig(env)
    ).then(() => null, value => value as AttachmentProcessingError);
    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(String(error)).not.toContain('private URL');
  });

  it('keeps the source deadline active while parsing Telegram getFile metadata', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const response = new Response(null, { status: 200 });
        response.json = () => new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        return response;
      });
      const pending = downloadTelegramAttachment(
        env,
        'file-id',
        1,
        { ...getAttachmentConfig(env), sourceTimeoutMs: 10 }
      ).then(() => null, value => value as AttachmentProcessingError);

      await vi.advanceTimersByTimeAsync(11);
      const error = await pending;
      expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects oversized Telegram metadata before getFile and never exposes its token URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const error = await downloadTelegramAttachment(
      env,
      'file-id',
      20 * 1024 * 1024 + 1,
      getAttachmentConfig(env)
    ).then(() => null, value => value as AttachmentProcessingError);
    expect(error).not.toBeNull();
    if (!error) throw new Error('Expected Telegram size rejection');
    expect(error.code).toBe('ATTACHMENT_SOURCE_TOO_LARGE');
    expect(String(error)).not.toContain('telegram-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads a Crisp image only from the exact official storage host with manual redirects', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { Location: 'https://storage.crisp.chat/users/upload/session/final.png' }
      }))
      .mockResolvedValueOnce(new Response(stream([1, 2, 3]), {
        status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': '3' }
      }));
    const result = await downloadCrispAttachment(
      'https://storage.crisp.chat/users/upload/session/start.png', getAttachmentConfig(env)
    );
    expect(result.contentLength).toBe(3);
    result.finish();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
    expect(fetchMock.mock.calls[1][1]?.redirect).toBe('manual');
  });

  it.each([
    'http://storage.crisp.chat/a.png',
    'https://evil.example/a.png',
    'https://storage.crisp.chat.evil.example/a.png',
    'https://user:pass@storage.crisp.chat/a.png',
    'https://storage.crisp.chat:444/a.png'
  ])('rejects untrusted Crisp image source %s before fetching', async url => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(downloadCrispAttachment(url, getAttachmentConfig(env))).rejects.toMatchObject({
      code: 'ATTACHMENT_SOURCE_INVALID', retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a Crisp redirect off the official storage host', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: 'https://evil.example/image.png' }
    }));
    await expect(downloadCrispAttachment(
      'https://storage.crisp.chat/users/upload/session/a.png', getAttachmentConfig(env)
    )).rejects.toMatchObject({ code: 'ATTACHMENT_SOURCE_INVALID' });
  });

  it('rejects an active SVG Crisp response even when the webhook claimed an image', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream([1]), {
      status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': '1' }
    }));
    await expect(downloadCrispAttachment(
      'https://storage.crisp.chat/users/upload/session/a.png', getAttachmentConfig(env)
    )).rejects.toMatchObject({ code: 'ATTACHMENT_SOURCE_INVALID' });
  });

  it('rejects an oversized Crisp image from Content-Length before streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream([1]), {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(20 * 1024 * 1024 + 1) }
    }));
    await expect(downloadCrispAttachment(
      'https://storage.crisp.chat/users/upload/session/a.png', getAttachmentConfig(env)
    )).rejects.toMatchObject({ code: 'ATTACHMENT_SOURCE_TOO_LARGE' });
  });

  it('accepts the exact stream boundary using bounded multipart chunks', async () => {
    const bucket = new MultipartBucket();
    const size = await storeAttachmentStream(bucket as any, row, stream([1, 2], [3, 4, 5, 6]), 6);
    expect(size).toBe(6);
    expect(bucket.completed).toBe(1);
    expect(bucket.aborted).toBe(0);
    expect(bucket.uploadedParts.reduce((sum, part) => sum + part.byteLength, 0)).toBe(6);
  });

  it('aborts multipart storage when actual streamed bytes exceed the limit', async () => {
    const bucket = new MultipartBucket();
    await expect(storeAttachmentStream(bucket as any, row, stream([1, 2, 3], [4, 5, 6, 7]), 6)).rejects.toMatchObject({
      code: 'ATTACHMENT_SOURCE_TOO_LARGE', retryable: false
    });
    expect(bucket.completed).toBe(0);
    expect(bucket.aborted).toBe(1);
  });

  it('classifies R2 multipart failure as retryable and aborts the upload', async () => {
    const bucket = new MultipartBucket();
    bucket.failUpload = true;
    await expect(storeAttachmentStream(bucket as any, row, stream([1, 2, 3]), 6)).rejects.toMatchObject({
      code: 'R2_STORE_TRANSIENT', retryable: true
    });
    expect(bucket.aborted).toBe(1);
  });

  it('classifies a mid-stream source disconnect separately from R2 failure', async () => {
    const bucket = new MultipartBucket();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error('private source URL disconnected'));
      }
    });
    const error = await storeAttachmentStream(bucket as any, row, broken, 6)
      .then(() => null, value => value as AttachmentProcessingError);
    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(String(error)).not.toContain('private source URL');
    expect(bucket.aborted).toBe(1);
  });
});