import { Env } from '../config/env';
import { logger } from '../observability/logger';

export const ATTACHMENT_CLEANUP_BATCH = 100;

function isManagedAttachmentStorageKey(value: string): boolean {
  return /^(attachments|attachments-v2)\/[^/]+$/.test(value);
}

/** Physical deletion must succeed before retiring durable cleanup/foreign-key evidence. */
export async function cleanupExpiredAttachments(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await env.DB.prepare(
    `SELECT id, storage_key, cleanup_attempts FROM attachments
     WHERE COALESCE(retention_expires_at, expires_at) IS NOT NULL
       AND COALESCE(retention_expires_at, expires_at) <= ? AND deleted_at IS NULL
       AND COALESCE(cleanup_next_retry_at, 0) <= ?
     ORDER BY COALESCE(retention_expires_at, expires_at) ASC, id ASC LIMIT ?`
  ).bind(now, now, ATTACHMENT_CLEANUP_BATCH).all<{ id: string; storage_key: string; cleanup_attempts: number }>();

  for (const row of expired.results) {
    if (!isManagedAttachmentStorageKey(row.storage_key)) {
      logger.warn('Attachment cleanup skipped unsafe storage key', {
        attachment_id: row.id, error_category: 'ATTACHMENT_STORAGE_KEY_UNSAFE', provider: 'R2', stage: 'CLEANUP'
      });
      continue;
    }
    try {
      await env.ATTACHMENTS_BUCKET.delete(row.storage_key);
    } catch {
      const attempts = Math.max(Number(row.cleanup_attempts) || 0, 0) + 1;
      try {
        await env.DB.prepare(
          `UPDATE attachments SET cleanup_attempts = cleanup_attempts + 1, cleanup_next_retry_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        ).bind(now + Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7)), row.id).run();
      } catch { /* The preserved row is retried by the next scheduled pass. */ }
      logger.warn('Attachment cleanup R2 delete failed; durable metadata retained', {
        attachment_id: row.id, error_category: 'R2_DELETE_FAILED', error_code: 'R2_DELETE_TRANSIENT', provider: 'R2', stage: 'CLEANUP'
      });
      continue;
    }
    try {
      await env.DB.prepare(
        `UPDATE attachments SET deleted_at = ?, cleanup_next_retry_at = NULL, grant_revoked_at = COALESCE(grant_revoked_at, ?)
         WHERE id = ? AND deleted_at IS NULL AND COALESCE(retention_expires_at, expires_at) <= ?`
      ).bind(now, now, row.id, now).run();
    } catch {
      // R2 deletion is idempotent: a later pass can safely retire the same row.
      logger.warn('Attachment cleanup metadata retirement failed', {
        attachment_id: row.id, error_category: 'D1_CLEANUP_FAILED', provider: 'D1', stage: 'CLEANUP'
      });
    }
  }
}
