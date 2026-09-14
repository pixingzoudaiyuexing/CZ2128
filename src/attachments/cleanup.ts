import { Env } from '../config/env';
import { logger } from '../observability/logger';

export const ATTACHMENT_CLEANUP_BATCH = 100;

export async function cleanupExpiredAttachments(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await env.DB.prepare(
    `SELECT id, storage_key FROM attachments
     WHERE expires_at IS NOT NULL AND expires_at <= ?
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`
  ).bind(now, ATTACHMENT_CLEANUP_BATCH).all<{ id: string; storage_key: string }>();

  for (const row of expired.results) {
    try {
      await env.ATTACHMENTS_BUCKET.delete(row.storage_key);
      await env.DB.prepare(
        'DELETE FROM attachments WHERE id = ? AND expires_at IS NOT NULL AND expires_at <= ?'
      ).bind(row.id, now).run();
    } catch {
      logger.warn('Attachment cleanup failed', {
        attachment_id: row.id,
        error_category: 'R2_DELETE_FAILED',
        error_code: 'R2_DELETE_TRANSIENT',
        provider: 'R2',
        stage: 'CLEANUP'
      });
    }
  }
}
