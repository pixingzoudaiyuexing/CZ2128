import { Env } from '../../config/env';
import { ProviderDeliveryError, RetryableProcessingError, SafeError } from '../../core/errors';
import { OutboundAttemptLifecycle } from '../../core/outbound-operations';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../../core/provider-retry';
import { retryAfterHeader } from '../../core/retry';
import { buildChatwootApiUrl } from './url';

export type ChatwootConversationStatus = 'open' | 'resolved';

export async function fetchChatwootConversationStatus(
  env: Env,
  accountId: string,
  conversationId: string
): Promise<ChatwootConversationStatus> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'CHATWOOT', stage: 'PREPARE' });
  }

  const url = buildChatwootApiUrl(
    env.CHATWOOT_API_URL,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/conversations/${encodeURIComponent(conversationId)}`
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'api_access_token': env.CHATWOOT_API_TOKEN }
    });
  } catch {
    throw new RetryableProcessingError('CHATWOOT_STATE_READ_FAILED', 5, {
      provider: 'CHATWOOT',
      stage: 'SOURCE_METADATA'
    });
  }
  if (!response.ok) {
    throw new RetryableProcessingError('CHATWOOT_STATE_READ_FAILED', 5, {
      provider: 'CHATWOOT',
      stage: 'SOURCE_METADATA',
      httpStatus: response.status
    });
  }

  try {
    const data = await response.json() as { status?: unknown };
    if (data.status !== 'open' && data.status !== 'resolved') {
      throw new SafeError('CHATWOOT_STATE_INVALID', { provider: 'CHATWOOT', stage: 'PARSE_RESPONSE' });
    }
    return data.status;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('CHATWOOT_STATE_INVALID', { provider: 'CHATWOOT', stage: 'PARSE_RESPONSE' });
  }
}

export async function createChatwootMessage(
  env: Env,
  accountId: string,
  conversationId: string,
  content: string,
  outboundOperationId: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ messageId: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'CHATWOOT' });
  }
  
  
  const url = buildChatwootApiUrl(
    env.CHATWOOT_API_URL,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/conversations/${encodeURIComponent(conversationId)}/messages`
  );
  
  const body = {
    content,
    message_type: 'outgoing',
    private: false,
    source_id: `cz2128:${outboundOperationId}`
  };

  const payload = JSON.stringify(body);

  if (lifecycle) {
    await lifecycle.requestStarted();
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': env.CHATWOOT_API_TOKEN
      },
      body: payload
    });
  } catch {
    throw visibleTransportDeliveryError('CHATWOOT');
  }

  if (lifecycle) {
    await lifecycle.responseObserved(response.status);
  }

  if (!response.ok) {
    throw visibleHttpDeliveryError('CHATWOOT', response.status, {
      httpRetryAfter: retryAfterHeader(response)
    });
  }

  try {
    const data = await response.json() as any;
    if (data?.id === undefined || data?.id === null) {
      throw invalidVisibleSuccessError('CHATWOOT');
    }
    return { messageId: String(data.id) };
  } catch (error) {
    if (error instanceof ProviderDeliveryError) throw error;
    throw invalidVisibleSuccessError('CHATWOOT');
  }
}
