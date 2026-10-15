import { Env } from './env';

export const ATTACHMENT_HARD_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_HARD_MAX_COUNT = 10;
export const ATTACHMENT_TOKEN_BYTES = 32;
export const FILE_RETENTION_SECONDS = 72 * 60 * 60;
export const IMAGE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export interface AttachmentConfig {
  maxBytes: number;
  maxCountPerMessage: number;
  ttlSeconds: number;
  fileTtlSeconds: number;
  imageTtlSeconds: number;
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
  // Historical Admin overrides remain readable audit data, not product limits.
  const maxBytes = Number.MAX_SAFE_INTEGER;
  const maxCountPerMessage = Number.MAX_SAFE_INTEGER;
  const ttlSeconds = FILE_RETENTION_SECONDS;
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
    fileTtlSeconds: boundedInt(env.ATTACHMENT_FILE_TTL_SECONDS,FILE_RETENTION_SECONDS,60,FILE_RETENTION_SECONDS),
    imageTtlSeconds: boundedInt(env.ATTACHMENT_IMAGE_TTL_SECONDS,IMAGE_RETENTION_SECONDS,60,IMAGE_RETENTION_SECONDS),
    sourceTimeoutMs,
    destinationTimeoutMs,
    eventLeaseSeconds: Math.ceil(sourceTimeoutMs / 1000) + Math.ceil(destinationTimeoutMs / 1000) + 30,
    outboundLeaseSeconds: Math.ceil(destinationTimeoutMs / 1000) + 30,
    chatwootOrigin,
    allowedChatwootAttachmentHosts: allowedHosts
  };
}
