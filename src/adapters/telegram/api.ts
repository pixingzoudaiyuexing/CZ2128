import { Env } from '../../config/env';
import { ProviderDeliveryError } from '../../core/errors';
import { OutboundAttemptLifecycle } from '../../core/outbound-operations';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../../core/provider-retry';
import { retryAfterHeader } from '../../core/retry';
import { readTelegramRetryAfterMetadata, telegramRetryAfterValue } from './error-metadata';

async function callTelegram(env: Env, method: string, body: Record<string, unknown>, lifecycle?: OutboundAttemptLifecycle): Promise<any> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.TELEGRAM_SUPPORT_PROFILE
  ) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' });
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const payload = JSON.stringify(body);
  
  if (lifecycle) {
    await lifecycle.requestStarted();
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch {
    throw visibleTransportDeliveryError('TELEGRAM');
  }

  if (lifecycle) {
    await lifecycle.responseObserved(response.status);
  }

  if (!response.ok) {
    const telegramRetryAfter = response.status === 429
      ? await readTelegramRetryAfterMetadata(response)
      : undefined;
    throw visibleHttpDeliveryError('TELEGRAM', response.status, {
      telegramRetryAfter,
      httpRetryAfter: retryAfterHeader(response)
    });
  }

  try {
    const data = await response.json() as any;
    if (data?.ok !== true) {
      const status = typeof data?.error_code === 'number' ? data.error_code : response.status;
      throw visibleHttpDeliveryError('TELEGRAM', status, {
        telegramRetryAfter: telegramRetryAfterValue(data),
        httpRetryAfter: retryAfterHeader(response)
      });
    }
    return data;
  } catch (error) {
    if (error instanceof ProviderDeliveryError) throw error;
    throw invalidVisibleSuccessError('TELEGRAM');
  }
}

export async function sendTelegramMessage(
  env: Env,
  chatId: string,
  messageThreadId: string | null,
  text: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (messageThreadId) {
    body.message_thread_id = messageThreadId;
  }

  const data = await callTelegram(env, 'sendMessage', body, lifecycle);
  if (data.result?.message_id === undefined || data.result?.message_id === null) {
    throw invalidVisibleSuccessError('TELEGRAM');
  }
  return { messageId: String(data.result.message_id) };
}

export async function createTelegramTopic(
  env: Env,
  chatId: string,
  name: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ messageThreadId: string }> {
  const body = {
    chat_id: chatId,
    name,
  };

  const data = await callTelegram(env, 'createForumTopic', body, lifecycle);
  if (data.result?.message_thread_id === undefined || data.result?.message_thread_id === null) {
    throw invalidVisibleSuccessError('TELEGRAM');
  }
  return { messageThreadId: String(data.result.message_thread_id) };
}

export async function closeTelegramTopic(
  env: Env,
  chatId: string,
  messageThreadId: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<void> {
  const body = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  };

  await callTelegram(env, 'closeForumTopic', body, lifecycle);
}

export async function reopenTelegramTopic(
  env: Env,
  chatId: string,
  messageThreadId: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<void> {
  const body = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  };

  await callTelegram(env, 'reopenForumTopic', body, lifecycle);
}
