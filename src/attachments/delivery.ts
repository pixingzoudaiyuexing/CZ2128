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

const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

async function visibleFetch(
  provider: 'TELEGRAM' | 'CHATWOOT',
  url: string,
  form: FormData,
  timeoutMs: number,
  headers?: HeadersInit
): Promise<{ response: Response; finish: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
    return { response, finish: () => clearTimeout(timeout) };
  } catch {
    clearTimeout(timeout);
    throw visibleTransportDeliveryError(provider);
  }
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

export async function deliverAttachmentToChatwoot(
  env: Env,
  config: AttachmentConfig,
  row: AttachmentRow,
  accountRef: string,
  conversationRef: string,
  operationId: string,
  bytes: ArrayBuffer
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
  const baseUrl = env.CHATWOOT_API_URL.replace(/\/+$/, '');
  const request = await visibleFetch(
    'CHATWOOT',
    `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountRef)}/conversations/${encodeURIComponent(conversationRef)}/messages`,
    form,
    config.destinationTimeoutMs,
    { 'api_access_token': env.CHATWOOT_API_TOKEN }
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

function telegramMethod(row: AttachmentRow): { method: string; field: string } {
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
  bytes: ArrayBuffer
): Promise<{ providerMessageRef: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.TELEGRAM_SUPPORT_PROFILE
  ) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' });
  }
  const target = telegramMethod(row);
  const form = new FormData();
  form.set('chat_id', env.BOT_GROUP_ID);
  form.set('message_thread_id', threadRef);
  form.append(target.field, new Blob([bytes], { type: row.mime_type }), row.safe_filename);
  const request = await visibleFetch(
    'TELEGRAM',
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${target.method}`,
    form,
    config.destinationTimeoutMs
  );
  const response = request.response;
  if (!response.ok) {
    request.finish();
    const telegramRetryAfter = response.status === 429
      ? await readTelegramRetryAfterMetadata(response)
      : undefined;
    throw visibleHttpDeliveryError('TELEGRAM', response.status, {
      telegramRetryAfter,
      httpRetryAfter: retryAfterHeader(response)
    });
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
