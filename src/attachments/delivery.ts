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

const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

async function visibleFetch(
  provider: 'TELEGRAM' | 'CHATWOOT',
  url: string,
  form: FormData,
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
    throw visibleTransportDeliveryError(provider);
  }
  if (lifecycle) {
    await lifecycle.responseObserved(response.status);
  }
  return { response, finish: () => clearTimeout(timeout) };
}

export async function loadAttachmentBuffer(
  bucket: R2Bucket,
  row: AttachmentRow,
  maxBytes: number
): Promise<ArrayBuffer> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(row.storage_key);
  } catch {
    throw new SafeError('R2_READ_TRANSIENT');
  }
  if (!object) throw new SafeError('R2_OBJECT_MISSING');
  if (object.size > maxBytes) throw new SafeError('R2_OBJECT_TOO_LARGE');
  let value: ArrayBuffer;
  try {
    value = await object.arrayBuffer();
  } catch {
    throw new SafeError('R2_READ_TRANSIENT');
  }
  if (value.byteLength > maxBytes) throw new SafeError('R2_OBJECT_TOO_LARGE');
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
  const origin = controlledAttachmentOrigin(publicOrigin);
  const isImage = row.attachment_type === 'photo' && isSafeInlineImageMime(row.mime_type);
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
  if (row.source_provider !== 'upload' || !isValidAttachmentToken(accessToken)) {
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
  const origin = controlledAttachmentOrigin(publicOrigin, 'TELEGRAM');
  const accessUrl = `${origin}/attachments/${accessToken}/download`;
  return `Customer uploaded file / 客户上传文件: ${safeDisplayFilename(row.safe_filename)}\n${accessUrl}`;
}

export async function deliverUploadNotificationToTelegram(
  env: Env,
  threadRef: string,
  content: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ providerMessageRef: string }> {
  const response = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, content, lifecycle);
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
  bytes: ArrayBuffer,
  lifecycle?: OutboundAttemptLifecycle,
  options?: { disableNotification?: boolean }
): Promise<{ providerMessageRef: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'CHATWOOT' });
  const form = new FormData();
  form.set('message_type', 'outgoing');
  form.set('private', 'false');
  form.set('source_id', `cz2128:${operationId}`);
  form.append('attachments[]', new Blob([bytes], { type: row.mime_type }), row.safe_filename);
  const request = await visibleFetch(
    'CHATWOOT',
    buildChatwootApiUrl(
      env.CHATWOOT_API_URL,
      `/api/v1/accounts/${encodeURIComponent(accountRef)}/conversations/${encodeURIComponent(conversationRef)}/messages`
    ),
    form,
    config.destinationTimeoutMs,
    { 'api_access_token': env.CHATWOOT_API_TOKEN },
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
  if (row.attachment_type === 'photo' && Number(row.size_bytes || 0) <= TELEGRAM_PHOTO_MAX_BYTES && row.mime_type.startsWith('image/')) {
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
  bytes: ArrayBuffer,
  lifecycle?: OutboundAttemptLifecycle,
  options?: { disableNotification?: boolean }
): Promise<{ providerMessageRef: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.TELEGRAM_SUPPORT_PROFILE
  ) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' });
  }
  const target = telegramAttachmentMethod(row);
  const form = new FormData();
  form.set('chat_id', env.BOT_GROUP_ID);
  form.set('message_thread_id', threadRef);
  if (options?.disableNotification) form.set('disable_notification', 'true');
  form.append(target.field, new Blob([bytes], { type: row.mime_type }), row.safe_filename);
  const request = await visibleFetch(
    'TELEGRAM',
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${target.method}`,
    form,
    config.destinationTimeoutMs,
    undefined,
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
