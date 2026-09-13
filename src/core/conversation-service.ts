import { Env } from '../index';
import { Conversation } from './domain';

export async function getOrCreateConversation(
  env: Env,
  helpdesk_provider: string,
  helpdesk_account_ref: string,
  helpdesk_conversation_ref: string,
  customer_ref: string
): Promise<Conversation> {
  let conv = await env.DB.prepare(
    `SELECT * FROM conversations 
     WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?`
  ).bind(helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref).first<Conversation>();

  if (!conv) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO conversations (
        id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, 
        customer_ref, operator_channel, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref,
      customer_ref, 'telegram', now, now, 1
    ).run();

    conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<Conversation>();
  }
  return conv!;
}

export async function updateOperatorThreadRef(
  env: Env,
  conversationId: string,
  threadRef: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'UPDATE conversations SET operator_thread_ref = ?, updated_at = ?, version = version + 1 WHERE id = ?'
  ).bind(threadRef, now, conversationId).run();
}

export async function insertMessage(
  env: Env,
  conversationId: string,
  provider: string,
  providerMessageRef: string,
  direction: string,
  actorRole: string,
  messageType: string,
  textContent: string
): Promise<void> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_message_ref) DO NOTHING`
  ).bind(
    id, conversationId, provider, providerMessageRef, direction, actorRole, messageType, textContent, now
  ).run();
}

export async function enqueueOutboundOperation(
  env: Env,
  conversationId: string,
  destinationProvider: string,
  operationType: string,
  textContent: string | null
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, conversationId, destinationProvider, operationType, 'PENDING', now, now).run();
  
  return id;
}
