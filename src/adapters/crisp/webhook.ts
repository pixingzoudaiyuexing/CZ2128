const REPLAY_WINDOW_SECONDS = 300;

export interface CrispWebhookPayload {
  event: string;
  data: Record<string, any>;
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyCrispWebhook(
  request: Request,
  secret: string | undefined,
  expectedWebsiteId: string | undefined
): Promise<{ valid: boolean; payload?: CrispWebhookPayload; rawBody?: string }> {
  const timestampHeader = request.headers.get('X-Crisp-Request-Timestamp');
  const signatureHeader = request.headers.get('X-Crisp-Signature');
  if (!secret || !timestampHeader || !signatureHeader) return { valid: false };
  if (!/^\d+$/.test(timestampHeader)) return { valid: false };
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { valid: false };
  }
  const signature = hexBytes(signatureHeader);
  if (!signature) return { valid: false };

  try {
    const rawBody = await request.clone().text();
    const parsed = JSON.parse(rawBody) as CrispWebhookPayload;
    if (!parsed || typeof parsed.event !== 'string' || !parsed.data || typeof parsed.data !== 'object') {
      return { valid: false };
    }
    if (expectedWebsiteId && parsed.data.website_id !== expectedWebsiteId) return { valid: false };
    const trace = `[${timestamp};${JSON.stringify(parsed)}]`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, signature as unknown as BufferSource, new TextEncoder().encode(trace)
    );
    return valid ? { valid: true, payload: parsed, rawBody } : { valid: false };
  } catch {
    return { valid: false };
  }
}

export async function crispMessageEventId(
  payload: CrispWebhookPayload,
  rawBody: string
): Promise<string> {
  const data = payload.data;
  if (payload.event !== 'message:updated' && data.website_id && data.session_id && data.fingerprint !== undefined) {
    return `crisp:${data.website_id}:${data.session_id}:${payload.event}:${String(data.fingerprint)}`;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `crisp:${payload.event}:${hex}`;
}
