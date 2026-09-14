import { Env } from '../../config/env';
import { ProviderDeliveryError } from '../../core/errors';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../../core/provider-retry';
import { retryAfterHeader } from '../../core/retry';

export async function createChatwootMessage(
  env: Env,
  accountId: string,
  conversationId: string,
  content: string,
  outboundOperationId: string
): Promise<{ messageId: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'CHATWOOT' });
  }
  const url = `${env.CHATWOOT_API_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  
  const body = {
    content,
    message_type: 'outgoing',
    private: false,
    source_id: `cz2128:${outboundOperationId}`
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': env.CHATWOOT_API_TOKEN
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw visibleTransportDeliveryError('CHATWOOT');
  }

  if (!response.ok) {
    throw visibleHttpDeliveryError('CHATWOOT', response.status, {
      httpRetryAfter: retryAfterHeader(response)
    });
  }

  try {
    const data = await response.json() as any;
    if (data.id === undefined || data.id === null) throw new Error('Missing message id');
    return { messageId: String(data.id) };
  } catch {
    throw invalidVisibleSuccessError('CHATWOOT');
  }
}
