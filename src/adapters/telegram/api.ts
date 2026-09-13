import { Env } from '../../config/env';
import { ProviderDeliveryError } from '../../core/errors';

async function callTelegram(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderDeliveryError('AMBIGUOUS', 'TELEGRAM_TRANSPORT_ERROR');
  }

  if (!response.ok) {
    const outcome = response.status === 429
      ? 'RETRYABLE'
      : response.status === 408 || response.status >= 500
        ? 'AMBIGUOUS'
        : 'FINAL';
    throw new ProviderDeliveryError(outcome, `TELEGRAM_HTTP_${response.status}`);
  }

  try {
    const data = await response.json() as any;
    if (data?.ok !== true) {
      const status = typeof data?.error_code === 'number' ? data.error_code : response.status;
      const outcome = status === 429
        ? 'RETRYABLE'
        : status === 408 || status >= 500
          ? 'AMBIGUOUS'
          : 'FINAL';
      throw new ProviderDeliveryError(outcome, `TELEGRAM_API_${status}`);
    }
    return data;
  } catch (error) {
    if (error instanceof ProviderDeliveryError) throw error;
    throw new ProviderDeliveryError('AMBIGUOUS', 'TELEGRAM_INVALID_SUCCESS_RESPONSE');
  }
}

export async function sendTelegramMessage(
  env: Env,
  chatId: string,
  messageThreadId: string | null,
  text: string
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (messageThreadId) {
    body.message_thread_id = messageThreadId;
  }

  const data = await callTelegram(env, 'sendMessage', body);
  if (data.result?.message_id === undefined || data.result?.message_id === null) {
    throw new ProviderDeliveryError('AMBIGUOUS', 'TELEGRAM_MISSING_MESSAGE_ID');
  }
  return { messageId: String(data.result.message_id) };
}

export async function createTelegramTopic(
  env: Env,
  chatId: string,
  name: string
): Promise<{ messageThreadId: string }> {
  const body = {
    chat_id: chatId,
    name,
  };

  const data = await callTelegram(env, 'createForumTopic', body);
  if (data.result?.message_thread_id === undefined || data.result?.message_thread_id === null) {
    throw new ProviderDeliveryError('AMBIGUOUS', 'TELEGRAM_MISSING_TOPIC_ID');
  }
  return { messageThreadId: String(data.result.message_thread_id) };
}

export async function closeTelegramTopic(
  env: Env,
  chatId: string,
  messageThreadId: string
): Promise<void> {
  const body = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  };

  await callTelegram(env, 'closeForumTopic', body);
}

export async function reopenTelegramTopic(
  env: Env,
  chatId: string,
  messageThreadId: string
): Promise<void> {
  const body = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  };

  await callTelegram(env, 'reopenForumTopic', body);
}
