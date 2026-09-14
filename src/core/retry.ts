export const RETRY_DELAY_MIN_SECONDS = 1;
export const RETRY_DELAY_MAX_SECONDS = 900;
export const RETRY_DELAY_FALLBACK_SECONDS = 5;

export interface RetryAfterInput {
  telegramRetryAfter?: unknown;
  httpRetryAfter?: string | null;
  nowMs?: number;
  random?: () => number;
  jitter?: boolean;
}

function boundedSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < RETRY_DELAY_MIN_SECONDS) return null;
  return Math.min(value, RETRY_DELAY_MAX_SECONDS);
}

function parseHttpRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    return boundedSeconds(parsed);
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || timestamp <= nowMs) return null;
  return boundedSeconds(Math.ceil((timestamp - nowMs) / 1000));
}

function addBoundedJitter(seconds: number, random: () => number): number {
  const capacity = RETRY_DELAY_MAX_SECONDS - seconds;
  if (capacity <= 0) return seconds;
  const maximumAdded = Math.min(Math.floor(seconds * 0.1), 30, capacity);
  if (maximumAdded <= 0) return seconds;
  const sample = Math.min(Math.max(random(), 0), 1);
  return seconds + Math.floor(sample * maximumAdded);
}

export function resolveRetryAfterSeconds(input: RetryAfterInput = {}): number {
  const telegram = boundedSeconds(input.telegramRetryAfter);
  const http = parseHttpRetryAfter(input.httpRetryAfter, input.nowMs ?? Date.now());
  const base = telegram ?? http ?? RETRY_DELAY_FALLBACK_SECONDS;
  return input.jitter === false ? base : addBoundedJitter(base, input.random ?? Math.random);
}

export function boundedQueueRetryDelay(seconds: unknown, fallback = RETRY_DELAY_FALLBACK_SECONDS): number {
  const bounded = boundedSeconds(seconds);
  if (bounded !== null) return bounded;
  return boundedSeconds(fallback) ?? RETRY_DELAY_FALLBACK_SECONDS;
}

export function retryAfterHeader(response: Pick<Response, 'headers'> | { headers?: unknown }): string | null {
  const headers = response.headers as { get?: (name: string) => string | null } | undefined;
  return typeof headers?.get === 'function' ? headers.get('Retry-After') : null;
}
