import { describe, expect, it, vi } from 'vitest';
import {
  AMBIGUITIES,
  ERROR_CLASSES,
  ERROR_DOMAINS,
  ERROR_PROVIDERS,
  ERROR_STAGES,
  RETRYABILITIES,
  SAFE_ERROR_REGISTRY,
  VISIBILITIES,
  getSafeErrorDefinition,
  isSafeErrorCode
} from '../src/core/error-taxonomy';
import {
  ProviderDeliveryError,
  RetryableProcessingError,
  retryExhaustionSemantic,
  safeErrorCode,
  safeErrorMetadata
} from '../src/core/errors';
import {
  RETRY_DELAY_FALLBACK_SECONDS,
  RETRY_DELAY_MAX_SECONDS,
  RETRY_DELAY_MIN_SECONDS,
  boundedQueueRetryDelay,
  resolveRetryAfterSeconds
} from '../src/core/retry';
import { logger } from '../src/observability/logger';
import { readTelegramRetryAfterMetadata } from '../src/adapters/telegram/error-metadata';

describe('canonical safe error taxonomy', () => {
  it('registers every declared code exactly once with finite dimensions', () => {
    const codes = Object.keys(SAFE_ERROR_REGISTRY);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(50);
    for (const code of codes) {
      expect(isSafeErrorCode(code)).toBe(true);
      const value = getSafeErrorDefinition(code as keyof typeof SAFE_ERROR_REGISTRY);
      expect(ERROR_DOMAINS).toContain(value.domain);
      expect(ERROR_PROVIDERS).toContain(value.provider);
      expect(ERROR_STAGES).toContain(value.stage);
      expect(ERROR_CLASSES).toContain(value.class);
      expect(RETRYABILITIES).toContain(value.retryability);
      expect(VISIBILITIES).toContain(value.visibility);
      expect(AMBIGUITIES).toContain(value.ambiguity);
    }
  });

  it('never promotes an arbitrary Error message to a persisted code', () => {
    expect(safeErrorCode(new Error('private URL https://secret.example/token')))
      .toBe('INTERNAL_INVARIANT_VIOLATION');
    expect(isSafeErrorCode('private arbitrary string')).toBe(false);
  });

  it('preserves registered safe codes and bounded metadata only', () => {
    const error = new ProviderDeliveryError('RETRYABLE', 'OUTBOUND_RATE_LIMITED', {
      provider: 'TELEGRAM', httpStatus: 429, retryAfterSeconds: 60
    });
    expect(safeErrorCode(error)).toBe('OUTBOUND_RATE_LIMITED');
    expect(safeErrorMetadata(error)).toMatchObject({
      error_code: 'OUTBOUND_RATE_LIMITED', error_provider: 'TELEGRAM',
      http_status: 429, retry_after_seconds: 60
    });
  });

  it('does not emit an unknown exception message into structured logs', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('Operation failed', new Error(
      'Authorization: Bearer secret AI key https://private.example/attachment'
    ));
    const serialized = String(output.mock.calls[0][0]);
    expect(serialized).toContain('INTERNAL_INVARIANT_VIOLATION');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('private.example');
    output.mockRestore();
  });

  it('exposes RETRY_EXHAUSTED as a code contract without a database state', () => {
    expect(retryExhaustionSemantic(2, 3)).toBe('RETRY_PENDING');
    expect(retryExhaustionSemantic(3, 3)).toBe('RETRY_EXHAUSTED');
  });

  it('bounds RetryableProcessingError delays', () => {
    expect(new RetryableProcessingError('QUEUE_EVENT_CLAIM_CONTENDED', 0).retryAfterSeconds).toBe(5);
    expect(new RetryableProcessingError('QUEUE_EVENT_CLAIM_CONTENDED', 999999).retryAfterSeconds).toBe(900);
  });
});

describe('Retry-After contract', () => {
  const withoutJitter = { jitter: false } as const;

  it('uses Telegram retry_after before the HTTP header', () => {
    expect(resolveRetryAfterSeconds({ telegramRetryAfter: 10, httpRetryAfter: '30', ...withoutJitter })).toBe(10);
  });

  it('supports HTTP delta-seconds and never shortens the requested wait', () => {
    expect(resolveRetryAfterSeconds({ httpRetryAfter: '30', random: () => 1 })).toBeGreaterThanOrEqual(30);
    expect(resolveRetryAfterSeconds({ httpRetryAfter: '1', ...withoutJitter })).toBe(1);
    expect(resolveRetryAfterSeconds({ httpRetryAfter: '901', ...withoutJitter })).toBe(900);
  });

  it('supports a future HTTP-date', () => {
    const nowMs = Date.parse('2026-09-14T00:00:00Z');
    expect(resolveRetryAfterSeconds({
      httpRetryAfter: 'Mon, 14 Sep 2026 00:01:00 GMT', nowMs, ...withoutJitter
    })).toBe(60);
  });

  it.each([
    ['past date', { httpRetryAfter: 'Sun, 13 Sep 2026 23:59:59 GMT', nowMs: Date.parse('2026-09-14T00:00:00Z') }],
    ['zero', { httpRetryAfter: '0' }],
    ['negative', { httpRetryAfter: '-1' }],
    ['NaN', { httpRetryAfter: 'NaN' }],
    ['Infinity', { httpRetryAfter: 'Infinity' }],
    ['overflow', { httpRetryAfter: '999999999999999999999999999999999' }],
    ['malformed', { httpRetryAfter: 'later please' }],
    ['missing', {}]
  ])('uses the fallback for %s', (_label, input) => {
    expect(resolveRetryAfterSeconds({ ...input, ...withoutJitter })).toBe(RETRY_DELAY_FALLBACK_SECONDS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid Telegram retry_after value %s', value => {
      expect(resolveRetryAfterSeconds({ telegramRetryAfter: value, ...withoutJitter }))
        .toBe(RETRY_DELAY_FALLBACK_SECONDS);
    }
  );

  it('clamps huge valid Telegram values and added jitter to the maximum', () => {
    expect(resolveRetryAfterSeconds({ telegramRetryAfter: Number.MAX_SAFE_INTEGER, random: () => 1 }))
      .toBe(RETRY_DELAY_MAX_SECONDS);
  });

  it('keeps jitter within ten percent and thirty seconds', () => {
    expect(resolveRetryAfterSeconds({ telegramRetryAfter: 60, random: () => 1 })).toBe(66);
    expect(resolveRetryAfterSeconds({ telegramRetryAfter: 600, random: () => 1 })).toBe(630);
  });

  it('publishes the frozen bounds and Queue helper', () => {
    expect(RETRY_DELAY_MIN_SECONDS).toBe(1);
    expect(RETRY_DELAY_MAX_SECONDS).toBe(900);
    expect(RETRY_DELAY_FALLBACK_SECONDS).toBe(5);
    expect(boundedQueueRetryDelay(37)).toBe(37);
  });

  it('ignores oversized Telegram error bodies instead of parsing unbounded provider data', async () => {
    const response = new Response(JSON.stringify({
      parameters: { retry_after: 10 }, padding: 'x'.repeat(5000)
    }), { status: 429 });
    await expect(readTelegramRetryAfterMetadata(response)).resolves.toBeUndefined();
  });
});
