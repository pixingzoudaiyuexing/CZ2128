import { DatabaseEnv } from './database';
import { Conversation } from './domain';

export async function getOrCreateConversation(
  env: DatabaseEnv,
  helpdesk_provider: string,
  helpdesk_account_ref: string,
  helpdesk_conversation_ref: string,
  customer_ref: string
): Promise<Conversation> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  // Atomic get-or-create using ON CONFLICT DO NOTHING
  await env.DB.prepare(
    `INSERT INTO conversations (
      id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, 
      customer_ref, operator_channel, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref) DO NOTHING`
  ).bind(
    id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref,
    customer_ref, 'telegram', now, now, 1
  ).run();

  const conv = await env.DB.prepare(
    `SELECT * FROM conversations 
     WHERE helpdesk_provider = ? AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?`
  ).bind(helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref).first<Conversation>();

  if (!conv) {
    throw new Error('Failed to create or retrieve conversation');
  }
  return conv;
}

export async function updateOperatorThreadRef(
  env: DatabaseEnv,
  conversationId: string,
  threadRef: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE conversations SET operator_thread_ref = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND operator_thread_ref IS NULL`
  ).bind(threadRef, now, conversationId).run();

  const winner = await env.DB.prepare(
    'SELECT operator_thread_ref FROM conversations WHERE id = ?'
  ).bind(conversationId).first<{ operator_thread_ref: string | null }>();
  if (!winner?.operator_thread_ref) {
    throw new Error('Failed to persist operator thread mapping');
  }
  if (winner.operator_thread_ref !== threadRef) {
    throw new Error('Operator thread mapping conflict');
  }
  return winner.operator_thread_ref;
}

export async function updateOperatorThreadStatus(
  env: DatabaseEnv,
  conversationId: string,
  expectedVersion: number,
  expectedStatus: 'OPEN' | 'CLOSED',
  nextStatus: 'OPEN' | 'CLOSED'
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE conversations
     SET operator_thread_status = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND version = ? AND operator_thread_status = ?`
  ).bind(nextStatus, Math.floor(Date.now() / 1000), conversationId, expectedVersion, expectedStatus).run();
  if (result.meta.changes === 1) return;

  const current = await env.DB.prepare(
    'SELECT operator_thread_status FROM conversations WHERE id = ?'
  ).bind(conversationId).first<{ operator_thread_status: string }>();
  if (current?.operator_thread_status !== nextStatus) {
    throw new Error('Operator thread status changed concurrently');
  }
}

export async function insertMessage(
  env: DatabaseEnv,
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
