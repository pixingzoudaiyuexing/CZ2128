import { AttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { AttachmentRow } from '../core/attachments';
import { ErrorProvider, SafeErrorCode, getSafeErrorDefinition } from '../core/error-taxonomy';
import { SafeError, SafeErrorOptions } from '../core/errors';
import { resolveRetryAfterSeconds, retryAfterHeader } from '../core/retry';
import { readTelegramRetryAfterMetadata, telegramRetryAfterValue } from '../adapters/telegram/error-metadata';

const R2_PART_BYTES = 5 * 1024 * 1024;
const MAX_CHATWOOT_REDIRECTS = 3;

export class AttachmentProcessingError extends SafeError {
  public readonly retryable: boolean;

  constructor(
    code: SafeErrorCode,
    options: SafeErrorOptions = {}
  ) {
    super(code, options);
    this.name = 'AttachmentProcessingError';
    this.retryable = getSafeErrorDefinition(code).retryability === 'AUTOMATIC';
  }
}

export function classifyAttachmentSourceHttpFailure(
  status: number,
  options: {
    provider?: Extract<ErrorProvider, 'TELEGRAM' | 'CHATWOOT'>;
    telegramRetryAfter?: unknown;
    httpRetryAfter?: string | null;
  } = {}
): AttachmentProcessingError {
  const metadata: SafeErrorOptions = { provider: options.provider, httpStatus: status };
  if (status === 429) {
    return new AttachmentProcessingError('ATTACHMENT_SOURCE_RATE_LIMITED', {
      ...metadata,
      retryAfterSeconds: resolveRetryAfterSeconds({
        telegramRetryAfter: options.telegramRetryAfter,
        httpRetryAfter: options.httpRetryAfter
      })
    });
  }
  if (status === 408 || status >= 500) return new AttachmentProcessingError('ATTACHMENT_SOURCE_TRANSIENT', metadata);
  if (status === 401 || status === 403) {
    return new AttachmentProcessingError('ATTACHMENT_SOURCE_AUTH_FAILED', metadata);
  }
  if (status === 404 || status === 410) {
    return new AttachmentProcessingError('ATTACHMENT_SOURCE_NOT_FOUND', metadata);
  }
  return new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', metadata);
}

function parseContentLength(response: Response, maxBytes: number): number | undefined {
  const value = response.headers.get('Content-Length');
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
  if (parsed > maxBytes) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TOO_LARGE');
  return parsed;
}

function parseIpv4Literal(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function isDisallowedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    parts.every(part => part === 0) ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function parseIpv6Literal(hostname: string): number[] | null {
  if (!hostname.includes(':')) return null;
  const halves = hostname.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const segments = [...left, ...right];
  if (segments.some(segment => !/^[0-9a-f]{1,4}$/.test(segment))) return null;
  const omitted = 8 - segments.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  return [
    ...left.map(segment => Number.parseInt(segment, 16)),
    ...Array.from({ length: omitted }, () => 0),
    ...right.map(segment => Number.parseInt(segment, 16))
  ];
}

function isDisallowedLiteralAddress(hostname: string): boolean {
  const ipv4 = parseIpv4Literal(hostname);
  if (ipv4) return isDisallowedIpv4(ipv4);

  const ipv6 = parseIpv6Literal(hostname);
  if (!ipv6) return false;
  if (ipv6.every(segment => segment === 0)) return true;
  if (ipv6.slice(0, 7).every(segment => segment === 0) && ipv6[7] === 1) return true;
  if ((ipv6[0] & 0xfe00) === 0xfc00) return true;
  if ((ipv6[0] & 0xffc0) === 0xfe80) return true;
  if ((ipv6[0] & 0xff00) === 0xff00) return true;
  if (ipv6.slice(0, 5).every(segment => segment === 0) && ipv6[5] === 0xffff) {
    return isDisallowedIpv4([
      ipv6[6] >> 8,
      ipv6[6] & 0xff,
      ipv6[7] >> 8,
      ipv6[7] & 0xff
    ]);
  }
  return false;
}

function validateChatwootUrl(url: URL, config: AttachmentConfig, initial: boolean): void {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
  }
  if (
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal' || hostname === 'metadata.internal' ||
    isDisallowedLiteralAddress(hostname)
  ) {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
  }
  if (!config.allowedChatwootAttachmentHosts.has(url.host.toLowerCase())) {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
  }
  if (initial && config.chatwootOrigin !== url.origin) {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
  }
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  deadline: number
): Promise<{ response: Response; finish: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(deadline - Date.now(), 1));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, finish: () => clearTimeout(timeout) };
  } catch {
    clearTimeout(timeout);
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TRANSIENT');
  }
}

export async function downloadChatwootAttachment(
  env: Env,
  dataUrl: string,
  config: AttachmentConfig
): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; finish: () => void }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
  let current: URL;
  try {
    current = new URL(dataUrl);
  } catch {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
  }
  validateChatwootUrl(current, config, true);
  const deadline = Date.now() + config.sourceTimeoutMs;

  for (let redirects = 0; redirects <= MAX_CHATWOOT_REDIRECTS; redirects++) {
    const headers = new Headers();
    if (redirects === 0 && config.chatwootOrigin === current.origin) {
      headers.set('api_access_token', env.CHATWOOT_API_TOKEN);
    }
    const fetched = await fetchWithDeadline(
      current.toString(),
      { method: 'GET', redirect: 'manual', headers },
      deadline
    );
    const response = fetched.response;

    if (response.status >= 300 && response.status < 400) {
      fetched.finish();
      if (redirects === MAX_CHATWOOT_REDIRECTS) {
        throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
      }
      const location = response.headers.get('Location');
      if (!location) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
      try {
        current = new URL(location, current);
      } catch {
        throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
      }
      validateChatwootUrl(current, config, false);
      continue;
    }
    if (!response.ok) {
      fetched.finish();
      throw classifyAttachmentSourceHttpFailure(response.status, {
        provider: 'CHATWOOT',
        httpRetryAfter: retryAfterHeader(response)
      });
    }
    if (!response.body) {
      fetched.finish();
      throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TRANSIENT', { provider: 'CHATWOOT' });
    }
    try {
      return {
        body: response.body,
        contentLength: parseContentLength(response, config.maxBytes),
        finish: fetched.finish
      };
    } catch (error) {
      fetched.finish();
      throw error;
    }
  }
  throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'CHATWOOT' });
}

export async function downloadTelegramAttachment(
  env: Env,
  fileId: string,
  declaredSize: number | null,
  config: AttachmentConfig
): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; finish: () => void }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.TELEGRAM_SUPPORT_PROFILE
  ) {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID', { provider: 'TELEGRAM' });
  }
  if (declaredSize !== null && declaredSize > config.maxBytes) {
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TOO_LARGE', { provider: 'TELEGRAM' });
  }
  const deadline = Date.now() + config.sourceTimeoutMs;
  const metadataRequest = await fetchWithDeadline(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    },
    deadline
  );
  const metadata = metadataRequest.response;
  if (!metadata.ok) {
    const telegramRetryAfter = metadata.status === 429
      ? await readTelegramRetryAfterMetadata(metadata)
      : undefined;
    metadataRequest.finish();
    throw classifyAttachmentSourceHttpFailure(metadata.status, {
      provider: 'TELEGRAM',
      telegramRetryAfter,
      httpRetryAfter: retryAfterHeader(metadata)
    });
  }
  let payload: any;
  try {
    payload = await metadata.json();
  } catch (error) {
    if (error instanceof AttachmentProcessingError) throw error;
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TRANSIENT', { provider: 'TELEGRAM' });
  } finally {
    metadataRequest.finish();
  }
  if (payload?.ok !== true || typeof payload?.result?.file_path !== 'string') {
    const status = typeof payload?.error_code === 'number' ? payload.error_code : 400;
    throw classifyAttachmentSourceHttpFailure(status, {
      provider: 'TELEGRAM',
      telegramRetryAfter: telegramRetryAfterValue(payload),
      httpRetryAfter: retryAfterHeader(metadata)
    });
  }
  const safePath = payload.result.file_path.split('/').map((part: string) => encodeURIComponent(part)).join('/');
  const downloaded = await fetchWithDeadline(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${safePath}`,
    { method: 'GET', redirect: 'error' },
    deadline
  );
  const response = downloaded.response;
  if (!response.ok) {
    downloaded.finish();
    throw classifyAttachmentSourceHttpFailure(response.status, {
      provider: 'TELEGRAM',
      httpRetryAfter: retryAfterHeader(response)
    });
  }
  if (!response.body) {
    downloaded.finish();
    throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TRANSIENT', { provider: 'TELEGRAM' });
  }
  try {
    return {
      body: response.body,
      contentLength: parseContentLength(response, config.maxBytes),
      finish: downloaded.finish
    };
  } catch (error) {
    downloaded.finish();
    throw error;
  }
}

export async function storeAttachmentStream(
  bucket: R2Bucket,
  row: AttachmentRow,
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<number> {
  let upload: R2MultipartUpload | undefined;
  const reader = body.getReader();
  let buffer = new Uint8Array(R2_PART_BYTES);
  let used = 0;
  let total = 0;
  let partNumber = 1;
  const parts: R2UploadedPart[] = [];

  try {
    upload = await bucket.createMultipartUpload(row.storage_key, {
      httpMetadata: { contentType: row.mime_type },
      customMetadata: { attachmentId: row.id }
    });
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TRANSIENT');
      }
      const { done, value } = chunk;
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(buffer.byteLength - used, value.byteLength - offset);
        if (total + length > maxBytes) {
          await reader.cancel('SOURCE_TOO_LARGE');
          throw new AttachmentProcessingError('ATTACHMENT_SOURCE_TOO_LARGE');
        }
        buffer.set(value.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        total += length;
        if (used === buffer.byteLength) {
          parts.push(await upload.uploadPart(partNumber++, buffer));
          buffer = new Uint8Array(R2_PART_BYTES);
          used = 0;
        }
      }
    }
    if (total === 0) throw new AttachmentProcessingError('ATTACHMENT_SOURCE_INVALID');
    if (used > 0) parts.push(await upload.uploadPart(partNumber, buffer.slice(0, used)));
    await upload.complete(parts);
    return total;
  } catch (error) {
    if (upload) {
      try { await upload.abort(); } catch { /* cleanup retries through R2 lifecycle */ }
    }
    if (error instanceof AttachmentProcessingError) throw error;
    throw new AttachmentProcessingError('R2_STORE_TRANSIENT', { provider: 'R2' });
  } finally {
    reader.releaseLock();
  }
}
