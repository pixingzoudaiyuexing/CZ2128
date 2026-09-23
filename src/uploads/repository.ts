import { Env } from '../config/env';

export type UploadInviteStatus = 'ACTIVE' | 'REVOKED' | 'EXHAUSTED' | 'EXPIRED';
export type UploadItemStatus = 'UPLOADING' | 'ACCEPTED' | 'REJECTED';

export interface UploadInviteRow {
  id: string;
  token_hash: string;
  conversation_id: string;
  crisp_website_ref: string;
  crisp_session_ref: string;
  telegram_group_ref: string;
  telegram_thread_ref: string;
  support_profile_version: number;
  created_by_operator_ref: string;
  created_from_update_ref: string;
  status: UploadInviteStatus;
  expires_at: number;
  max_files: number;
  max_total_bytes: number;
  consumed_files: number;
  consumed_bytes: number;
  version: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  exhausted_at: number | null;
}

export interface UploadInviteItemRow {
  invite_id: string;
  upload_id: string;
  attachment_id: string;
  status: UploadItemStatus;
  size_bytes: number | null;
  lease_token: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateUploadInviteInput {
  id: string;
  tokenHash: string;
  conversationId: string;
  crispWebsiteRef: string;
  crispSessionRef: string;
  telegramGroupRef: string;
  telegramThreadRef: string;
  supportProfileVersion: number;
  operatorRef: string;
  updateRef: string;
  expiresAt: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export type CreateUploadInviteResult =
  | { outcome: 'CURRENT'; row: UploadInviteRow }
  | { outcome: 'STALE'; row: UploadInviteRow };

async function latestUploadInvite(env: Env, conversationId: string): Promise<UploadInviteRow | null> {
  return env.DB.prepare(
    'SELECT * FROM upload_invites WHERE conversation_id = ? ORDER BY support_profile_version DESC, CAST(created_from_update_ref AS INTEGER) DESC, created_at DESC LIMIT 1'
  ).bind(conversationId).first<UploadInviteRow>();
}

export async function createOrGetUploadInvite(env: Env, input: CreateUploadInviteInput): Promise<CreateUploadInviteResult> {
  if (!/^\d+$/.test(input.updateRef)) throw new Error('UPLOAD_INVITE_UPDATE_REF_INVALID');
  const inputUpdate = Number(input.updateRef);
  if (!Number.isSafeInteger(inputUpdate) || inputUpdate < 0) throw new Error('UPLOAD_INVITE_UPDATE_REF_INVALID');

  const existing = await env.DB.prepare(
    'SELECT * FROM upload_invites WHERE support_profile_version = ? AND created_from_update_ref = ?'
  ).bind(input.supportProfileVersion, input.updateRef).first<UploadInviteRow>();
  if (existing) {
    if (existing.status === 'ACTIVE') return { outcome: 'CURRENT', row: existing };
    const latest = await latestUploadInvite(env, input.conversationId);
    return { outcome: 'STALE', row: latest || existing };
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO upload_invites (id, token_hash, conversation_id, crisp_website_ref, crisp_session_ref, telegram_group_ref, telegram_thread_ref, support_profile_version, created_by_operator_ref, created_from_update_ref, status, expires_at, max_files, max_total_bytes, consumed_files, consumed_bytes, version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 0, 0, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM upload_invites WHERE conversation_id = ? AND (support_profile_version > ? OR (support_profile_version = ? AND CAST(created_from_update_ref AS INTEGER) > ?))) ON CONFLICT(support_profile_version, created_from_update_ref) DO NOTHING"
  ).bind(
    input.id, input.tokenHash, input.conversationId, input.crispWebsiteRef, input.crispSessionRef,
    input.telegramGroupRef, input.telegramThreadRef, input.supportProfileVersion,
    input.operatorRef, input.updateRef, input.expiresAt, input.maxFiles, input.maxTotalBytes,
    now, now,
    input.conversationId, input.supportProfileVersion, input.supportProfileVersion, inputUpdate
  ).run();

  let row = await env.DB.prepare('SELECT * FROM upload_invites WHERE id = ?').bind(input.id).first<UploadInviteRow>();
  if (!row) {
    const latest = await latestUploadInvite(env, input.conversationId);
    if (!latest) throw new Error('UPLOAD_INVITE_PERSIST_FAILED');
    return { outcome: 'STALE', row: latest };
  }

  await env.DB.prepare(
    "UPDATE upload_invites SET status = 'REVOKED', revoked_at = ?, updated_at = ?, version = version + 1 WHERE conversation_id = ? AND status = 'ACTIVE' AND id != ? AND (support_profile_version < ? OR (support_profile_version = ? AND CAST(created_from_update_ref AS INTEGER) < ?))"
  ).bind(
    now, now, input.conversationId, input.id,
    input.supportProfileVersion, input.supportProfileVersion, inputUpdate
  ).run();

  row = await env.DB.prepare('SELECT * FROM upload_invites WHERE id = ?').bind(input.id).first<UploadInviteRow>();
  if (!row) throw new Error('UPLOAD_INVITE_PERSIST_FAILED');
  if (row.status !== 'ACTIVE') {
    const latest = await latestUploadInvite(env, input.conversationId);
    return { outcome: 'STALE', row: latest || row };
  }
  return { outcome: 'CURRENT', row };
}

export async function getUploadInviteByTokenHash(env: Env, tokenHash: string): Promise<UploadInviteRow | null> {
  return env.DB.prepare('SELECT * FROM upload_invites WHERE token_hash = ?').bind(tokenHash).first<UploadInviteRow>();
}

export async function getUploadInviteById(env: Env, inviteId: string): Promise<UploadInviteRow | null> {
  return env.DB.prepare('SELECT * FROM upload_invites WHERE id = ?').bind(inviteId).first<UploadInviteRow>();
}

export async function expireUploadInvite(env: Env, inviteId: string, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE upload_invites SET status = 'EXPIRED', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'ACTIVE' AND expires_at <= ?"
  ).bind(now, inviteId, now).run();
}

export async function revokeActiveUploadInvite(env: Env, conversationId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    "UPDATE upload_invites SET status = 'REVOKED', revoked_at = ?, updated_at = ?, version = version + 1 WHERE conversation_id = ? AND status = 'ACTIVE'"
  ).bind(now, now, conversationId).run();
  return result.meta.changes;
}

export async function revokeUploadInviteById(env: Env, inviteId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    "UPDATE upload_invites SET status = 'REVOKED', revoked_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'ACTIVE'"
  ).bind(now, now, inviteId).run();
  return result.meta.changes === 1;
}

function randomLeaseToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type UploadItemClaim =
  | { outcome: 'CLAIMED'; item: UploadInviteItemRow; leaseToken: string }
  | { outcome: 'ACCEPTED'; item: UploadInviteItemRow }
  | { outcome: 'BUSY'; item: UploadInviteItemRow }
  | { outcome: 'REJECTED'; item: UploadInviteItemRow }
  | { outcome: 'INVITE_UNAVAILABLE'; item: null };

export async function claimUploadItem(
  env: Env,
  inviteId: string,
  uploadId: string,
  attachmentId: string,
  leaseSeconds: number
): Promise<UploadItemClaim> {
  const now = Math.floor(Date.now() / 1000);
  const leaseToken = randomLeaseToken();
  await env.DB.prepare(
    "INSERT INTO upload_invite_items (invite_id, upload_id, attachment_id, status, size_bytes, lease_token, lease_until, created_at, updated_at) SELECT ?, ?, ?, 'UPLOADING', NULL, ?, ?, ?, ? FROM upload_invites WHERE id = ? AND status = 'ACTIVE' AND expires_at > ? ON CONFLICT(invite_id, upload_id) DO NOTHING"
  ).bind(inviteId, uploadId, attachmentId, leaseToken, now + leaseSeconds, now, now, inviteId, now).run();

  let item = await env.DB.prepare(
    'SELECT * FROM upload_invite_items WHERE invite_id = ? AND upload_id = ?'
  ).bind(inviteId, uploadId).first<UploadInviteItemRow>();
  if (!item) return { outcome: 'INVITE_UNAVAILABLE', item: null };
  if (item.attachment_id !== attachmentId) return { outcome: 'REJECTED', item };
  if (item.status === 'ACCEPTED') return { outcome: 'ACCEPTED', item };
  if (item.status === 'REJECTED') return { outcome: 'REJECTED', item };
  if (item.lease_token === leaseToken) return { outcome: 'CLAIMED', item, leaseToken };

  if (Number(item.lease_until || 0) <= now) {
    const reclaimed = await env.DB.prepare(
      "UPDATE upload_invite_items SET lease_token = ?, lease_until = ?, updated_at = ? WHERE invite_id = ? AND upload_id = ? AND status = 'UPLOADING' AND COALESCE(lease_until, 0) <= ?"
    ).bind(leaseToken, now + leaseSeconds, now, inviteId, uploadId, now).run();
    if (reclaimed.meta.changes === 1) {
      item = await env.DB.prepare(
        'SELECT * FROM upload_invite_items WHERE invite_id = ? AND upload_id = ?'
      ).bind(inviteId, uploadId).first<UploadInviteItemRow>();
      if (!item) return { outcome: 'INVITE_UNAVAILABLE', item: null };
      return { outcome: 'CLAIMED', item, leaseToken };
    }
  }

  return { outcome: 'BUSY', item };
}

export async function acceptUploadItem(
  env: Env,
  inviteId: string,
  uploadId: string,
  leaseToken: string,
  sizeBytes: number
): Promise<'ACCEPTED' | 'LIMIT'> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const result = await env.DB.prepare(
      "UPDATE upload_invite_items SET status = 'ACCEPTED', size_bytes = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE invite_id = ? AND upload_id = ? AND status = 'UPLOADING' AND lease_token = ?"
    ).bind(sizeBytes, now, inviteId, uploadId, leaseToken).run();
    return result.meta.changes >= 1 ? 'ACCEPTED' : 'LIMIT';
  } catch (error) {
    const text = String(error);
    if (text.includes('UPLOAD_INVITE_LIMIT') || text.includes('UPLOAD_INVITE_INVALID_SIZE')) return 'LIMIT';
    throw error;
  }
}

export async function rejectUploadItem(
  env: Env,
  inviteId: string,
  uploadId: string,
  leaseToken?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (leaseToken) {
    await env.DB.prepare(
      "UPDATE upload_invite_items SET status = 'REJECTED', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE invite_id = ? AND upload_id = ? AND status = 'UPLOADING' AND lease_token = ?"
    ).bind(now, inviteId, uploadId, leaseToken).run();
    return;
  }
  await env.DB.prepare(
    "UPDATE upload_invite_items SET status = 'REJECTED', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE invite_id = ? AND upload_id = ? AND status = 'UPLOADING'"
  ).bind(now, inviteId, uploadId).run();
}

export async function getUploadItem(env: Env, inviteId: string, uploadId: string): Promise<UploadInviteItemRow | null> {
  return env.DB.prepare(
    'SELECT * FROM upload_invite_items WHERE invite_id = ? AND upload_id = ?'
  ).bind(inviteId, uploadId).first<UploadInviteItemRow>();
}