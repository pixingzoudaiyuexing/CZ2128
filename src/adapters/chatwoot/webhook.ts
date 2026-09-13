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

  // Expect signature format: sha256=<hex>
  if (!signatureHeader.startsWith('sha256=')) {
    return { valid: false };
  }
  const signatureHex = signatureHeader.replace('sha256=', '');

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) {
    return { valid: false };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { valid: false };
  }

  const rawBody = await request.clone().text();
  const signedPayload = `${timestamp}.${rawBody}`;

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
    enc.encode(signedPayload)
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const expectedHashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time string comparison for WebCrypto
  // By encoding to Uint8Array and using standard comparison logic if timingSafeEqual isn't natively exposed.
  // Actually crypto.subtle.verify is the correct constant time way:
  const sigBytes = new Uint8Array(Math.ceil(signatureHex.length / 2));
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(signatureHex.substring(i * 2, i * 2 + 2), 16);
  }

  try {
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      enc.encode(signedPayload)
    );

    if (!isValid) {
      return { valid: false };
    }
  } catch (e) {
    // Malformed hex or crypto error
    return { valid: false };
  }

  try {
    const payload = JSON.parse(rawBody);
    return { valid: true, payload, deliveryId };
  } catch (e) {
    return { valid: false };
  }
}
