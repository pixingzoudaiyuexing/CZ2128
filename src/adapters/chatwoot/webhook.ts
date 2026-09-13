export async function verifyChatwootWebhook(
  request: Request,
  secret: string
): Promise<{ valid: boolean; payload?: any; deliveryId?: string }> {
  const signatureHeader = request.headers.get('X-Chatwoot-Signature');
  const timestampHeader = request.headers.get('X-Chatwoot-Timestamp');
  const deliveryId = request.headers.get('X-Chatwoot-Delivery') || undefined;

  if (!signatureHeader || !timestampHeader || !secret) {
    return { valid: false };
  }

  if (!signatureHeader.startsWith('sha256=')) {
    return { valid: false };
  }
  const signatureHex = signatureHeader.replace('sha256=', '');
  
  if (!/^[0-9a-fA-F]+$/.test(signatureHex)) {
    return { valid: false };
  }
  
  if (signatureHex.length % 2 !== 0) {
    return { valid: false };
  }

  if (!/^\d+$/.test(timestampHeader)) {
    return { valid: false };
  }

  const timestamp = parseInt(timestampHeader, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { valid: false };
  }

  const rawBody = await request.clone().text();
  const signedPayload = `${timestamp}.${rawBody}`;

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = new Uint8Array(Math.ceil(signatureHex.length / 2));
    for (let i = 0; i < sigBytes.length; i++) {
      sigBytes[i] = parseInt(signatureHex.substring(i * 2, i * 2 + 2), 16);
    }

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      enc.encode(signedPayload)
    );

    if (!isValid) {
      return { valid: false };
    }

    const payload = JSON.parse(rawBody);
    return { valid: true, payload, deliveryId };
  } catch (e) {
    return { valid: false };
  }
}
