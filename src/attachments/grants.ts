import { Env } from '../config/env';
import { trustedPublicOrigin } from '../config/public-origin';
import { AttachmentRow } from '../core/attachments';
import { deriveAttachmentGrantToken, hashUploadCapability } from '../uploads/capability';

export async function ensureAttachmentGrant(env: Env, row: AttachmentRow, renew = false): Promise<{ token: string; url: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = row.retention_expires_at ?? row.expires_at;
  if (!expiry || expiry <= now || row.deleted_at) throw new Error('ATTACHMENT_EXPIRED');
  const latest = await env.DB.prepare(
    'SELECT generation,expires_at,revoked_at FROM attachment_access_grants WHERE attachment_id=? ORDER BY generation DESC LIMIT 1'
  ).bind(row.id).first<{ generation: number; expires_at: number; revoked_at: number | null }>();
  const generation = latest && !renew && !latest.revoked_at && latest.expires_at > now ? latest.generation : (latest?.generation || 0) + 1;
  const token = await deriveAttachmentGrantToken(env.UPLOAD_CAPABILITY_SECRET || '', row.id, generation);
  await env.DB.prepare(
    'INSERT INTO attachment_access_grants(token_hash,attachment_id,generation,expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(attachment_id,generation) DO NOTHING'
  ).bind(await hashUploadCapability(token), row.id, generation, expiry, now).run();
  return { token, url: `${trustedPublicOrigin(env)}/attachments/${token}/${row.retention_class === 'IMAGE' ? 'inline' : 'download'}`, expiresAt: expiry };
}
