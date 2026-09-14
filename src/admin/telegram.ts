import { SafeErrorCode } from '../core/error-taxonomy';
import { SafeError, SafeErrorOptions } from '../core/errors';
import { resolveRetryAfterSeconds, retryAfterHeader } from '../core/retry';
import { readTelegramRetryAfterMetadata, telegramRetryAfterValue } from '../adapters/telegram/error-metadata';

export class AdminProviderError extends SafeError {
  constructor(code: SafeErrorCode, options: SafeErrorOptions = {}) {
    super(code, { provider: 'TELEGRAM', ...options });
    this.name = 'AdminProviderError';
  }
}

function adminTelegramHttpError(
  status: number,
  options: { telegramRetryAfter?: unknown; httpRetryAfter?: string | null } = {}
): AdminProviderError {
  if (status === 429) {
    return new AdminProviderError('ADMIN_PROVIDER_RATE_LIMITED', {
      httpStatus: status,
      retryAfterSeconds: resolveRetryAfterSeconds({
        telegramRetryAfter: options.telegramRetryAfter,
        httpRetryAfter: options.httpRetryAfter
      })
    });
  }
  if (status === 408) return new AdminProviderError('ADMIN_PROVIDER_TIMEOUT', { httpStatus: status });
  if (status >= 500) return new AdminProviderError('ADMIN_PROVIDER_TRANSIENT', { httpStatus: status });
  return new AdminProviderError('ADMIN_PROVIDER_REJECTED', { httpStatus: status });
}

async function telegramCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 15000
): Promise<any> {
  if (!token || token.length > 256 || /\s/.test(token)) throw new AdminProviderError('TELEGRAM_TOKEN_INVALID');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const telegramRetryAfter = response.status === 429
        ? await readTelegramRetryAfterMetadata(response)
        : undefined;
      throw adminTelegramHttpError(response.status, {
        telegramRetryAfter,
        httpRetryAfter: retryAfterHeader(response)
      });
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new AdminProviderError('ADMIN_PROVIDER_INVALID_RESPONSE', { stage: 'PARSE_RESPONSE' });
    }
    if (payload?.ok !== true) {
      const status = typeof payload?.error_code === 'number' ? payload.error_code : 400;
      throw adminTelegramHttpError(status, {
        telegramRetryAfter: telegramRetryAfterValue(payload),
        httpRetryAfter: retryAfterHeader(response)
      });
    }
    return payload.result;
  } catch (error) {
    if (error instanceof AdminProviderError) throw error;
    throw new AdminProviderError(error instanceof Error && error.name === 'AbortError'
      ? 'ADMIN_PROVIDER_TIMEOUT'
      : 'ADMIN_PROVIDER_TRANSPORT_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendAdminMessage(
  token: string,
  chatId: string,
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>
): Promise<void> {
  await telegramCall(token, 'sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4096),
    ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
  });
}

export async function answerAdminCallback(token: string, callbackQueryId: string): Promise<void> {
  await telegramCall(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId });
}

export async function deleteAdminInput(token: string, chatId: string, messageId: number): Promise<boolean> {
  try {
    await telegramCall(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    return true;
  } catch {
    return false;
  }
}

export async function validateSupportBot(
  token: string,
  groupId?: string
): Promise<{ botId: string; username?: string }> {
  const bot = await telegramCall(token, 'getMe', {});
  if (bot?.is_bot !== true || bot?.id === undefined) throw new AdminProviderError('TELEGRAM_GETME_INVALID');
  const botId = String(bot.id);
  if (groupId) {
    const chat = await telegramCall(token, 'getChat', { chat_id: groupId });
    if (chat?.type !== 'supergroup' || chat?.is_forum !== true) {
      throw new AdminProviderError('TELEGRAM_GROUP_NOT_FORUM');
    }
    const member = await telegramCall(token, 'getChatMember', { chat_id: groupId, user_id: botId });
    const canManage = member?.status === 'creator' ||
      (member?.status === 'administrator' && member?.can_manage_topics === true);
    if (!canManage) throw new AdminProviderError('TELEGRAM_BOT_PERMISSION_MISSING');
  }
  return { botId, username: typeof bot.username === 'string' ? bot.username : undefined };
}

export async function setSupportWebhook(
  token: string,
  url: string,
  secretToken: string
): Promise<void> {
  await telegramCall(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true
  });
}

export async function deleteSupportWebhook(token: string): Promise<void> {
  await telegramCall(token, 'deleteWebhook', { drop_pending_updates: false });
}
