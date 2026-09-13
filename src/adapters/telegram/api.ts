import { Env } from '../../index';

export async function sendTelegramMessage(
  env: Env,
  chatId: string,
  messageThreadId: string | null,
  text: string
): Promise<{ messageId: string }> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body: any = {
    chat_id: chatId,
    text,
  };
  if (messageThreadId) {
    body.message_thread_id = messageThreadId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${await response.text()}`);
  }

  const data = await response.json() as any;
  return { messageId: String(data.result.message_id) };
}

export async function createTelegramTopic(
  env: Env,
  chatId: string,
  name: string
): Promise<{ messageThreadId: string }> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/createForumTopic`;
  const body = {
    chat_id: chatId,
    name,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telegram createForumTopic failed: ${await response.text()}`);
  }

  const data = await response.json() as any;
  return { messageThreadId: String(data.result.message_thread_id) };
}

export async function closeTelegramTopic(
  env: Env,
  chatId: string,
  messageThreadId: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/closeForumTopic`;
  const body = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telegram closeForumTopic failed: ${await response.text()}`);
  }
}

export async function reopenTelegramTopic(
  env: Env,
  chatId: string,
  messageThreadId: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/reopenForumTopic`;
  const body = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telegram reopenForumTopic failed: ${await response.text()}`);
  }
}
