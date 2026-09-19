import {
  ErrorProvider,
  ErrorStage,
  SafeErrorCode,
  getSafeErrorDefinition,
  isSafeErrorCode
} from './error-taxonomy';
import { boundedQueueRetryDelay } from './retry';

export type DeliveryOutcome = 'RETRYABLE' | 'FINAL' | 'AMBIGUOUS';
export type RetryExhaustionSemantic = 'RETRY_PENDING' | 'RETRY_EXHAUSTED';

export interface SafeErrorOptions {
  provider?: ErrorProvider;
  stage?: ErrorStage;
  httpStatus?: number;
  retryAfterSeconds?: number;
}

export class SafeError extends Error {
  public readonly provider?: ErrorProvider;
  public readonly stage?: ErrorStage;
  public readonly httpStatus?: number;
  public readonly retryAfterSeconds?: number;

  constructor(public readonly code: SafeErrorCode, options: SafeErrorOptions = {}) {
    super(code);
    this.name = 'SafeError';
    this.provider = options.provider;
    this.stage = options.stage;
    this.httpStatus = Number.isSafeInteger(options.httpStatus) ? options.httpStatus : undefined;
    this.retryAfterSeconds = options.retryAfterSeconds === undefined
      ? undefined
      : boundedQueueRetryDelay(options.retryAfterSeconds);
  }
}

export class ProviderDeliveryError extends SafeError {
  constructor(
    public readonly outcome: DeliveryOutcome,
    code: SafeErrorCode,
    options: SafeErrorOptions = {}
  ) {
    super(code, options);
    this.name = 'ProviderDeliveryError';
  }
}

export class RetryableProcessingError extends SafeError {
  public readonly retryAfterSeconds: number;

  constructor(code: SafeErrorCode, retryAfterSeconds: number, options: Omit<SafeErrorOptions, 'retryAfterSeconds'> = {}) {
    const delay = boundedQueueRetryDelay(retryAfterSeconds);
    super(code, { ...options, retryAfterSeconds: delay });
    this.name = 'RetryableProcessingError';
    this.retryAfterSeconds = delay;
  }
}

export class CancelledBeforeDeliveryError extends SafeError {
  constructor() {
    super('CANCELLED_BY_HANDOFF');
    this.name = 'CancelledBeforeDeliveryError';
  }
}

export class StaleAiTriggerBeforeDeliveryError extends SafeError {
  constructor() {
    super('DISCARDED_STALE');
    this.name = 'StaleAiTriggerBeforeDeliveryError';
  }
}

export function retryExhaustionSemantic(attempt: number, maximumAttempts: number): RetryExhaustionSemantic {
  return attempt >= maximumAttempts ? 'RETRY_EXHAUSTED' : 'RETRY_PENDING';
}

export function safeErrorCode(error: unknown): SafeErrorCode {
  if (error instanceof SafeError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && isSafeErrorCode(error.code)) return error.code;
  if (error instanceof Error && isSafeErrorCode(error.message)) return error.message;
  return 'INTERNAL_INVARIANT_VIOLATION';
}

export function safeErrorMetadata(error: unknown) {
  const code = safeErrorCode(error);
  const definition = getSafeErrorDefinition(code);
  const safe = error instanceof SafeError ? error : undefined;
  return {
    error_code: code,
    error_domain: definition.domain,
    error_provider: safe?.provider ?? definition.provider,
    error_stage: safe?.stage ?? definition.stage,
    error_class: definition.class,
    retryability: definition.retryability,
    visibility: definition.visibility,
    ambiguity: definition.ambiguity,
    ...(safe?.httpStatus !== undefined ? { http_status: safe.httpStatus } : {}),
    ...(safe?.retryAfterSeconds !== undefined ? { retry_after_seconds: safe.retryAfterSeconds } : {})
  };
}
