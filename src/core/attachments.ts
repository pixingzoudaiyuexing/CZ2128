import { ATTACHMENT_TOKEN_BYTES } from '../config/attachments';

export type AttachmentProvider = 'telegram' | 'chatwoot';
export type AttachmentType = 'photo' | 'document' | 'video' | 'audio' | 'voice';
export type AttachmentStatus = 'PENDING' | 'FETCHING' | 'STORED' | 'DELIVERED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL';

export interface AttachmentDescriptor {
  sourceAttachmentRef: string;
  attachmentType: AttachmentType;
  originalFilename?: string;
  mimeType?: string;
  sizeBytes?: number;
  locator: { provider: 'telegram'; fileId: string } | { provider: 'chatwoot'; dataUrl: string };
  rejectionCode?: 'SOURCE_TOO_LARGE' | 'INVALID_METADATA';
}

export interface AttachmentRow {
  id: string;
  conversation_id: string;
  source_provider: AttachmentProvider;
  source_message_ref: string;
  source_attachment_ref: string;
  attachment_type: AttachmentType;
  original_filename: string;
  safe_filename: string;
  mime_type: string;
  size_bytes: number | null;
  storage_key: string;
  access_token_hash: string;
  status: AttachmentStatus;
  destination_provider: AttachmentProvider;
  destination_message_ref: string | null;
  attempt_count: number;
  expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export async function stableAttachmentId(
  provider: AttachmentProvider,
  sourceMessageRef: string,
  sourceAttachmentRef: string
): Promise<string> {
  const input = JSON.stringify([provider, sourceMessageRef, sourceAttachmentRef]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `att_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function generateAttachmentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ATTACHMENT_TOKEN_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isValidAttachmentToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function hashAttachmentToken(token: string): Promise<string> {
  if (!isValidAttachmentToken(token)) throw new Error('Invalid attachment token');
  const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '=';
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sanitizeFilename(value: string | undefined, type: AttachmentType): { original: string; safe: string } {
  const fallback = type === 'photo' ? 'photo.jpg' : `${type}.bin`;
  const originalValue = value && value.length > 0 ? value : fallback;
  const original = Array.from(originalValue).slice(0, 512).join('');
  const normalized = original
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const limited = Array.from(normalized || fallback).slice(0, 180).join('');
  return { original, safe: limited || fallback };
}

export function normalizeMime(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || '';
  return normalized.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment.bin';
  const encoded = Array.from(new TextEncoder().encode(filename), byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface ParsedRange {
  offset: number;
  length: number;
  contentRange: string;
}

export function parseSingleRange(header: string, size: number): ParsedRange | null {
  if (!/^bytes=/.test(header) || header.includes(',') || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { offset: start, length: end - start + 1, contentRange: `bytes ${start}-${end}/${size}` };
}
