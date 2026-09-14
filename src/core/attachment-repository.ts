import { AttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import {
  AttachmentDescriptor,
  AttachmentProvider,
  AttachmentRow,
  AttachmentStatus,
  generateAttachmentToken,
  hashAttachmentToken,
  normalizeMime,
  sanitizeFilename,
  stableAttachmentId
} from './attachments';
import { AttachmentTransferEvent } from './events';
import { logger } from '../observability/logger';
import { SafeErrorCode } from './error-taxonomy';

export interface DiscoveredAttachment {
  row: AttachmentRow;
  job?: AttachmentTransferEvent;
}

export const MAX_ATTACHMENT_SOURCE_ATTEMPTS = 3;

export type AttachmentClaimResult =
  | { outcome: 'CLAIMED'; row: AttachmentRow }
  | { outcome: 'NOT_CLAIMED'; row: AttachmentRow | null }
  | { outcome: 'EXHAUSTED'; row: AttachmentRow };

export async function discoverAttachment(
  env: Env,
  config: AttachmentConfig,
  conversationId: string,
  sourceProvider: AttachmentProvider,
  sourceMessageRef: string,
  descriptor: AttachmentDescriptor
): Promise<DiscoveredAttachment> {
  const id = await stableAttachmentId(sourceProvider, sourceMessageRef, descriptor.sourceAttachmentRef);
  const token = generateAttachmentToken();
  const tokenHash = await hashAttachmentToken(token);
  const filename = sanitizeFilename(descriptor.originalFilename, descriptor.attachmentType);
  const now = Math.floor(Date.now() / 1000);
  const status: AttachmentStatus = descriptor.rejectionCode ? 'FAILED_FINAL' : 'PENDING';
  const destinationProvider: AttachmentProvider = sourceProvider === 'telegram' ? 'chatwoot' : 'telegram';
  const storageKey = `attachments/${id}`;

  await env.DB.prepare(
    `INSERT INTO attachments (
       id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
       attachment_type, original_filename, safe_filename, mime_type, size_bytes,
       storage_key, access_token_hash, status, destination_provider, attempt_count,
       expires_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT (source_provider, source_message_ref, source_attachment_ref) DO NOTHING`
  ).bind(
    id, conversationId, sourceProvider, sourceMessageRef, descriptor.sourceAttachmentRef,
    descriptor.attachmentType, filename.original, filename.safe, normalizeMime(descriptor.mimeType),
    descriptor.sizeBytes ?? null, storageKey, tokenHash, status, destinationProvider,
    now + config.ttlSeconds, descriptor.rejectionCode || null, now, now
  ).run();

  let row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<AttachmentRow>();
  if (!row) throw new Error('Attachment row could not be loaded');

  if (row.status === 'PENDING' && row.access_token_hash !== tokenHash) {
    const rotated = await env.DB.prepare(
      `UPDATE attachments SET access_token_hash = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING'`
    ).bind(tokenHash, now, id).run();
    if (rotated.meta.changes === 1) {
      row = { ...row, access_token_hash: tokenHash, updated_at: now };
    }
  }

  const job = row.status === 'PENDING' && row.access_token_hash === tokenHash
    ? {
        version: 1 as const,
        source: 'internal' as const,
        type: 'attachment_transfer' as const,
        eventId: `attachment:${row.id}`,
        payload: { attachmentId: row.id, accessToken: token, locator: descriptor.locator }
      }
    : undefined;
  return { row, job };
}

export async function enqueueAttachmentJobs(
  env: Env,
  config: AttachmentConfig,
  conversationId: string,
  sourceProvider: AttachmentProvider,
  sourceMessageRef: string,
  descriptors: AttachmentDescriptor[]
): Promise<void> {
  if (descriptors.length > config.maxCountPerMessage) {
    logger.warn('Attachment count exceeds configured limit', {
      conversation_id: conversationId,
      source: sourceProvider,
      error_category: 'ATTACHMENT_COUNT_LIMIT',
      error_code: 'ATTACHMENT_COUNT_LIMIT',
      stage: 'SOURCE_METADATA'
    });
  }
  for (const descriptor of descriptors.slice(0, config.maxCountPerMessage)) {
    const discovered = await discoverAttachment(
      env, config, conversationId, sourceProvider, sourceMessageRef, descriptor
    );
    if (discovered.job) await env.QUEUE.send(discovered.job);
  }
}

export async function getAttachment(env: Env, attachmentId: string): Promise<AttachmentRow | null> {
  return env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(attachmentId).first<AttachmentRow>();
}

export async function claimAttachment(env: Env, attachmentId: string): Promise<AttachmentClaimResult> {
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare(
    `UPDATE attachments
     SET status = 'FETCHING', attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
     WHERE id = ? AND attempt_count < ?
       AND status IN ('PENDING', 'FETCHING', 'FAILED_RETRYABLE')`
  ).bind(now, attachmentId, MAX_ATTACHMENT_SOURCE_ATTEMPTS).run();
  const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(attachmentId).first<AttachmentRow>();
  if (claimed.meta.changes === 1) {
    if (!row) throw new Error('Claimed attachment row could not be loaded');
    return { outcome: 'CLAIMED', row };
  }
  if (
    row &&
    ['PENDING', 'FETCHING', 'FAILED_RETRYABLE'].includes(row.status) &&
    row.attempt_count >= MAX_ATTACHMENT_SOURCE_ATTEMPTS
  ) {
    return { outcome: 'EXHAUSTED', row };
  }
  return { outcome: 'NOT_CLAIMED', row };
}

export async function markAttachmentStored(
  env: Env,
  attachmentId: string,
  sizeBytes: number,
  config: AttachmentConfig
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE attachments
     SET status = 'STORED', size_bytes = ?, expires_at = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'FETCHING'`
  ).bind(sizeBytes, now + config.ttlSeconds, now, attachmentId).run();
  return result.meta.changes === 1;
}

export async function markAttachmentFailure(
  env: Env,
  attachmentId: string,
  retryable: boolean,
  errorCode: SafeErrorCode,
  config: AttachmentConfig
): Promise<'FAILED_RETRYABLE' | 'FAILED_FINAL'> {
  const row = await env.DB.prepare('SELECT attempt_count FROM attachments WHERE id = ?').bind(attachmentId).first<{ attempt_count: number }>();
  const status = retryable && Number(row?.attempt_count || 0) < MAX_ATTACHMENT_SOURCE_ATTEMPTS
    ? 'FAILED_RETRYABLE'
    : 'FAILED_FINAL';
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE attachments
     SET status = ?, last_error = ?, expires_at = CASE WHEN ? = 'FAILED_FINAL' THEN COALESCE(expires_at, ?) ELSE expires_at END, updated_at = ?
     WHERE id = ? AND status != 'DELIVERED'`
  ).bind(status, errorCode, status, now + config.ttlSeconds, now, attachmentId).run();
  if (result.meta.changes !== 1) throw new Error('Attachment failure state was not persisted');
  return status;
}

export async function recordStoredAttachmentError(env: Env, attachmentId: string, errorCode: SafeErrorCode): Promise<void> {
  await env.DB.prepare(
    `UPDATE attachments SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'STORED'`
  ).bind(errorCode, Math.floor(Date.now() / 1000), attachmentId).run();
}

export async function markAttachmentDelivered(
  env: Env,
  attachmentId: string,
  destinationMessageRef: string | undefined
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE attachments SET status = 'DELIVERED', destination_message_ref = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'STORED'`
  ).bind(destinationMessageRef || null, Math.floor(Date.now() / 1000), attachmentId).run();
  return result.meta.changes === 1;
}
