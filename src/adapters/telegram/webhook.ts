export async function verifyTelegramWebhook(
  request: Request,
  pathSegment: string,
  botToken: string,
  secretToken: string
): Promise<{ valid: boolean; payload?: any; updateId?: string }> {
  // Use botToken as the path segment for secrecy
  if (pathSegment !== botToken) {
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

  return { valid: true, payload, updateId: payload.update_id?.toString() };
}
