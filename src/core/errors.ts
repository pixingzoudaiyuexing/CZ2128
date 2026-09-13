export type DeliveryOutcome = 'RETRYABLE' | 'FINAL' | 'AMBIGUOUS';

export class ProviderDeliveryError extends Error {
  constructor(
    public readonly outcome: DeliveryOutcome,
    public readonly code: string
  ) {
    super(code);
    this.name = 'ProviderDeliveryError';
  }
}

export class RetryableProcessingError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = 'RetryableProcessingError';
  }
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof ProviderDeliveryError) {
    return `${error.outcome}:${error.code}`;
  }
  if (error instanceof RetryableProcessingError) {
    return error.name;
  }
  return error instanceof Error ? error.name : 'UnknownError';
}
