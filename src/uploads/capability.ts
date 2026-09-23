import { hashAttachmentToken, isValidAttachmentToken } from '../core/attachments';

const encoder = new TextEncoder();

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('UPLOAD_CAPABILITY_SECRET_INVALID');
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error('UPLOAD_CAPABILITY_SECRET_INVALID');
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function hmac(secret: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(decodeBase64Url(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`cz2128:${purpose}`));
  return encodeBase64Url(new Uint8Array(signature));
}

async function stableHex(parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function stableUploadInviteId(
  conversationId: string,
  supportProfileVersion: number,
  updateRef: string
): Promise<string> {
  return `uplinv_${await stableHex([conversationId, supportProfileVersion, updateRef])}`;
}

export async function deriveUploadInviteToken(secret: string, inviteId: string): Promise<string> {
  return hmac(secret, `upload-invite:v1:${inviteId}`);
}

export async function deriveUploadDownloadToken(
  secret: string,
  inviteId: string,
  uploadId: string
): Promise<string> {
  return hmac(secret, `upload-download:v1:${inviteId}:${uploadId}`);
}

export async function hashUploadCapability(token: string): Promise<string> {
  if (!isValidAttachmentToken(token)) throw new Error('UPLOAD_CAPABILITY_TOKEN_INVALID');
  return hashAttachmentToken(token);
}
