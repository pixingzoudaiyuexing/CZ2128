import { ErrorProvider, SafeErrorCode } from './error-taxonomy';
import { DeliveryOutcome, ProviderDeliveryError } from './errors';
import { resolveRetryAfterSeconds } from './retry';

export interface ProviderFailureClassification {
  outcome: DeliveryOutcome;
  code: SafeErrorCode;
}

export function classifyVisibleHttpFailure(status: number): ProviderFailureClassification {
  if (status === 429) return { outcome: 'RETRYABLE', code: 'OUTBOUND_RATE_LIMITED' };
  if (status === 408) return { outcome: 'AMBIGUOUS', code: 'OUTBOUND_TIMEOUT_AMBIGUOUS' };
  if (status >= 500) return { outcome: 'AMBIGUOUS', code: 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS' };
  return { outcome: 'FINAL', code: 'OUTBOUND_PROVIDER_4XX_FINAL' };
}

export function visibleHttpDeliveryError(
  provider: Extract<ErrorProvider, 'TELEGRAM' | 'CHATWOOT'>,
  status: number,
  options: { telegramRetryAfter?: unknown; httpRetryAfter?: string | null } = {}
): ProviderDeliveryError {
  const classification = classifyVisibleHttpFailure(status);
  return new ProviderDeliveryError(classification.outcome, classification.code, {
    provider,
    httpStatus: status,
    ...(status === 429 ? {
      retryAfterSeconds: resolveRetryAfterSeconds({
        telegramRetryAfter: options.telegramRetryAfter,
        httpRetryAfter: options.httpRetryAfter
      })
    } : {})
  });
}

export function visibleTransportDeliveryError(
  provider: Extract<ErrorProvider, 'TELEGRAM' | 'CHATWOOT'>
): ProviderDeliveryError {
  return new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_TRANSPORT_AMBIGUOUS', { provider });
}

export function invalidVisibleSuccessError(
  provider: Extract<ErrorProvider, 'TELEGRAM' | 'CHATWOOT'>
): ProviderDeliveryError {
  return new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_INVALID_SUCCESS_AMBIGUOUS', {
    provider,
    stage: 'PARSE_RESPONSE'
  });
}
