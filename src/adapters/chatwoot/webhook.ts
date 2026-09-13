export async function verifyChatwootWebhook(
  request: Request,
  secret: string
): Promise<{ valid: boolean; payload?: any; deliveryId?: string }> {
  const signature = request.headers.get('X-Chatwoot-Signature');
  const timestampHeader = request.headers.get('X-Chatwoot-Timestamp');
  const deliveryId = request.headers.get('X-Chatwoot-Delivery') || undefined;

  if (!signature || !secret) {
    return { valid: false };
  }

  // Verify timestamp replay window (e.g., 5 minutes)
  if (timestampHeader) {
    const timestamp = parseInt(timestampHeader, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      return { valid: false };
    }
  }

  const rawBody = await request.clone().text();

  // Calculate HMAC SHA256
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify', 'sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(rawBody)
  );

  // Convert ArrayBuffer to hex string
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  if (hashHex !== signature) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(rawBody);
    return { valid: true, payload, deliveryId };
  } catch (e) {
    return { valid: false };
  }
}
