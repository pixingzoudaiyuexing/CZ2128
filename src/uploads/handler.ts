import { fetchCrispConversationState } from '../adapters/crisp/api';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { getUploadConfig } from '../config/uploads';
import {
  claimAttachment,
  discoverAttachment,
  getAttachment,
  markAttachmentFailure,
  markAttachmentStored
} from '../core/attachment-repository';
import {
  AttachmentDescriptor,
  AttachmentRow,
  normalizeMime
} from '../core/attachments';
import { AttachmentTransferEvent } from '../core/events';
import {
  AttachmentProcessingError,
  storeAttachmentStream
} from '../attachments/source';
import {
  deriveUploadDownloadToken,
  hashUploadCapability
} from './capability';
import {
  acceptUploadItem,
  claimUploadItem,
  expireUploadInvite,
  getUploadInviteByTokenHash,
  getUploadItem,
  rejectUploadItem,
  UploadInviteRow
} from './repository';
import { canonicalUploadOrigin } from './service';

const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKED_EXTENSIONS = new Set([
  'html', 'htm', 'svg', 'js', 'mjs', 'cjs', 'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'bash', 'zsh'
]);
const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-sh'
]);

interface BoundConversation {
  id: string;
  helpdesk_provider: string;
  helpdesk_account_ref: string | null;
  helpdesk_conversation_ref: string | null;
  operator_channel: string;
  operator_thread_ref: string | null;
  operator_thread_status: string | null;
}

function noStoreHeaders(contentType?: string): Headers {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: noStoreHeaders('text/plain; charset=utf-8') });
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: noStoreHeaders('application/json; charset=utf-8')
  });
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function uploadPage(invite: UploadInviteRow): Response {
  const nonce = randomNonce();
  const remaining = Math.max(0, invite.max_files - invite.consumed_files);
  const script = [
    "const input=document.getElementById('files');",
    "const status=document.getElementById('status');",
    "document.getElementById('send').addEventListener('click',async()=>{",
    " const files=Array.from(input.files||[]);",
    " if(!files.length){status.textContent='请选择文件。';return;}",
    " status.textContent='上传中…';",
    " for(const file of files){",
    "  const id=crypto.randomUUID();",
    "  const res=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-CZ2128-Upload-Id':id,'X-CZ2128-Filename':encodeURIComponent(file.name)},body:file});",
    "  if(!res.ok){status.textContent='上传失败：HTTP '+res.status;return;}",
    " }",
    " status.textContent='上传完成，客服已收到通知。';input.value='';",
    "});"
  ].join('');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>临时文件上传</title></head><body><main><h1>临时文件上传</h1><p>仅用于当前客服会话。请上传普通文件，不要上传图片或可执行/网页脚本文件。</p><p>本入口最多还可接受 ' + remaining + ' 个文件。</p><input id="files" type="file" multiple><button id="send" type="button">上传</button><p id="status" aria-live="polite"></p></main><script nonce="' + nonce + '">' + script + '</script></body></html>';
  const headers = noStoreHeaders('text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'nonce-" + nonce + "'; connect-src 'self'; style-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  return new Response(html, { status: 200, headers });
}

function decodedFilename(request: Request): string | null {
  const raw = request.headers.get('X-CZ2128-Filename');
  if (!raw || raw.length > 1536) return null;
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || Array.from(decoded).length > 512) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isBlockedUpload(filename: string, mimeType: string): boolean {
  if (mimeType.startsWith('image/')) return true;
  if (BLOCKED_MIME_TYPES.has(mimeType)) return true;
  const dot = filename.lastIndexOf('.');
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return !!extension && BLOCKED_EXTENSIONS.has(extension);
}

async function boundConversation(env: Env, invite: UploadInviteRow): Promise<BoundConversation | null> {
  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
    .bind(invite.conversation_id).first<BoundConversation>();
  if (!conversation) return null;
  const currentProfileVersion = env.runtimeConfigSnapshot?.versions.TELEGRAM_SUPPORT_PROFILE ?? 0;
  if (
    conversation.helpdesk_provider !== 'crisp' ||
    conversation.helpdesk_account_ref !== invite.crisp_website_ref ||
    conversation.helpdesk_conversation_ref !== invite.crisp_session_ref ||
    conversation.operator_channel !== 'telegram' ||
    conversation.operator_thread_ref !== invite.telegram_thread_ref ||
    conversation.operator_thread_status !== 'OPEN' ||
    env.BOT_GROUP_ID !== invite.telegram_group_ref ||
    currentProfileVersion !== invite.support_profile_version
  ) return null;
  return conversation;
}

async function enqueueStoredUpload(
  env: Env,
  row: AttachmentRow,
  invite: UploadInviteRow,
  uploadId: string,
  accessToken: string,
  publicOrigin: string
): Promise<void> {
  const event: AttachmentTransferEvent = {
    version: 1,
    source: 'internal',
    type: 'attachment_transfer',
    eventId: 'attachment:' + row.id,
    payload: {
      attachmentId: row.id,
      accessToken,
      locator: { provider: 'upload', inviteId: invite.id, uploadId },
      publicOrigin
    }
  };
  await env.QUEUE.send(event);
}

async function resumeAcceptedUpload(
  env: Env,
  row: AttachmentRow,
  invite: UploadInviteRow,
  uploadId: string,
  accessToken: string,
  publicOrigin: string,
  expectedSize: number | null
): Promise<Response> {
  const config = getAttachmentConfig(env);
  let current = row;
  if (current.status === 'DELIVERED') return json(200, { ok: true, upload_id: uploadId, state: 'delivered' });
  if (current.status === 'FAILED_FINAL') return json(409, { ok: false, code: 'UPLOAD_FINAL' });
  if (current.status === 'PENDING') {
    const claim = await claimAttachment(env, current.id);
    if (claim.outcome === 'CLAIMED') current = claim.row;
    else if (claim.row) current = claim.row;
  }
  if (current.status === 'FETCHING') {
    let metadata: R2Object | null = null;
    try {
      metadata = await env.ATTACHMENTS_BUCKET.head(current.storage_key);
    } catch {
      return json(503, { ok: false, code: 'UPLOAD_STORAGE_UNAVAILABLE' });
    }
    if (!metadata || metadata.size < 1 || metadata.size > config.maxBytes) {
      return json(409, { ok: false, code: 'UPLOAD_STORAGE_INVALID' });
    }
    if (expectedSize !== null && metadata.size !== expectedSize) {
      return json(409, { ok: false, code: 'UPLOAD_STORAGE_MISMATCH' });
    }
    const stored = await markAttachmentStored(env, current.id, metadata.size, config);
    if (!stored) return json(409, { ok: false, code: 'UPLOAD_STATE_CONFLICT' });
    current = { ...current, status: 'STORED', size_bytes: metadata.size };
  }
  if (current.status !== 'STORED') return json(409, { ok: false, code: 'UPLOAD_STATE_CONFLICT' });
  await enqueueStoredUpload(env, current, invite, uploadId, accessToken, publicOrigin);
  return json(202, { ok: true, upload_id: uploadId, state: 'queued' });
}

export async function handleUploadCapabilityRequest(
  request: Request,
  env: Env,
  token: string
): Promise<Response> {
  let tokenHash: string;
  try {
    tokenHash = await hashUploadCapability(token);
  } catch {
    return notFound();
  }
  let invite = await getUploadInviteByTokenHash(env, tokenHash);
  if (!invite) return notFound();

  const now = Math.floor(Date.now() / 1000);
  if (invite.status === 'ACTIVE' && invite.expires_at <= now) {
    await expireUploadInvite(env, invite.id, now);
    invite = { ...invite, status: 'EXPIRED' };
  }
  const conversation = await boundConversation(env, invite);
  if (!conversation) return notFound();

  if (request.method === 'GET') {
    return invite.status === 'ACTIVE' ? uploadPage(invite) : notFound();
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: noStoreHeaders('text/plain; charset=utf-8')
    });
  }

  const uploadId = request.headers.get('X-CZ2128-Upload-Id') || '';
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return json(400, { ok: false, code: 'UPLOAD_METADATA_INVALID' });
  }
  const secret = env.UPLOAD_CAPABILITY_SECRET || '';
  let accessToken: string;
  try {
    accessToken = await deriveUploadDownloadToken(secret, invite.id, uploadId);
  } catch {
    return json(503, { ok: false, code: 'UPLOAD_UNAVAILABLE' });
  }
  const publicOrigin = canonicalUploadOrigin(new URL(request.url).origin);

  const existingItem = await getUploadItem(env, invite.id, uploadId);
  if (existingItem?.status === 'ACCEPTED') {
    const existingRow = await getAttachment(env, existingItem.attachment_id);
    if (!existingRow) return json(409, { ok: false, code: 'UPLOAD_STATE_CONFLICT' });
    return resumeAcceptedUpload(
      env, existingRow, invite, uploadId, accessToken, publicOrigin, existingItem.size_bytes
    );
  }
  if (existingItem?.status === 'REJECTED') return json(409, { ok: false, code: 'UPLOAD_REJECTED' });
  if (invite.status !== 'ACTIVE') return notFound();

  const authoritativeState = await fetchCrispConversationState(
    env,
    invite.crisp_website_ref,
    invite.crisp_session_ref
  );
  if (authoritativeState === 'resolved') return json(409, { ok: false, code: 'CONVERSATION_RESOLVED' });

  const filename = decodedFilename(request);
  if (!filename || !request.body) {
    return json(400, { ok: false, code: 'UPLOAD_METADATA_INVALID' });
  }

  const mimeType = normalizeMime(request.headers.get('Content-Type') || undefined);
  if (isBlockedUpload(filename, mimeType)) {
    return json(415, { ok: false, code: 'UPLOAD_FILE_TYPE_BLOCKED' });
  }

  const attachmentConfig = getAttachmentConfig(env);
  const uploadConfig = getUploadConfig(attachmentConfig);
  const declaredLengthRaw = request.headers.get('Content-Length');
  if (declaredLengthRaw && /^\d+$/.test(declaredLengthRaw)) {
    const declaredLength = Number(declaredLengthRaw);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > attachmentConfig.maxBytes) {
      return json(413, { ok: false, code: 'UPLOAD_TOO_LARGE' });
    }
  }

  const descriptor: AttachmentDescriptor = {
    sourceAttachmentRef: uploadId,
    attachmentType: 'document',
    originalFilename: filename,
    mimeType,
    locator: { provider: 'upload', inviteId: invite.id, uploadId }
  };
  const discovered = await discoverAttachment(
    env,
    attachmentConfig,
    invite.conversation_id,
    'upload',
    invite.id,
    descriptor,
    'telegram',
    publicOrigin,
    accessToken
  );
  if (discovered.row.status === 'DELIVERED') {
    return json(200, { ok: true, upload_id: uploadId, state: 'delivered' });
  }
  if (discovered.row.status === 'FAILED_FINAL') {
    return json(409, { ok: false, code: 'UPLOAD_FINAL' });
  }

  const itemClaim = await claimUploadItem(
    env,
    invite.id,
    uploadId,
    discovered.row.id,
    uploadConfig.itemLeaseSeconds
  );
  if (itemClaim.outcome === 'ACCEPTED') {
    const row = await getAttachment(env, itemClaim.item.attachment_id);
    if (!row) return json(409, { ok: false, code: 'UPLOAD_STATE_CONFLICT' });
    return resumeAcceptedUpload(
      env, row, invite, uploadId, accessToken, publicOrigin, itemClaim.item.size_bytes
    );
  }
  if (itemClaim.outcome === 'BUSY') return json(409, { ok: false, code: 'UPLOAD_IN_PROGRESS' });
  if (itemClaim.outcome === 'REJECTED') return json(409, { ok: false, code: 'UPLOAD_REJECTED' });
  if (itemClaim.outcome === 'INVITE_UNAVAILABLE') return notFound();

  const attachmentClaim = await claimAttachment(env, discovered.row.id);
  if (attachmentClaim.outcome !== 'CLAIMED') {
    await rejectUploadItem(env, invite.id, uploadId, itemClaim.leaseToken);
    return json(409, { ok: false, code: 'UPLOAD_STATE_CONFLICT' });
  }

  const row = attachmentClaim.row;
  let size = 0;
  try {
    size = await storeAttachmentStream(
      env.ATTACHMENTS_BUCKET,
      row,
      request.body,
      attachmentConfig.maxBytes
    );
  } catch (error) {
    await rejectUploadItem(env, invite.id, uploadId, itemClaim.leaseToken);
    if (error instanceof AttachmentProcessingError) {
      await markAttachmentFailure(env, row.id, false, error.code, attachmentConfig);
      return json(error.code === 'ATTACHMENT_SOURCE_TOO_LARGE' ? 413 : 400, {
        ok: false,
        code: error.code
      });
    }
    await markAttachmentFailure(env, row.id, false, 'ATTACHMENT_SOURCE_INVALID', attachmentConfig);
    return json(400, { ok: false, code: 'UPLOAD_FAILED' });
  }

  const accepted = await acceptUploadItem(env, invite.id, uploadId, itemClaim.leaseToken, size);
  if (accepted !== 'ACCEPTED') {
    await rejectUploadItem(env, invite.id, uploadId, itemClaim.leaseToken);
    try { await env.ATTACHMENTS_BUCKET.delete(row.storage_key); } catch { /* cleanup will retry by TTL */ }
    await markAttachmentFailure(
      env, row.id, false, 'UPLOAD_INVITE_LIMIT_EXCEEDED', attachmentConfig
    );
    return json(409, { ok: false, code: 'UPLOAD_INVITE_LIMIT_EXCEEDED' });
  }

  const stored = await markAttachmentStored(env, row.id, size, attachmentConfig);
  if (!stored) return json(503, { ok: false, code: 'UPLOAD_PERSIST_RETRY' });
  await enqueueStoredUpload(
    env,
    { ...row, status: 'STORED', size_bytes: size },
    invite,
    uploadId,
    accessToken,
    publicOrigin
  );
  return json(202, { ok: true, upload_id: uploadId, state: 'queued' });
}
