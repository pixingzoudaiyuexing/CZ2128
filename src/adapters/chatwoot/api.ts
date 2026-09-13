import { Env } from '../../index';

export async function createChatwootMessage(
  env: Env,
  accountId: string,
  conversationId: string,
  content: string,
  outboundOperationId: string
): Promise<{ messageId: string }> {
  const url = `${env.CHATWOOT_API_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  
  // Try to use source_id if supported by API. Chatwoot currently supports custom attributes?
  // Documentation says: "CZ2128-originated Chatwoot messages should carry a stable source_id marker such as cz2128:<outbound_operation_id> where supported."
  // For V1, we'll pass source_id in the payload, if it's ignored we can fallback to something else, but architecture says "fast echo guard".
  const body = {
    content,
    message_type: 'outgoing',
    private: false,
    source_id: `cz2128:${outboundOperationId}`
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'api_access_token': env.CHATWOOT_API_TOKEN
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Chatwoot createMessage failed: ${await response.text()}`);
  }

  const data = await response.json() as any;
  return { messageId: String(data.id) };
}
