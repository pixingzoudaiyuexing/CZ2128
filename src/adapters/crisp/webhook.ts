const REPLAY_WINDOW_SECONDS = 300;
const MILLISECOND_EPOCH_THRESHOLD = 100_000_000_000;

export interface CrispWebhookPayload {
  event: string;
  data: Record<string, any>;
  timestamp?: unknown;
}

export interface CrispPickerSelection {
  websiteRef: string;
  sessionRef: string;
  pickerId: string;
  pickerMessageRef: string;
  value: string;
  label: string;
}

export interface CrispLifecycleSignal {
  websiteRef: string;
  sessionRef: string;
  state: 'pending' | 'unresolved' | 'resolved';
  providerTimestamp: number;
}

export type CrispWebhookFailure =
  | 'CRISP_VERIFY_CONFIG_MISSING'
  | 'CRISP_VERIFY_HEADERS_MISSING'
  | 'CRISP_VERIFY_TIMESTAMP_INVALID'
  | 'CRISP_VERIFY_TIMESTAMP_STALE'
  | 'CRISP_VERIFY_SIGNATURE_FORMAT_INVALID'
  | 'CRISP_VERIFY_SIGNATURE_MISMATCH'
  | 'CRISP_VERIFY_PAYLOAD_INVALID'
  | 'CRISP_VERIFY_WEBSITE_MISMATCH';

export type CrispTimestampFormat = 'seconds' | 'milliseconds';

export interface CrispWebhookVerification {
  valid: boolean;
  payload?: CrispWebhookPayload;
  rawBody?: string;
  failure?: CrispWebhookFailure;
  timestampFormat?: CrispTimestampFormat;
}

function boundedIdentity(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function readCrispPickerSelection(payload: CrispWebhookPayload): CrispPickerSelection | null {
  if (payload.event !== 'message:updated') return null;
  const data = payload.data;
  if (
    !boundedIdentity(data.website_id) || !boundedIdentity(data.session_id) ||
    !boundedIdentity(data.content?.id, 128) ||
    (typeof data.fingerprint !== 'string' && typeof data.fingerprint !== 'number')
  ) return null;
  const pickerMessageRef = String(data.fingerprint);
  if (!boundedIdentity(pickerMessageRef)) return null;
  const selected = Array.isArray(data.content?.choices)
    ? data.content.choices.filter((choice: any) => choice?.selected === true)
    : [];
  if (selected.length !== 1) return null;
  const choice = selected[0];
  if (!boundedIdentity(choice.value, 128) || !boundedIdentity(choice.label, 128)) return null;
  return {
    websiteRef: data.website_id,
    sessionRef: data.session_id,
    pickerId: data.content.id,
    pickerMessageRef,
    value: choice.value,
    label: choice.label
  };
}

export function readCrispLifecycleSignal(payload: CrispWebhookPayload): CrispLifecycleSignal | null {
  if (payload.event !== 'session:set_state') return null;
  const data = payload.data;
  if (!boundedIdentity(data.website_id) || !boundedIdentity(data.session_id)) return null;
  if (data.state !== 'pending' && data.state !== 'unresolved' && data.state !== 'resolved') return null;
  if (!Number.isSafeInteger(payload.timestamp) || Number(payload.timestamp) <= 0) return null;
  return {
    websiteRef: data.website_id,
    sessionRef: data.session_id,
    state: data.state,
    providerTimestamp: Number(payload.timestamp)
  };
}

export function crispLifecycleEventId(signal: CrispLifecycleSignal): string {
  return `crisp:${signal.websiteRef}:${signal.sessionRef}:session:set_state:${signal.providerTimestamp}:${signal.state}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseFreshTimestamp(timestampHeader: string):
  | { valid: true; format: CrispTimestampFormat }
  | { valid: false; failure: 'CRISP_VERIFY_TIMESTAMP_INVALID'; format?: undefined }
  | { valid: false; failure: 'CRISP_VERIFY_TIMESTAMP_STALE'; format: CrispTimestampFormat } {
  if (!/^\d+$/.test(timestampHeader)) return { valid: false, failure: 'CRISP_VERIFY_TIMESTAMP_INVALID' };
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { valid: false, failure: 'CRISP_VERIFY_TIMESTAMP_INVALID' };
  }

  const format: CrispTimestampFormat = timestamp > MILLISECOND_EPOCH_THRESHOLD ? 'milliseconds' : 'seconds';
  const timestampSeconds = format === 'milliseconds' ? timestamp / 1000 : timestamp;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > REPLAY_WINDOW_SECONDS) {
    return { valid: false, failure: 'CRISP_VERIFY_TIMESTAMP_STALE', format };
  }
  return { valid: true, format };
}

export async function verifyCrispWebhook(
  request: Request,
  secret: string | undefined,
  expectedWebsiteId: string | undefined
): Promise<CrispWebhookVerification> {
  if (!secret || !expectedWebsiteId) return { valid: false, failure: 'CRISP_VERIFY_CONFIG_MISSING' };

  const timestampHeader = request.headers.get('X-Crisp-Request-Timestamp');
  const signatureHeader = request.headers.get('X-Crisp-Signature');
  if (!timestampHeader || !signatureHeader) {
    return { valid: false, failure: 'CRISP_VERIFY_HEADERS_MISSING' };
  }

  const freshness = parseFreshTimestamp(timestampHeader);
  if (!freshness.valid) {
    return { valid: false, failure: freshness.failure, timestampFormat: freshness.format };
  }

  const signature = hexBytes(signatureHeader);
  if (!signature) {
    return {
      valid: false,
      failure: 'CRISP_VERIFY_SIGNATURE_FORMAT_INVALID',
      timestampFormat: freshness.format
    };
  }

  try {
    const rawBody = await request.clone().text();
    const trace = `[${timestampHeader};${rawBody}]`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, signature as unknown as BufferSource, new TextEncoder().encode(trace)
    );
    if (!valid) {
      return {
        valid: false,
        failure: 'CRISP_VERIFY_SIGNATURE_MISMATCH',
        timestampFormat: freshness.format
      };
    }

    const parsed = JSON.parse(rawBody) as CrispWebhookPayload;
    if (!parsed || typeof parsed.event !== 'string' || !parsed.data || typeof parsed.data !== 'object') {
      return {
        valid: false,
        failure: 'CRISP_VERIFY_PAYLOAD_INVALID',
        timestampFormat: freshness.format
      };
    }
    if (expectedWebsiteId && parsed.data.website_id !== expectedWebsiteId) {
      return {
        valid: false,
        failure: 'CRISP_VERIFY_WEBSITE_MISMATCH',
        timestampFormat: freshness.format
      };
    }
    return { valid: true, payload: parsed, rawBody, timestampFormat: freshness.format };
  } catch {
    return {
      valid: false,
      failure: 'CRISP_VERIFY_PAYLOAD_INVALID',
      timestampFormat: freshness.format
    };
  }
}

export async function crispMessageEventId(
  payload: CrispWebhookPayload,
  rawBody: string
): Promise<string> {
  const data = payload.data;
  const selection = readCrispPickerSelection(payload);
  if (selection) {
    return `crisp:selection:${await sha256Hex(JSON.stringify([
      selection.websiteRef,
      selection.sessionRef,
      selection.pickerMessageRef,
      selection.pickerId,
      selection.value
    ]))}`;
  }
  if (payload.event !== 'message:updated' && data.website_id && data.session_id && data.fingerprint !== undefined) {
    return `crisp:${data.website_id}:${data.session_id}:${payload.event}:${String(data.fingerprint)}`;
  }
  return `crisp:${payload.event}:${await sha256Hex(rawBody)}`;
}
