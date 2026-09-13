import { Env } from './env';

export const ATTACHMENT_HARD_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_HARD_MAX_COUNT = 10;
export const ATTACHMENT_TOKEN_BYTES = 32;

export interface AttachmentConfig {
  maxBytes: number;
  maxCountPerMessage: number;
  ttlSeconds: number;
  sourceTimeoutMs: number;
  destinationTimeoutMs: number;
  eventLeaseSeconds: number;
  outboundLeaseSeconds: number;
  chatwootOrigin: string | null;
  allowedChatwootAttachmentHosts: ReadonlySet<string>;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function configuredChatwootOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getAttachmentConfig(env: Env): AttachmentConfig {
  const maxBytes = boundedInt(env.ATTACHMENT_MAX_BYTES, ATTACHMENT_HARD_MAX_BYTES, 1, ATTACHMENT_HARD_MAX_BYTES);
  const maxCountPerMessage = boundedInt(env.ATTACHMENT_MAX_COUNT_PER_MESSAGE, ATTACHMENT_HARD_MAX_COUNT, 1, ATTACHMENT_HARD_MAX_COUNT);
  const ttlSeconds = boundedInt(env.ATTACHMENT_TTL_SECONDS, 86400, 60, 86400);
  const sourceTimeoutMs = boundedInt(env.ATTACHMENT_SOURCE_TIMEOUT_MS, 30000, 1000, 120000);
  const destinationTimeoutMs = boundedInt(env.ATTACHMENT_DESTINATION_TIMEOUT_MS, 30000, 1000, 120000);
  const chatwootOrigin = configuredChatwootOrigin(env.CHATWOOT_API_URL);
  const allowedHosts = new Set<string>();
  if (chatwootOrigin) allowedHosts.add(new URL(chatwootOrigin).host.toLowerCase());
  for (const entry of (env.CHATWOOT_ATTACHMENT_ALLOWED_HOSTS || '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (host && /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) allowedHosts.add(host);
  }

  return {
    maxBytes,
    maxCountPerMessage,
    ttlSeconds,
    sourceTimeoutMs,
    destinationTimeoutMs,
    eventLeaseSeconds: Math.ceil(sourceTimeoutMs / 1000) + Math.ceil(destinationTimeoutMs / 1000) + 30,
    outboundLeaseSeconds: Math.ceil(destinationTimeoutMs / 1000) + 30,
    chatwootOrigin,
    allowedChatwootAttachmentHosts: allowedHosts
  };
}
