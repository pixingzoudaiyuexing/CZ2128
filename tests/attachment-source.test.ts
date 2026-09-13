import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAttachmentConfig } from '../src/config/attachments';
import { AttachmentRow } from '../src/core/attachments';
import {
  AttachmentProcessingError,
  downloadChatwootAttachment,
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
      code: 'SOURCE_URL_NOT_ALLOWED', retryable: false
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
      code: 'SOURCE_URL_NOT_ALLOWED'
    });

    fetchMock.mockReset();
    for (let index = 0; index < 4; index++) {
      fetchMock.mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: `https://cdn.example/redirect-${index}` }
      }));
    }
    await expect(downloadChatwootAttachment(env, 'https://chatwoot.example/files/1', getAttachmentConfig(env))).rejects.toMatchObject({
      code: 'SOURCE_REDIRECT_LIMIT'
    });
  });

  it('rejects Content-Length over the hard limit before streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream([1]), {
      status: 200,
      headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) }
    }));
    await expect(downloadChatwootAttachment(env, 'https://chatwoot.example/file', getAttachmentConfig(env))).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE', retryable: false
    });
  });

  it.each([
    [404, false],
    [408, true],
    [429, true],
    [503, true]
  ] as const)('classifies source HTTP %s retryable=%s', async (status, retryable) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private source body', { status }));
    const error = await downloadChatwootAttachment(
      env, 'https://chatwoot.example/file', getAttachmentConfig(env)
    ).then(() => null, value => value as AttachmentProcessingError);
    expect(error).toMatchObject({ retryable });
    expect(String(error)).not.toContain('private source body');
  });

  it('classifies source transport failure as retryable without leaking details', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('dns failure with private URL'));
    const error = await downloadChatwootAttachment(
      env, 'https://chatwoot.example/file', getAttachmentConfig(env)
    ).then(() => null, value => value as AttachmentProcessingError);
    expect(error).toMatchObject({ code: 'SOURCE_DOWNLOAD_FAILED', retryable: true });
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
      expect(error).toMatchObject({ code: 'SOURCE_DOWNLOAD_FAILED', retryable: true });
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
    expect(error.code).toBe('SOURCE_TOO_LARGE');
    expect(String(error)).not.toContain('telegram-secret');
    expect(fetchMock).not.toHaveBeenCalled();
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
      code: 'SOURCE_TOO_LARGE', retryable: false
    });
    expect(bucket.completed).toBe(0);
    expect(bucket.aborted).toBe(1);
  });

  it('classifies R2 multipart failure as retryable and aborts the upload', async () => {
    const bucket = new MultipartBucket();
    bucket.failUpload = true;
    await expect(storeAttachmentStream(bucket as any, row, stream([1, 2, 3]), 6)).rejects.toMatchObject({
      code: 'R2_STORE_FAILED', retryable: true
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
    expect(error).toMatchObject({ code: 'SOURCE_DOWNLOAD_FAILED', retryable: true });
    expect(String(error)).not.toContain('private source URL');
    expect(bucket.aborted).toBe(1);
  });
});
