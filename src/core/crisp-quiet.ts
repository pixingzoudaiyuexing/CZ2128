import { Env } from '../config/env';
import { logger } from '../observability/logger';

const CLOCK_SKEW_MS = 60_000;

export async function recordCrispHumanReply(
  env: Env,
  conversationId: string,
  messageRef: string,
  providerTimestamp: number | undefined
): Promise<void> {
  // Old queued events did not retain message time. Never invent a fresh clock for them.
  if (messageRef.length < 1 || messageRef.length > 256) return;
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const valid = typeof providerTimestamp === 'number' && Number.isSafeInteger(providerTimestamp) && providerTimestamp >= 1000 &&
    providerTimestamp <= nowMs + CLOCK_SKEW_MS;
  const replyAt = valid ? Math.min(now, Math.floor(providerTimestamp / 1000)) : null;
  if (!valid) {
    logger.warn('Crisp human reply time rejected; notification clock unchanged', {
      conversation_id: conversationId, stage: 'NOTIFICATION', result: 'TIME_INVALID'
    });
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO crisp_human_reply_receipts (conversation_id, provider_message_ref, reply_at)
       SELECT ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM messages
         WHERE conversation_id = ? AND provider = 'crisp' AND provider_message_ref = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM attachments
         WHERE conversation_id = ? AND source_provider = 'crisp' AND source_message_ref = ?
       )
       ON CONFLICT (conversation_id, provider_message_ref) DO NOTHING`
    ).bind(conversationId, messageRef, replyAt, conversationId, messageRef, conversationId, messageRef),
    env.DB.prepare(
      `UPDATE conversations
       SET last_crisp_human_reply_at = (
             SELECT reply_at FROM crisp_human_reply_receipts
             WHERE conversation_id = ? AND provider_message_ref = ?
           ), version = version + 1
       WHERE id = ? AND helpdesk_provider = 'crisp'
         AND EXISTS (
           SELECT 1 FROM crisp_human_reply_receipts
           WHERE conversation_id = ? AND provider_message_ref = ? AND reply_at IS NOT NULL
             AND (conversations.last_crisp_human_reply_at IS NULL
                  OR conversations.last_crisp_human_reply_at < reply_at)
         )`
    ).bind(conversationId, messageRef, conversationId, conversationId, messageRef)
  ]);
}
