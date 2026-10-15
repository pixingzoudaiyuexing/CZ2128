import { AttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { AttachmentRow } from '../core/attachments';
import { ProviderDeliveryError, SafeError } from '../core/errors';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../core/provider-retry';
import { retryAfterHeader } from '../core/retry';
import { readTelegramRetryAfterMetadata, telegramRetryAfterValue } from '../adapters/telegram/error-metadata';
import { OutboundAttemptLifecycle } from '../core/outbound-operations';
import { TelegramMethod } from '../core/outbound-evidence';
import { buildChatwootApiUrl } from '../adapters/chatwoot/url';
import { createCrispMessage } from '../adapters/crisp/api';
import { sendTelegramMessage } from '../adapters/telegram/api';
import { CrispDisplayIdentity } from '../config/crisp-identities';
import { isSafeInlineImageMime, isValidAttachmentToken } from '../core/attachments';
import { attachmentByteSize } from '../core/attachments';
import { trustedPublicOrigin } from '../config/public-origin';
import { parseTelegramCustomerRequestOptions, telegramMirrorAttachmentCaption } from '../config/telegram-customer-ux';

const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_NATIVE_MAX_BYTES = 50 * 1024 * 1024;

async function attachmentMultipart(
  env: Env, row: AttachmentRow, fields: Record<string, string>, fileField: string,
  bytes: ArrayBuffer | undefined, source?: R2ObjectBody
): Promise<{ body: BodyInit; headers?: HeadersInit }> {
  if (bytes) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.append(fileField, new Blob([bytes], { type: row.mime_type }), row.safe_filename);
    return { body: form };
  }
  const object = source ?? await loadAttachmentStream(env.ATTACHMENTS_BUCKET, row);
  if (!object?.body) throw new SafeError('R2_OBJECT_MISSING');
  const expectedSize = attachmentByteSize(row);
  if (expectedSize !== null && object.size !== expectedSize) throw new SafeError('ATTACHMENT_SOURCE_INVALID');
  const boundary = 'cz2128-' + crypto.randomUUID();
  const encoder = new TextEncoder();
  const prefix = encoder.encode(Object.entries(fields).map(([key, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
  ).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${row.safe_filename.replace(/["\\\r\n]/g, '_')}"\r\nContent-Type: ${row.mime_type}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = object.body.getReader();
  let started = false;
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) { started = true; controller.enqueue(prefix); return; }
      try {
        const chunk = await reader.read();
        if (!chunk.done) { controller.enqueue(chunk.value); return; }
        if (!finished) { finished = true; controller.enqueue(suffix); }
        controller.close(); reader.releaseLock();
      } catch (error) { controller.error(error); try { reader.releaseLock(); } catch { /* released */ } }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { try { reader.releaseLock(); } catch { /* released */ } } }
  });
  const length = prefix.length + object.size + suffix.length;
  const fixed = new FixedLengthStream(length);
  // The runtime supplies the correct Content-Length only for known-length
  // streams. Failure propagates to the fetch reader, without an unhandled pump.
  void body.pipeTo(fixed.writable).catch(() => undefined);
  return { body: fixed.readable, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(length) } };
}

export async function loadAttachmentStream(bucket: R2Bucket, row: AttachmentRow): Promise<R2ObjectBody> {
  let object: R2ObjectBody | null;
  try { object = await bucket.get(row.storage_key); } catch { throw new SafeError('R2_READ_TRANSIENT'); }
  if (!object?.body) throw new SafeError('R2_OBJECT_MISSING');
  const size = attachmentByteSize(row);
  if (size !== null && object.size !== size) throw new SafeError('ATTACHMENT_SOURCE_INVALID');
  return object;
}

async function visibleFetch(
  provider: 'TELEGRAM' | 'CHATWOOT',
  url: string,
  form: BodyInit,
  timeoutMs: number,
  headers?: HeadersInit,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ response: Response; finish: () => void }> {
  if (lifecycle) {
    await lifecycle.requestStarted();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
  } catch {
    clearTimeout(timeout);
    if (form instanceof ReadableStream && !form.locked) void form.cancel().catch(() => undefined);
    throw visibleTransportDeliveryError(provider);
  }
  if (lifecycle) {
    await lifecycle.responseObserved(response.status);
  }
  return { response, finish: () => {
    clearTimeout(timeout);
    if (form instanceof ReadableStream && !form.locked) void form.cancel().catch(() => undefined);
  } };
}

export async function loadAttachmentBuffer(
  bucket: R2Bucket,
  row: AttachmentRow,
  maxBytes: number
): Promise<ArrayBuffer> {
  // Legacy callers may still need a small in-memory part. Large delivery must
  // use loadAttachmentStream or an authenticated download link instead.
  const bufferLimit = Math.min(maxBytes, TELEGRAM_PHOTO_MAX_BYTES);
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(row.storage_key);
  } catch {
    throw new SafeError('R2_READ_TRANSIENT');
  }
  if (!object) throw new SafeError('R2_OBJECT_MISSING');
  if (object.size > bufferLimit) throw new SafeError('R2_OBJECT_TOO_LARGE');
  let value: ArrayBuffer;
  try {
    value = await object.arrayBuffer();
  } catch {
    throw new SafeError('R2_READ_TRANSIENT');
  }
  if (value.byteLength > bufferLimit) throw new SafeError('R2_OBJECT_TOO_LARGE');
  return value;
}

function controlledAttachmentOrigin(
  publicOrigin: string | undefined,
  provider: 'CRISP' | 'TELEGRAM' = 'CRISP'
): string {
  if (!publicOrigin) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider, stage: 'PREPARE' });
  }
  try {
    const url = new URL(publicOrigin);
    if (
      url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== publicOrigin
    ) throw new Error('invalid origin');
    return url.origin;
  } catch {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider, stage: 'PREPARE' });
  }
}

function safeDisplayFilename(value: string): string {
  return value.replace(/[\r\n<>\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 180) || 'attachment.bin';
}

export async function prepareCrispAttachmentContent(
  env: Env,
  row: AttachmentRow,
  accessToken: string,
  publicOrigin: string | undefined,
  maxBytes: number
): Promise<string> {
  if (!isValidAttachmentToken(accessToken)) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'CRISP', stage: 'PREPARE' });
  }
  let metadata: R2Object | null;
  try {
    metadata = await env.ATTACHMENTS_BUCKET.head(row.storage_key);
  } catch {
    throw new SafeError('R2_READ_TRANSIENT');
  }
  if (!metadata) throw new SafeError('R2_OBJECT_MISSING');
  if (metadata.size > maxBytes) throw new SafeError('R2_OBJECT_TOO_LARGE');
  let origin: string;
  try { origin = trustedPublicOrigin(env); } catch { throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'CRISP' }); }
  const isImage = (row.retention_class === 'IMAGE' || row.attachment_type === 'photo') && isSafeInlineImageMime(row.mime_type);
  const mode = isImage ? 'inline' : 'download';
  const accessUrl = `${origin}/attachments/${accessToken}/${mode}`;
  return isImage
    ? `![Image](${accessUrl})`
    : `File: ${safeDisplayFilename(row.safe_filename)}\n${accessUrl}`;
}

export async function prepareTelegramUploadNotification(
  env: Env,
  row: AttachmentRow,
  accessToken: string,
  publicOrigin: string | undefined,
  maxBytes: number
): Promise<string> {
  if (!isValidAttachmentToken(accessToken)) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM', stage: 'PREPARE' });
  }
  let metadata: R2Object | null;
  try {
    metadata = await env.ATTACHMENTS_BUCKET.head(row.storage_key);
  } catch {
    throw new SafeError('R2_READ_TRANSIENT');
  }
  if (!metadata) throw new SafeError('R2_OBJECT_MISSING');
  if (metadata.size > maxBytes) throw new SafeError('R2_OBJECT_TOO_LARGE');
  let origin: string;
  try { origin = trustedPublicOrigin(env); } catch { throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' }); }
  const mode = row.retention_class === 'IMAGE' && isSafeInlineImageMime(row.mime_type) ? 'inline' : 'download';
  const accessUrl = `${origin}/attachments/${accessToken}/${mode}`;
  const provenance = telegramMirrorAttachmentCaption(parseTelegramCustomerRequestOptions(row.request_options_json));
  return [provenance, `${row.source_provider === 'upload' ? 'Customer uploaded file / 客户上传文件' : 'File download / 文件下载'}: ${safeDisplayFilename(row.safe_filename)}`, accessUrl].filter(Boolean).join('\n');
}

export async function deliverUploadNotificationToTelegram(
  env: Env,
  threadRef: string,
  content: string,
  lifecycle?: OutboundAttemptLifecycle,
  options?: { disableNotification: boolean }
): Promise<{ providerMessageRef: string }> {
  const response = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, content, lifecycle, options);
  return { providerMessageRef: response.messageId };
}

export async function deliverAttachmentToCrisp(
  env: Env,
  websiteRef: string,
  sessionRef: string,
  operationId: string,
  content: string,
  lifecycle?: OutboundAttemptLifecycle,
  identity?: CrispDisplayIdentity
): Promise<{ providerMessageRef: string }> {
  const result = await createCrispMessage(
    env, websiteRef, sessionRef, content, operationId, lifecycle,
    identity ? { identity, automated: false } : undefined
  );
  return { providerMessageRef: result.messageId };
}

export async function deliverAttachmentToChatwoot(
  env: Env,
  config: AttachmentConfig,
  row: AttachmentRow,
  accountRef: string,
  conversationRef: string,
  operationId: string,
  bytes: ArrayBuffer | undefined,
  lifecycle?: OutboundAttemptLifecycle,
  options?: { disableNotification?: boolean },
  source?: R2ObjectBody
): Promise<{ providerMessageRef: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'CHATWOOT' });
  const multipart = await attachmentMultipart(env, row, {
    message_type: 'outgoing', private: 'false', source_id: `cz2128:${operationId}`
  }, 'attachments[]', bytes, source);
  const request = await visibleFetch(
    'CHATWOOT',
    buildChatwootApiUrl(
      env.CHATWOOT_API_URL,
      `/api/v1/accounts/${encodeURIComponent(accountRef)}/conversations/${encodeURIComponent(conversationRef)}/messages`
    ),
    multipart.body,
    config.destinationTimeoutMs,
    { ...multipart.headers, 'api_access_token': env.CHATWOOT_API_TOKEN },
    lifecycle
  );
  const response = request.response;
  if (!response.ok) {
    request.finish();
    throw visibleHttpDeliveryError('CHATWOOT', response.status, {
      httpRetryAfter: retryAfterHeader(response)
    });
  }
  try {
    const payload = await response.json() as any;
    if (payload.id === undefined || payload.id === null) throw new Error('missing id');
    return { providerMessageRef: String(payload.id) };
  } catch {
    throw invalidVisibleSuccessError('CHATWOOT');
  } finally {
    request.finish();
  }
}

export function telegramAttachmentMethod(row: AttachmentRow): { method: TelegramMethod; field: string } {
  const size = attachmentByteSize(row);
  if (size !== null && size > TELEGRAM_NATIVE_MAX_BYTES) return { method: 'sendMessage', field: '' };
  if ((row.retention_class === 'IMAGE' || row.attachment_type === 'photo') && Number(size || 0) <= TELEGRAM_PHOTO_MAX_BYTES && row.mime_type.startsWith('image/')) {
    return { method: 'sendPhoto', field: 'photo' };
  }
  if (row.attachment_type === 'video') return { method: 'sendVideo', field: 'video' };
  if (row.attachment_type === 'audio') return { method: 'sendAudio', field: 'audio' };
  if (row.attachment_type === 'voice') return { method: 'sendVoice', field: 'voice' };
  return { method: 'sendDocument', field: 'document' };
}

export async function deliverAttachmentToTelegram(
  env: Env,
  config: AttachmentConfig,
  row: AttachmentRow,
  threadRef: string,
  bytes: ArrayBuffer | undefined,
  lifecycle?: OutboundAttemptLifecycle,
  options?: { disableNotification?: boolean; caption?: string },
  source?: R2ObjectBody
): Promise<{ providerMessageRef: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.TELEGRAM_SUPPORT_PROFILE
  ) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' });
  }
  const target = telegramAttachmentMethod(row);
  if (target.method === 'sendMessage') throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' });
  const fields: Record<string, string> = { chat_id: env.BOT_GROUP_ID, message_thread_id: threadRef };
  if (options?.disableNotification) fields.disable_notification = 'true';
  if (options?.caption) fields.caption = options.caption;
  const multipart = await attachmentMultipart(env, row, fields, target.field, bytes, source);
  const request = await visibleFetch(
    'TELEGRAM',
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${target.method}`,
    multipart.body,
    config.destinationTimeoutMs,
    multipart.headers,
    lifecycle
  );
  const response = request.response;
  if (!response.ok) {
    try {
      const telegramRetryAfter = response.status === 429
        ? await readTelegramRetryAfterMetadata(response)
        : undefined;
      throw visibleHttpDeliveryError('TELEGRAM', response.status, {
        telegramRetryAfter,
        httpRetryAfter: retryAfterHeader(response)
      });
    } finally {
      request.finish();
    }
  }
  try {
    const payload = await response.json() as any;
    if (payload?.ok !== true || payload?.result?.message_id === undefined) {
      const status = typeof payload?.error_code === 'number' ? payload.error_code : 200;
      if (status !== 200) {
        throw visibleHttpDeliveryError('TELEGRAM', status, {
          telegramRetryAfter: telegramRetryAfterValue(payload),
          httpRetryAfter: retryAfterHeader(response)
        });
      }
      throw new Error('missing id');
    }
    return { providerMessageRef: String(payload.result.message_id) };
  } catch (error) {
    if (error instanceof ProviderDeliveryError) throw error;
    throw invalidVisibleSuccessError('TELEGRAM');
  } finally {
    request.finish();
  }
}
