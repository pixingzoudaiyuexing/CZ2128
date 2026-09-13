export async function verifyTelegramWebhook(
  request: Request,
  pathSegment: string,
  secretPath: string,
  secretToken: string,
  botGroupId: string
): Promise<{ valid: boolean; payload?: any; updateId?: string }> {
  if (!secretPath || !secretToken || !botGroupId) {
    return { valid: false };
  }

  if (pathSegment !== secretPath) {
    return { valid: false };
  }

  const tokenHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (tokenHeader !== secretToken) {
    return { valid: false };
  }

  let payload: any;
  try {
    payload = await request.clone().json();
  } catch (e) {
    return { valid: false };
  }

  const message = payload.message || payload.edited_message;
  const chat = message?.chat;
  if (message && (!chat || String(chat.id) !== botGroupId)) {
    return { valid: false };
  }

  const updateId = Number.isSafeInteger(payload.update_id) && payload.update_id >= 0
    ? String(payload.update_id)
    : undefined;

  return { valid: true, payload, updateId };
}
