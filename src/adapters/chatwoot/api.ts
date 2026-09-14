import { Env } from '../../config/env';
import { ProviderDeliveryError } from '../../core/errors';

export async function createChatwootMessage(
  env: Env,
  accountId: string,
  conversationId: string,
  content: string,
  outboundOperationId: string
): Promise<{ messageId: string }> {
  if (
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_URL ||
    env.runtimeConfigSnapshot?.errors.CHATWOOT_API_TOKEN
  ) {
    throw new ProviderDeliveryError('FINAL', 'CHATWOOT_RUNTIME_CONFIG_ERROR');
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
    throw new ProviderDeliveryError('AMBIGUOUS', 'CHATWOOT_TRANSPORT_ERROR');
  }

  if (!response.ok) {
    const outcome = response.status === 429
      ? 'RETRYABLE'
      : response.status === 408 || response.status >= 500
        ? 'AMBIGUOUS'
        : 'FINAL';
    throw new ProviderDeliveryError(outcome, `CHATWOOT_HTTP_${response.status}`);
  }

  try {
    const data = await response.json() as any;
    if (data.id === undefined || data.id === null) throw new Error('Missing message id');
    return { messageId: String(data.id) };
  } catch {
    throw new ProviderDeliveryError('AMBIGUOUS', 'CHATWOOT_INVALID_SUCCESS_RESPONSE');
  }
}
