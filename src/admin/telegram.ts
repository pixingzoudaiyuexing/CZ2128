export class AdminProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AdminProviderError';
  }
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
    if (!response.ok) throw new AdminProviderError(`TELEGRAM_HTTP_${response.status}`);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new AdminProviderError('TELEGRAM_INVALID_RESPONSE');
    }
    if (payload?.ok !== true) {
      const status = typeof payload?.error_code === 'number' ? payload.error_code : 400;
      throw new AdminProviderError(`TELEGRAM_API_${status}`);
    }
    return payload.result;
  } catch (error) {
    if (error instanceof AdminProviderError) throw error;
    throw new AdminProviderError(error instanceof Error && error.name === 'AbortError'
      ? 'TELEGRAM_TIMEOUT'
      : 'TELEGRAM_TRANSPORT_ERROR');
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
    allowed_updates: ['message', 'edited_message']
  });
}

export async function deleteSupportWebhook(token: string): Promise<void> {
  await telegramCall(token, 'deleteWebhook', { drop_pending_updates: false });
}
