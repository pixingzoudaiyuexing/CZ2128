import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAttachmentConfig } from '../src/config/attachments';
import { AttachmentRow } from '../src/core/attachments';
import {
  AttachmentProcessingError,
  downloadTelegramAttachment,
  storeAttachmentStream
} from '../src/attachments/source';

const PRIVATE_TOKEN = 'tg-test-token-sentinel';
const PRIVATE_FILE_ID = 'private-file-id-sentinel';
const PRIVATE_FILE_PATH = 'private/path-sentinel.bin';
const PRIVATE_URL = 'https://private.example/secret-sentinel';
const PRIVATE_BODY = 'provider-body-sentinel';

const env = {
  TELEGRAM_BOT_TOKEN: PRIVATE_TOKEN
} as any;

const telemetry = {
  attachmentId: 'att_telemetry',
  attempt: 2
};

const row = {
  id: 'att_telemetry',
  storage_key: 'attachments/att_telemetry',
  mime_type: 'application/octet-stream'
} as AttachmentRow;

function captureLogs() {
  const entries: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => entries.push(String(value)));
  vi.spyOn(console, 'warn').mockImplementation(value => entries.push(String(value)));
  vi.spyOn(console, 'error').mockImplementation(value => entries.push(String(value)));
  return entries;
}

function parsedTelemetry(entries: string[]) {
  return entries.map(entry => JSON.parse(entry)).filter(entry => entry.msg === 'Attachment source telemetry');
}

function expectNoSensitiveTelemetry(entries: string[]) {
  const output = entries.join('\n');
  for (const sentinel of [PRIVATE_TOKEN, PRIVATE_FILE_ID, PRIVATE_FILE_PATH, PRIVATE_URL, PRIVATE_BODY]) {
    expect(output).not.toContain(sentinel);
  }
}

function telegramDownload(declaredSize: number | null = 3) {
  return downloadTelegramAttachment(
    env,
    PRIVATE_FILE_ID,
    declaredSize,
    getAttachmentConfig(env),
    telemetry
  );
}

function telegramPayload(path = PRIVATE_FILE_PATH) {
  return new Response(JSON.stringify({ ok: true, result: { file_path: path } }), { status: 200 });
}

describe('Telegram attachment source telemetry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records finite success stages without changing Telegram requests', async () => {
    const entries = captureLogs();
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(telegramPayload())
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: { 'Content-Length': String(bytes.byteLength) }
      }));

    const source = await telegramDownload();
    source.finish();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${PRIVATE_TOKEN}/getFile`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ file_id: PRIVATE_FILE_ID }));
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://api.telegram.org/file/bot${PRIVATE_TOKEN}/private/path-sentinel.bin`
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(parsedTelemetry(entries)).toEqual([
      expect.objectContaining({
        attachment_id: 'att_telemetry', attempt: 2, source: 'TELEGRAM',
        source_stage: 'TELEGRAM_GET_FILE', source_result: 'SUCCESS'
      }),
      expect.objectContaining({
        attachment_id: 'att_telemetry', attempt: 2, source: 'TELEGRAM',
        source_stage: 'TELEGRAM_FILE_GET', source_result: 'SUCCESS'
      })
    ]);
    expectNoSensitiveTelemetry(entries);
  });

  it.each([
    [404, 'HTTP_4XX', 'ATTACHMENT_SOURCE_NOT_FOUND', false],
    [408, 'HTTP_408', 'ATTACHMENT_SOURCE_TRANSIENT', true],
    [429, 'HTTP_429', 'ATTACHMENT_SOURCE_RATE_LIMITED', true],
    [503, 'HTTP_5XX', 'ATTACHMENT_SOURCE_TRANSIENT', true]
  ] as const)(
    'records getFile HTTP %s without changing its error contract',
    async (status, result, code, retryable) => {
      const entries = captureLogs();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PRIVATE_BODY, { status }));

      const error = await telegramDownload().then(() => null, value => value as AttachmentProcessingError);

      expect(error).toMatchObject({ code, retryable });
      expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
        source_stage: 'TELEGRAM_GET_FILE', source_result: result, http_status: status
      }));
      expectNoSensitiveTelemetry(entries);
    }
  );

  it('records getFile transport failure without leaking the thrown error', async () => {
    const entries = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`${PRIVATE_URL} ${PRIVATE_BODY}`));

    const error = await telegramDownload().then(() => null, value => value as AttachmentProcessingError);

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'TELEGRAM_GET_FILE', source_result: 'TRANSPORT'
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it('records getFile timeout separately from transport failure', async () => {
    vi.useFakeTimers();
    const entries = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));

    const pending = downloadTelegramAttachment(
      env,
      PRIVATE_FILE_ID,
      3,
      { ...getAttachmentConfig(env), sourceTimeoutMs: 10 },
      telemetry
    ).then(() => null, (value: unknown) => value as AttachmentProcessingError);
    await vi.advanceTimersByTimeAsync(11);
    const error = await pending;

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'TELEGRAM_GET_FILE', source_result: 'TIMEOUT'
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it('records invalid getFile JSON as a finite invalid response', async () => {
    const entries = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`not-json ${PRIVATE_BODY}`, { status: 200 }));

    const error = await telegramDownload().then(() => null, value => value as AttachmentProcessingError);

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'TELEGRAM_GET_FILE', source_result: 'INVALID_RESPONSE', http_status: 200
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it('records a getFile metadata parse deadline as timeout', async () => {
    vi.useFakeTimers();
    const entries = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const response = new Response(null, { status: 200 });
      response.json = () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return response;
    });

    const pending = downloadTelegramAttachment(
      env,
      PRIVATE_FILE_ID,
      3,
      { ...getAttachmentConfig(env), sourceTimeoutMs: 10 },
      telemetry
    ).then(() => null, value => value as AttachmentProcessingError);
    await vi.advanceTimersByTimeAsync(11);
    const error = await pending;

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'TELEGRAM_GET_FILE', source_result: 'TIMEOUT'
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it.each([
    [404, 'HTTP_4XX', 'ATTACHMENT_SOURCE_NOT_FOUND', false],
    [408, 'HTTP_408', 'ATTACHMENT_SOURCE_TRANSIENT', true],
    [429, 'HTTP_429', 'ATTACHMENT_SOURCE_RATE_LIMITED', true],
    [503, 'HTTP_5XX', 'ATTACHMENT_SOURCE_TRANSIENT', true]
  ] as const)(
    'records file GET HTTP %s without changing its error contract',
    async (status, result, code, retryable) => {
      const entries = captureLogs();
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(telegramPayload())
        .mockResolvedValueOnce(new Response(PRIVATE_BODY, { status }));

      const error = await telegramDownload().then(() => null, value => value as AttachmentProcessingError);

      expect(error).toMatchObject({ code, retryable });
      expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
        source_stage: 'TELEGRAM_FILE_GET', source_result: result, http_status: status
      }));
      expectNoSensitiveTelemetry(entries);
    }
  );

  it('records file GET transport failure without changing retry semantics', async () => {
    const entries = captureLogs();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(telegramPayload())
      .mockRejectedValueOnce(new Error(`${PRIVATE_FILE_PATH} ${PRIVATE_BODY}`));

    const error = await telegramDownload().then(() => null, value => value as AttachmentProcessingError);

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'TELEGRAM_FILE_GET', source_result: 'TRANSPORT'
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it('records source stream failure without confusing it with an R2 failure', async () => {
    const entries = captureLogs();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error(`${PRIVATE_URL} ${PRIVATE_BODY}`));
      }
    });
    const bucket = {
      createMultipartUpload: async () => ({
        uploadPart: async (partNumber: number) => ({ partNumber, etag: 'etag' }),
        complete: async () => undefined,
        abort: async () => undefined
      })
    };

    const error = await (storeAttachmentStream as any)(bucket, row, broken, 10, telemetry)
      .then(() => null, (value: unknown) => value as AttachmentProcessingError);

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'SOURCE_STREAM', source_result: 'STREAM_ERROR'
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it('records a deadline-aborted source stream as timeout', async () => {
    const entries = captureLogs();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException('Aborted', 'AbortError'));
      }
    });
    const bucket = {
      createMultipartUpload: async () => ({
        uploadPart: async (partNumber: number) => ({ partNumber, etag: 'etag' }),
        complete: async () => undefined,
        abort: async () => undefined
      })
    };

    const error = await storeAttachmentStream(
      bucket as any,
      row,
      broken,
      10,
      { ...telemetry, didTimeout: () => true }
    ).then(() => null, value => value as AttachmentProcessingError);

    expect(error).toMatchObject({ code: 'ATTACHMENT_SOURCE_TRANSIENT', retryable: true });
    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      source_stage: 'SOURCE_STREAM', source_result: 'TIMEOUT'
    }));
    expectNoSensitiveTelemetry(entries);
  });

  it('records complete source stream success with bounded duration', async () => {
    const entries = captureLogs();
    const bucket = {
      createMultipartUpload: async () => ({
        uploadPart: async (partNumber: number) => ({ partNumber, etag: 'etag' }),
        complete: async () => undefined,
        abort: async () => undefined
      })
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      }
    });

    await storeAttachmentStream(bucket as any, row, body, 10, telemetry);

    expect(parsedTelemetry(entries)).toContainEqual(expect.objectContaining({
      attachment_id: 'att_telemetry', attempt: 2,
      source_stage: 'SOURCE_STREAM', source_result: 'SUCCESS'
    }));
    for (const entry of parsedTelemetry(entries)) {
      expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
      expect(entry.duration_ms).toBeLessThanOrEqual(3_600_000);
    }
    expectNoSensitiveTelemetry(entries);
  });
});
