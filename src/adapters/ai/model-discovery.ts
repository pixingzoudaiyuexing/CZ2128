import { canonicalizeAIBaseUrl } from '../../config/ai';

export const AI_MODEL_DISCOVERY_MAX_MODELS = 200;
export const AI_MODEL_DISCOVERY_MAX_ID_LENGTH = 256;
export const AI_MODEL_DISCOVERY_MAX_RESPONSE_BYTES = 1024 * 1024;

export type AIModelDiscoveryFailureReason =
  | 'CONFIG_INCOMPLETE'
  | 'CREDENTIAL_REJECTED'
  | 'UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'REDIRECT_REJECTED'
  | 'REJECTED'
  | 'INVALID_RESPONSE'
  | 'EMPTY';

export class AIModelDiscoveryError extends Error {
  constructor(
    readonly reason: AIModelDiscoveryFailureReason,
    readonly httpStatus?: number
  ) {
    super(reason);
    this.name = 'AIModelDiscoveryError';
  }
}

export interface AIModelDiscoveryResult {
  models: string[];
  truncated: boolean;
}

function validModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > AI_MODEL_DISCOVERY_MAX_ID_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
  ) return null;
  return normalized;
}

export function normalizeModelDirectory(payload: unknown): AIModelDiscoveryResult {
  const data = (payload as any)?.data;
  if (!Array.isArray(data)) throw new AIModelDiscoveryError('INVALID_RESPONSE');

  const models: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of data) {
    const id = validModelId(item?.id);
    if (!id || seen.has(id)) continue;
    if (models.length >= AI_MODEL_DISCOVERY_MAX_MODELS) {
      truncated = true;
      break;
    }
    seen.add(id);
    models.push(id);
  }
  models.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (models.length === 0) throw new AIModelDiscoveryError('EMPTY');
  return { models, truncated };
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('Content-Length') || '');
  if (Number.isFinite(declared) && declared > AI_MODEL_DISCOVERY_MAX_RESPONSE_BYTES) {
    throw new AIModelDiscoveryError('INVALID_RESPONSE');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > AI_MODEL_DISCOVERY_MAX_RESPONSE_BYTES) {
      throw new AIModelDiscoveryError('INVALID_RESPONSE');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AI_MODEL_DISCOVERY_MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new AIModelDiscoveryError('INVALID_RESPONSE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch { /* no-op */ }
  }
}

function statusError(status: number): AIModelDiscoveryError {
  if (status === 401 || status === 403) return new AIModelDiscoveryError('CREDENTIAL_REJECTED', status);
  if (status === 404 || status === 405) return new AIModelDiscoveryError('UNSUPPORTED', status);
  if (status === 429) return new AIModelDiscoveryError('RATE_LIMITED', status);
  if (status >= 500) return new AIModelDiscoveryError('UNAVAILABLE', status);
  if (status >= 300 && status < 400) return new AIModelDiscoveryError('REDIRECT_REJECTED', status);
  return new AIModelDiscoveryError('REJECTED', status);
}

export async function listAvailableModels(input: {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs?: number;
}): Promise<AIModelDiscoveryResult> {
  const baseUrl = canonicalizeAIBaseUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim() || '';
  if (!baseUrl || !apiKey) throw new AIModelDiscoveryError('CONFIG_INCOMPLETE');

  const timeoutMs = Math.min(Math.max(Math.floor(input.timeoutMs ?? 15000), 1000), 15000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      redirect: 'manual',
      signal: controller.signal
    });
    if (!response.ok) throw statusError(response.status);

    let payload: unknown;
    try {
      payload = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (error instanceof AIModelDiscoveryError) throw error;
      throw new AIModelDiscoveryError('INVALID_RESPONSE');
    }
    return normalizeModelDirectory(payload);
  } catch (error) {
    if (error instanceof AIModelDiscoveryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AIModelDiscoveryError('TIMEOUT');
    }
    throw new AIModelDiscoveryError('TRANSPORT');
  } finally {
    clearTimeout(timeout);
  }
}
