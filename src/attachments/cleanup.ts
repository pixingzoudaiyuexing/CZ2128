import { Env } from '../config/env';
import { logger } from '../observability/logger';

export const ATTACHMENT_CLEANUP_BATCH = 100;
const ATTACHMENT_STORAGE_PREFIX = 'attachments/';

function isManagedAttachmentStorageKey(value: string): boolean {
  return value.startsWith(ATTACHMENT_STORAGE_PREFIX) && value.length > ATTACHMENT_STORAGE_PREFIX.length;
}

async function deleteExpiredAttachmentMetadata(
  env: Env,
  row: { id: string; storage_key: string },
  now: number
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM upload_invite_items
       WHERE attachment_id = ?
         AND EXISTS (
           SELECT 1
           FROM upload_invites
           WHERE upload_invites.id = upload_invite_items.invite_id
             AND (upload_invites.status != 'ACTIVE' OR upload_invites.expires_at <= ?)
         )`
    ).bind(row.id, now),
    env.DB.prepare(
      `DELETE FROM attachments
       WHERE id = ?
         AND expires_at IS NOT NULL
         AND expires_at <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM upload_invite_items
           WHERE attachment_id = ?
         )`
    ).bind(row.id, now, row.id)
  ]);

  return results[1]?.meta.changes === 1;
}

export async function cleanupExpiredAttachments(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await env.DB.prepare(
    `SELECT id, storage_key FROM attachments
     WHERE expires_at IS NOT NULL AND expires_at <= ?
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`
  ).bind(now, ATTACHMENT_CLEANUP_BATCH).all<{ id: string; storage_key: string }>();

  for (const row of expired.results) {
    if (!isManagedAttachmentStorageKey(row.storage_key)) {
      logger.warn('Attachment cleanup skipped unsafe storage key', {
        attachment_id: row.id,
        error_category: 'ATTACHMENT_STORAGE_KEY_UNSAFE',
        provider: 'R2',
        stage: 'CLEANUP'
      });
      continue;
    }

    let metadataDeleted = false;
    try {
      metadataDeleted = await deleteExpiredAttachmentMetadata(env, row, now);
    } catch {
      logger.warn('Attachment cleanup metadata delete failed', {
        attachment_id: row.id,
        error_category: 'D1_CLEANUP_FAILED',
        provider: 'D1',
        stage: 'CLEANUP'
      });
      continue;
    }

    if (!metadataDeleted) continue;

    try {
      await env.ATTACHMENTS_BUCKET.delete(row.storage_key);
    } catch {
      logger.warn('Attachment cleanup R2 delete failed after metadata expiry', {
        attachment_id: row.id,
        error_category: 'R2_DELETE_FAILED',
        error_code: 'R2_DELETE_TRANSIENT',
        provider: 'R2',
        stage: 'CLEANUP'
      });
    }
  }
}
