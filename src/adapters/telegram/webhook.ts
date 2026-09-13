export async function verifyTelegramWebhook(
  request: Request,
  secretToken: string,
  secretPath: string,
  botGroupId: string
): Promise<{ valid: boolean; payload?: any; updateId?: string }> {
  const url = new URL(request.url);
  
  if (url.pathname !== `/webhooks/telegram/${secretPath}`) {
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

  // Validate group/chat ID if applicable
  const chat = payload.message?.chat || payload.edited_message?.chat;
  if (chat && chat.id.toString() !== botGroupId) {
    // Optionally reject or ignore updates from other groups
    return { valid: false };
  }

  // Reject bot-originated updates
  const isBot = payload.message?.from?.is_bot || false;
  if (isBot) {
    // Return valid but we might want to drop it in processing,
    // let's say it's valid but payload will be handled in normalize
    return { valid: true, payload, updateId: payload.update_id?.toString() };
  }

  return { valid: true, payload, updateId: payload.update_id?.toString() };
}
