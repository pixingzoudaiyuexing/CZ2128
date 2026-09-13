export async function verifyTelegramWebhook(
  request: Request,
  pathSegment: string,
  secretPath: string,
  secretToken: string,
  botGroupId: string
): Promise<{ valid: boolean; payload?: any; updateId?: string }> {
  
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

  const chat = payload.message?.chat || payload.edited_message?.chat;
  if (chat && chat.id.toString() !== botGroupId) {
    return { valid: false };
  }

  return { valid: true, payload, updateId: payload.update_id?.toString() };
}
