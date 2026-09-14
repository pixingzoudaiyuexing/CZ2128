import { AttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { AttachmentRow } from '../core/attachments';

const R2_PART_BYTES = 5 * 1024 * 1024;
const MAX_CHATWOOT_REDIRECTS = 3;

export class AttachmentProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(code);
    this.name = 'AttachmentProcessingError';
  }
}

function sourceHttpError(status: number): AttachmentProcessingError {
  if (status === 408 || status === 429 || status >= 500) {
    return new AttachmentProcessingError(`SOURCE_HTTP_${status}`, true);
  }
  if (status === 401 || status === 403) {
    return new AttachmentProcessingError('SOURCE_AUTH_FAILED', false);
  }
  if (status === 404 || status === 410) {
    return new AttachmentProcessingError('SOURCE_NOT_FOUND', false);
  }
  return new AttachmentProcessingError(`SOURCE_HTTP_${status}`, false);
}

function parseContentLength(response: Response, maxBytes: number): number | undefined {
  const value = response.headers.get('Content-Length');
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new AttachmentProcessingError('INVALID_METADATA', false);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AttachmentProcessingError('INVALID_METADATA', false);
  if (parsed > maxBytes) throw new AttachmentProcessingError('SOURCE_TOO_LARGE', false);
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
    throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
  }
  if (
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal' || hostname === 'metadata.internal' ||
    isDisallowedLiteralAddress(hostname)
  ) {
    throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
  }
  if (!config.allowedChatwootAttachmentHosts.has(url.host.toLowerCase())) {
    throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
  }
  if (initial && config.chatwootOrigin !== url.origin) {
    throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
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
    throw new AttachmentProcessingError('SOURCE_DOWNLOAD_FAILED', true);
  }
}

export async function downloadChatwootAttachment(
  env: Env,
  dataUrl: string,
  config: AttachmentConfig
): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; finish: () => void }> {
  if (
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) throw new AttachmentProcessingError('SOURCE_CONFIG_ERROR', false);
  let current: URL;
  try {
    current = new URL(dataUrl);
  } catch {
    throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
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
        throw new AttachmentProcessingError('SOURCE_REDIRECT_LIMIT', false);
      }
      const location = response.headers.get('Location');
      if (!location) throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
      try {
        current = new URL(location, current);
      } catch {
        throw new AttachmentProcessingError('SOURCE_URL_NOT_ALLOWED', false);
      }
      validateChatwootUrl(current, config, false);
      continue;
    }
    if (!response.ok) {
      fetched.finish();
      throw sourceHttpError(response.status);
    }
    if (!response.body) {
      fetched.finish();
      throw new AttachmentProcessingError('SOURCE_DOWNLOAD_FAILED', true);
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
  throw new AttachmentProcessingError('SOURCE_REDIRECT_LIMIT', false);
}

export async function downloadTelegramAttachment(
  env: Env,
  fileId: string,
  declaredSize: number | null,
  config: AttachmentConfig
): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; finish: () => void }> {
  if (env.runtimeConfigSnapshot?.errors.TELEGRAM_SUPPORT_PROFILE) {
    throw new AttachmentProcessingError('SOURCE_CONFIG_ERROR', false);
  }
  if (declaredSize !== null && declaredSize > config.maxBytes) {
    throw new AttachmentProcessingError('SOURCE_TOO_LARGE', false);
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
  let payload: any;
  try {
    if (!metadata.ok) throw sourceHttpError(metadata.status);
    payload = await metadata.json();
  } catch (error) {
    if (error instanceof AttachmentProcessingError) throw error;
    throw new AttachmentProcessingError('SOURCE_DOWNLOAD_FAILED', true);
  } finally {
    metadataRequest.finish();
  }
  if (payload?.ok !== true || typeof payload?.result?.file_path !== 'string') {
    const status = typeof payload?.error_code === 'number' ? payload.error_code : 400;
    throw sourceHttpError(status);
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
    throw sourceHttpError(response.status);
  }
  if (!response.body) {
    downloaded.finish();
    throw new AttachmentProcessingError('SOURCE_DOWNLOAD_FAILED', true);
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
        throw new AttachmentProcessingError('SOURCE_DOWNLOAD_FAILED', true);
      }
      const { done, value } = chunk;
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(buffer.byteLength - used, value.byteLength - offset);
        if (total + length > maxBytes) {
          await reader.cancel('SOURCE_TOO_LARGE');
          throw new AttachmentProcessingError('SOURCE_TOO_LARGE', false);
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
    if (total === 0) throw new AttachmentProcessingError('INVALID_METADATA', false);
    if (used > 0) parts.push(await upload.uploadPart(partNumber, buffer.slice(0, used)));
    await upload.complete(parts);
    return total;
  } catch (error) {
    if (upload) {
      try { await upload.abort(); } catch { /* cleanup retries through R2 lifecycle */ }
    }
    if (error instanceof AttachmentProcessingError) throw error;
    throw new AttachmentProcessingError('R2_STORE_FAILED', true);
  } finally {
    reader.releaseLock();
  }
}
