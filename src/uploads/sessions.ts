import { Env } from '../config/env';
import { Conversation } from '../core/domain';
import { AttachmentRow, hashAttachmentToken } from '../core/attachments';
import { discoverAttachment, markAttachmentStored } from '../core/attachment-repository';
import { getAttachmentConfig } from '../config/attachments';
import { telegramCustomerRequestOptions } from '../config/telegram-customer-ux';
import { trustedPublicOrigin } from '../config/public-origin';
import { fetchCrispConversationState } from '../adapters/crisp/api';
import { deriveUploadDownloadToken, deriveUploadSessionToken, hashUploadCapability } from './capability';
import { getUploadInviteById, UploadInviteRow } from './repository';
import { AttachmentContentCheckpoint, AttachmentContentInspector, inspectStoredAttachment, StoredAttachmentInspection, verifiedPartStream } from '../attachments/content';
import { CheckpointSha256, Sha256Checkpoint } from '../core/sha256-checkpoint';
import { ensureAttachmentGrant } from '../attachments/grants';
import { uploadPage } from './page';
import { crispIdentityRequestOptions, crispOperatorIdentity } from '../config/crisp-identities';
import { cleanupUploadSubparts, handleUploadSubpart, listUploadSubparts } from './subparts';
import { queueUploadTask, redriveUploadWork } from './async-work';

const SESSION_SECONDS = 24 * 3600;
const MIN_PART = 8 * 1024 * 1024;
const MAX_REQUEST_PART = 64 * 1024 * 1024;
const R2_MAX_OBJECT_BYTES = 5 * 1024 ** 4;
const VERIFY_RANGE_BYTES=16*1024*1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
type SessionState = 'INITIALIZING' | 'UPLOADING' | 'COMPLETING' | 'VERIFYING' | 'STORED' | 'QUEUED' | 'DELIVERED' | 'AMBIGUOUS' | 'ABORTING' | 'ABORTED' | 'FAILED';
export interface UploadSession {
  id: string; invite_id: string; attachment_id: string; token_hash: string; size_bytes: number;
  part_size: number; part_count: number; r2_upload_id: string | null; status: SessionState;
  expected_sha256: string | null; expires_at: number; lease_token: string | null; lease_until: number | null;
  verification_json: string | null;
  async_mode: number;
  last_error: string | null; created_at: number; updated_at: number;
}
interface Part { part_number: number; size_bytes: number; sha256: string; etag: string | null; status: string; lease_token: string; lease_until: number }
const now = () => Math.floor(Date.now() / 1000);
export function uploadJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
const error = (code: string, status = 409) => uploadJson({ ok: false, code }, status);
async function metadata(request: Request): Promise<any | null> {
  const reader=request.body?.getReader();if(!reader)return null;
  const bytes=new Uint8Array(4096);let used=0;
  try {
    while(true){const chunk=await reader.read();if(chunk.done)break;
      if(used+chunk.value.length>bytes.length){await reader.cancel();return null;}
      bytes.set(chunk.value,used);used+=chunk.value.length;}
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0,used)));
  } catch{return null;} finally{reader.releaseLock();}
}
async function sessionById(env: Env, id: string) { return env.DB.prepare('SELECT * FROM attachment_upload_sessions WHERE id=?').bind(id).first<UploadSession>(); }
async function attachment(env: Env, id: string) { return env.DB.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first<AttachmentRow>(); }
async function parts(env: Env, id: string, number?:number) {
  const query=env.DB.prepare('SELECT * FROM attachment_upload_parts WHERE session_id=?'+(number?' AND part_number=?':'')+' ORDER BY part_number');
  return (await (number?query.bind(id,number):query.bind(id)).all<Part>()).results;
}

export async function uploadBoundConversation(env: Env, invite: UploadInviteRow): Promise<Conversation | null> {
  const row = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(invite.conversation_id).first<Conversation>();
  if (!row || row.helpdesk_provider !== 'crisp' || row.helpdesk_account_ref !== invite.crisp_website_ref ||
      row.helpdesk_conversation_ref !== invite.crisp_session_ref || row.operator_channel !== 'telegram' ||
      row.operator_thread_ref !== invite.telegram_thread_ref || row.operator_thread_status !== 'OPEN' ||
      env.BOT_GROUP_ID !== invite.telegram_group_ref ||
      (env.runtimeConfigSnapshot?.versions.TELEGRAM_SUPPORT_PROFILE ?? 0) !== invite.support_profile_version) return null;
  return row;
}

async function throttle(env: Env, invite: UploadInviteRow): Promise<boolean> {
  const minute = Math.floor(now() / 60);
  // A temporal request budget prevents replay/denial of wallet, not a file/count quota.
  const r = await env.DB.prepare(`INSERT INTO attachment_upload_requests(invite_id,minute_bucket,requests)
    VALUES(?,?,1) ON CONFLICT(invite_id,minute_bucket) DO UPDATE SET requests=requests+1 WHERE requests<120`)
    .bind(invite.id, minute).run();
  return r.meta.changes === 1;
}

async function authoritativeOpen(env: Env, conv: Conversation): Promise<boolean> {
  return await fetchCrispConversationState(env, conv.helpdesk_account_ref, conv.helpdesk_conversation_ref) !== 'resolved';
}

export async function initializeUploadSession(request: Request, env: Env, invite: UploadInviteRow): Promise<Response> {
  if (invite.status !== 'ACTIVE' || invite.expires_at <= now()) return error('UPLOAD_INVITE_EXPIRED_OR_REVOKED', 410);
  const conv = await uploadBoundConversation(env, invite);
  if (!conv || !await authoritativeOpen(env, conv)) return error('CONVERSATION_UNAVAILABLE', 410);
  if (!await throttle(env, invite)) return error('UPLOAD_RATE_LIMITED', 429);
  if (Number(request.headers.get('Content-Length') || 0) > 4096) return error('UPLOAD_METADATA_INVALID', 400);
  const input = await metadata(request);
  if(!input || typeof input!=='object' || Array.isArray(input))return error('UPLOAD_METADATA_INVALID',400);
  if (!UUID.test(input.id || '') || typeof input.filename !== 'string' || input.filename.length < 1 || input.filename.length > 512 ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) return error('UPLOAD_METADATA_INVALID', 400);
  const existing = await sessionById(env, input.id);
  if (existing) {
    if (existing.invite_id !== invite.id || existing.size_bytes !== input.sizeBytes) return error('UPLOAD_ID_CONFLICT');
    const row = await attachment(env, existing.attachment_id);
    if (row?.original_filename !== input.filename) return error('UPLOAD_ID_CONFLICT');
    if (existing.async_mode) await redriveUploadWork(env,existing);
    else if (row) await startMultipart(env,existing,row);
    return uploadJson(await sessionResponse(env, (await sessionById(env,existing.id))!),existing.async_mode?202:200);
  }
  // R2 accepts at most 10,000 parts. Adapt transport size without a product file quota.
  const partSize = Math.max(MIN_PART, Math.ceil(input.sizeBytes / 10000 / (1024 * 1024)) * 1024 * 1024);
  if (input.sizeBytes > R2_MAX_OBJECT_BYTES) return error('R2_OBJECT_LIMIT_5_TIB', 422);
  const active = await env.DB.prepare(`SELECT COUNT(*) AS count FROM attachment_upload_sessions
    WHERE invite_id=? AND status IN ('INITIALIZING','UPLOADING','COMPLETING','VERIFYING') AND expires_at>?`).bind(invite.id, now()).first<{ count: number }>();
  if ((active?.count || 0) >= 3) return error('UPLOAD_CONCURRENT_SESSIONS_BUSY', 429);
  const downloadToken = await deriveUploadDownloadToken(env.UPLOAD_CAPABILITY_SECRET || '', invite.id, input.id);
  const discovered = await discoverAttachment(env, getAttachmentConfig(env), conv.id, 'upload', invite.id,
    { sourceAttachmentRef: input.id, attachmentType: 'document', originalFilename: input.filename,
      mimeType: 'application/octet-stream', sizeBytes: input.sizeBytes,
      locator: { provider: 'upload', inviteId: invite.id, uploadId: input.id } },
    invite.upload_role === 'OPERATOR' ? 'crisp' : 'telegram', trustedPublicOrigin(env), downloadToken,
    invite.upload_role === 'OPERATOR' ? JSON.stringify(crispIdentityRequestOptions(crispOperatorIdentity(env)))
      : JSON.stringify(telegramCustomerRequestOptions(env, conv, false)));
  if(discovered.row.original_filename!==input.filename || discovered.row.declared_size_bytes!==input.sizeBytes) return error('UPLOAD_ID_CONFLICT');
  const token = await deriveUploadSessionToken(env.UPLOAD_CAPABILITY_SECRET || '', input.id);
  await env.DB.prepare(`INSERT INTO attachment_upload_sessions
    (id,invite_id,attachment_id,token_hash,size_bytes,part_size,part_count,status,expires_at,created_at,updated_at,async_mode)
    SELECT ?,?,?,?,?,?,?,'INITIALIZING',?,?,?,? WHERE
      (SELECT COUNT(*) FROM attachment_upload_sessions WHERE invite_id=? AND status IN ('INITIALIZING','UPLOADING','COMPLETING','VERIFYING') AND expires_at>?)<3
    ON CONFLICT(id) DO NOTHING`)
    .bind(input.id, invite.id, discovered.row.id, await hashUploadCapability(token), input.sizeBytes,
      partSize, Math.ceil(input.sizeBytes / partSize), now() + SESSION_SECONDS, now(), now(),input.async===true?1:0,invite.id,now()).run();
  const session = await sessionById(env, input.id);
  if(!session)return error('UPLOAD_CONCURRENT_SESSIONS_BUSY',429);
  if (session.invite_id !== invite.id || session.size_bytes!==input.sizeBytes || session.attachment_id!==discovered.row.id) return error('UPLOAD_ID_CONFLICT');
  if(session.async_mode)await redriveUploadWork(env,session);
  else await startMultipart(env, session, discovered.row);
  return uploadJson(await sessionResponse(env, (await sessionById(env, input.id))!),session.async_mode?202:200);
}

async function startMultipart(env: Env, session: UploadSession, row: AttachmentRow): Promise<void> {
  if (session.r2_upload_id || session.status !== 'INITIALIZING') return;
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE attachment_upload_sessions SET lease_token=?,lease_until=?,updated_at=?
    WHERE id=? AND status='INITIALIZING' AND COALESCE(lease_until,0)<=?`).bind(lease, now()+120, now(), session.id, now()).run();
  if (claim.meta.changes !== 1) return;
  let upload: R2MultipartUpload | undefined;
  try {
    upload = await env.ATTACHMENTS_BUCKET.createMultipartUpload(row.storage_key,
      { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { attachmentId: row.id } });
    const saved = await env.DB.prepare(`UPDATE attachment_upload_sessions SET r2_upload_id=?,status='UPLOADING',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND status='INITIALIZING' AND lease_token=? AND expires_at>? AND EXISTS(
        SELECT 1 FROM upload_invites i JOIN conversations c ON c.id=i.conversation_id WHERE i.id=invite_id AND i.status!='REVOKED'
        AND c.helpdesk_provider='crisp' AND c.helpdesk_account_ref=i.crisp_website_ref AND c.helpdesk_conversation_ref=i.crisp_session_ref
        AND c.operator_thread_status='OPEN' AND c.operator_thread_ref=i.telegram_thread_ref
        AND i.telegram_group_ref=? AND i.support_profile_version=COALESCE((SELECT version FROM runtime_config WHERE key='TELEGRAM_SUPPORT_PROFILE'),0))`)
      .bind(upload.uploadId, now(), session.id, lease,now(),env.BOT_GROUP_ID).run();
    if (saved.meta.changes !== 1) await upload.abort();
  } catch (e) {
    if (upload) { try { await upload.abort(); } catch { /* Bucket abort lifecycle is the orphan fallback. */ } }
    await env.DB.prepare(`UPDATE attachment_upload_sessions SET lease_until=0 WHERE id=? AND status='INITIALIZING' AND lease_token=?`)
      .bind(session.id,lease).run();
    throw e;
  }
}

async function sessionResponse(env: Env, session: UploadSession, partNumber=1): Promise<Record<string, unknown>> {
  const row = await attachment(env, session.attachment_id);
  const list = await parts(env, session.id,session.async_mode?partNumber:undefined);
  let state: string = session.async_mode&&session.status==='COMPLETING'?'VERIFYING':session.status;
  const operation = await env.DB.prepare('SELECT status FROM outbound_operations WHERE id=?')
    .bind(`attachment_${row?.destination_provider}:${session.attachment_id}`).first<{ status: string }>();
  if (row?.status === 'DELIVERED') state = 'DELIVERED';
  else if (operation?.status === 'AMBIGUOUS') state = 'AMBIGUOUS';
  else if (row?.status==='FAILED_FINAL' || operation?.status==='FAILED_FINAL') state='FAILED';
  else if (operation?.status==='FAILED_RETRYABLE') state='QUEUED';
  const stored = row?.stored_at && !row.deleted_at && (row.retention_expires_at || 0)>now();
  const grant = stored ? await ensureAttachmentGrant(env, row!) : null;
  return { sessionId: session.id, token: await deriveUploadSessionToken(env.UPLOAD_CAPABILITY_SECRET || '', session.id),
    filename: row?.original_filename, state, sizeBytes: session.size_bytes, partSize: session.part_size, partCount: session.part_count,
    parts: list.filter(p=>p.status==='STORED').map(p=>({number:p.part_number,sizeBytes:p.size_bytes,sha256:p.sha256})),
    ...(session.async_mode?{async:true,networkChunkSize:8*1024*1024,
      pendingParts:list.filter(p=>p.status==='WRITING').map(p=>({number:p.part_number,sizeBytes:p.size_bytes,sha256:p.sha256,state:'ASSEMBLING'}))}:{}),
    chunks: await listUploadSubparts(env,session.id,partNumber),
    ...(session.verification_json || session.async_mode&&['VERIFYING','COMPLETING'].includes(session.status)
      ? {verification:{verifiedBytes:session.verification_json?JSON.parse(session.verification_json).offset:0,totalBytes:session.size_bytes}} : {}),
    ...(stored ? { attachment: { state, sha256: row!.sha256, expiresAt: row!.retention_expires_at, url: grant?.url } } : {}),
    ...(session.last_error || row?.last_error ? { error: session.last_error || row?.last_error } : {}) };
}

async function putPart(request: Request, env: Env, session: UploadSession, number: number): Promise<Response> {
  if (session.status !== 'UPLOADING' || !session.r2_upload_id) return error('UPLOAD_NOT_WRITABLE');
  if (!Number.isInteger(number) || number < 1 || number > session.part_count) return error('UPLOAD_PART_INVALID',400);
  const length = number === session.part_count ? session.size_bytes - (number-1)*session.part_size : session.part_size;
  if(length>MAX_REQUEST_PART)return error('USE_SUBPART_UPLOAD',422);
  const hash = request.headers.get('X-Part-SHA256') || '';
  if (!SHA.test(hash) || Number(request.headers.get('Content-Length')) !== length) return error('UPLOAD_PART_INVALID',400);
  if (!request.body) return error('UPLOAD_PART_INVALID',400);
  const lease=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO attachment_upload_parts(session_id,part_number,size_bytes,sha256,status,lease_token,lease_until,updated_at)
    SELECT ?,?,?,?,'WRITING',?,?,? WHERE EXISTS(SELECT 1 FROM attachment_upload_sessions WHERE id=? AND status='UPLOADING')
    ON CONFLICT(session_id,part_number) DO NOTHING`).bind(session.id,number,length,hash,lease,now()+120,now(),session.id).run();
  const part=(await parts(env,session.id)).find(p=>p.part_number===number);
  if(!part || part.sha256!==hash || part.size_bytes!==length) return error('UPLOAD_PART_CONFLICT');
  if(part.status==='STORED') return uploadJson({ok:true,number,sha256:hash});
  if(part.lease_token!==lease) {
    const taken=await env.DB.prepare(`UPDATE attachment_upload_parts SET lease_token=?,lease_until=?,updated_at=?
      WHERE session_id=? AND part_number=? AND status='WRITING' AND lease_until<=?
      AND EXISTS(SELECT 1 FROM attachment_upload_sessions WHERE id=? AND status='UPLOADING')`)
      .bind(lease,now()+120,now(),session.id,number,now(),session.id).run();
    if(taken.meta.changes!==1) return error('UPLOAD_PART_BUSY',429);
  }
  const row=(await attachment(env,session.attachment_id))!;
  const stream=verifiedPartStream(request.body,length,hash);
  let uploaded: R2UploadedPart;
  try {
    [uploaded]=await Promise.all([
      env.ATTACHMENTS_BUCKET.resumeMultipartUpload(row.storage_key,session.r2_upload_id).uploadPart(number,stream.readable),stream.done
    ]);
  } catch (failure) {
    await stream.abort(failure);
    // Same fingerprint may retry immediately; a different part body never replaces it.
    await env.DB.prepare('UPDATE attachment_upload_parts SET lease_until=0 WHERE session_id=? AND part_number=? AND lease_token=?')
      .bind(session.id,number,lease).run();
    return error('UPLOAD_PART_CHECKSUM_OR_TRANSPORT_FAILURE',422);
  }
  const saved=await env.DB.prepare(`UPDATE attachment_upload_parts SET status='STORED',etag=?,updated_at=?
    WHERE session_id=? AND part_number=? AND lease_token=? AND sha256=?`)
    .bind(uploaded.etag,now(),session.id,number,lease,hash).run();
  if(saved.meta.changes!==1) return error('UPLOAD_PART_BUSY',429);
  return uploadJson({ok:true,number,sha256:hash});
}

export async function dispatchStoredUpload(env: Env, session: UploadSession): Promise<void> {
  const row=await attachment(env,session.attachment_id); if(!row || !row.stored_at) return;
  const operation=await env.DB.prepare('SELECT status FROM outbound_operations WHERE id=?')
    .bind(`attachment_${row.destination_provider}:${row.id}`).first<{status:string}>();
  const terminal=row.status==='DELIVERED'?'DELIVERED':operation?.status==='AMBIGUOUS'?'AMBIGUOUS':
    row.deleted_at || row.status==='FAILED_FINAL' || (row.retention_expires_at || 0)<=now()?'FAILED':null;
  if(terminal) {
    await env.DB.prepare("UPDATE attachment_upload_sessions SET status=?,updated_at=? WHERE id=? AND status IN ('STORED','QUEUED')")
      .bind(terminal,now(),session.id).run();return;
  }
  const invite=await getUploadInviteById(env,session.invite_id); if(!invite) throw new Error('UPLOAD_INVITE_MISSING');
  const accessToken=await deriveUploadDownloadToken(env.UPLOAD_CAPABILITY_SECRET || '',invite.id,session.id);
  await env.QUEUE.send({version:1,source:'internal',type:'attachment_transfer',eventId:`attachment:${row.id}`,
    payload:{attachmentId:row.id,accessToken,locator:{provider:'upload',inviteId:invite.id,uploadId:session.id},publicOrigin:trustedPublicOrigin(env)}});
  await env.DB.prepare("UPDATE attachment_upload_sessions SET status='QUEUED',updated_at=? WHERE id=? AND status IN ('STORED','QUEUED')").bind(now(),session.id).run();
}

async function complete(request: Request, env: Env, session: UploadSession, queued=false): Promise<Response> {
  if(['STORED','QUEUED','DELIVERED','AMBIGUOUS'].includes(session.status)) {
    await dispatchStoredUpload(env,session); return uploadJson(await sessionResponse(env,(await sessionById(env,session.id))!));
  }
  const input=await metadata(request);
  if(!input || !SHA.test(input.sha256 || '')) return error('UPLOAD_CHECKSUM_INVALID',400);
  if(session.expected_sha256 && session.expected_sha256!==input.sha256) return error('UPLOAD_CHECKSUM_CONFLICT');
  if(session.async_mode&&!queued) {
    const manifest=await env.DB.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes,
      COALESCE(SUM(CASE WHEN status='STORED' AND etag IS NOT NULL THEN 0 ELSE 1 END),0) AS pending
      FROM attachment_upload_parts WHERE session_id=?`).bind(session.id).first<{count:number;bytes:number;pending:number}>();
    if(!manifest||manifest.count!==session.part_count||manifest.bytes!==session.size_bytes||manifest.pending)return error('UPLOAD_PARTS_INCOMPLETE');
    const saved=await env.DB.prepare(`UPDATE attachment_upload_sessions SET status=CASE WHEN status='UPLOADING' THEN 'VERIFYING' ELSE status END,
      expected_sha256=?,updated_at=? WHERE id=? AND status IN ('UPLOADING','VERIFYING','COMPLETING')
      AND (expected_sha256 IS NULL OR expected_sha256=?)`).bind(input.sha256,now(),session.id,input.sha256).run();
    if(saved.meta.changes!==1)return error('UPLOAD_COMPLETION_BUSY',429);
    const current=(await sessionById(env,session.id))!;await redriveUploadWork(env,current);
    return uploadJson(await sessionResponse(env,current),202);
  }
  const list=await parts(env,session.id);
  if(list.length!==session.part_count || list.some((p,i)=>p.part_number!==i+1 || p.status!=='STORED' || !p.etag) ||
    list.reduce((n,p)=>n+p.size_bytes,0)!==session.size_bytes) return error('UPLOAD_PARTS_INCOMPLETE');
  const lease=crypto.randomUUID();
  const claim=await env.DB.prepare(`UPDATE attachment_upload_sessions SET status='COMPLETING',expected_sha256=?,lease_token=?,lease_until=?,updated_at=?
    WHERE id=? AND (status='UPLOADING' OR (status IN ('COMPLETING','VERIFYING') AND COALESCE(lease_until,0)<=?))
      AND (expected_sha256 IS NULL OR expected_sha256=?)`).bind(input.sha256,lease,now()+300,now(),session.id,now(),input.sha256).run();
  if(claim.meta.changes!==1) return error('UPLOAD_COMPLETION_BUSY',429);
  try {
  const row=(await attachment(env,session.attachment_id))!;
  const existing=await env.ATTACHMENTS_BUCKET.head(row.storage_key);
  if(!existing) {
    if(!session.r2_upload_id) return error('UPLOAD_NOT_READY');
    await env.ATTACHMENTS_BUCKET.resumeMultipartUpload(row.storage_key,session.r2_upload_id).complete(list.map(p=>({partNumber:p.part_number,etag:p.etag!})));
  }
  let inspected:StoredAttachmentInspection;
  if(!session.async_mode&&session.size_bytes<=64*1024*1024)inspected=await inspectStoredAttachment(env.ATTACHMENTS_BUCKET,row.storage_key);
  else {
    const progress=session.verification_json?JSON.parse(session.verification_json) as {offset:number;hash:Sha256Checkpoint;content:AttachmentContentCheckpoint}:null;
    const hash=new CheckpointSha256(progress?.hash);
    const parser=new AttachmentContentInspector(progress?.content);
    const offset=progress?.offset || 0;
    if(offset!==hash.snapshot().bytesTotal || offset!==parser.snapshot().sizeBytes || offset<0 || offset>=session.size_bytes) return error('UPLOAD_VERIFICATION_STATE_INVALID');
    const length=Math.min(VERIFY_RANGE_BYTES,session.size_bytes-offset);
    const object=await env.ATTACHMENTS_BUCKET.get(row.storage_key,{range:{offset,length}});
    if(!object?.body)throw new Error('UPLOAD_VERIFICATION_RETRY');
    const reader=object.body.getReader();let consumed=0;
    try{while(true){const chunk=await reader.read();if(chunk.done)break;consumed+=chunk.value.length;
      if(consumed>length)throw new Error('UPLOAD_VERIFICATION_LENGTH_MISMATCH');hash.update(chunk.value);parser.update(chunk.value);}}
    finally{reader.releaseLock();}
    if(consumed!==length)throw new Error('UPLOAD_VERIFICATION_RETRY');
    const next=offset+length;
    if(next<session.size_bytes){
      const saved=await env.DB.prepare(`UPDATE attachment_upload_sessions SET status='VERIFYING',verification_json=?,lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE id=? AND status='COMPLETING' AND lease_token=? AND expires_at>? AND EXISTS(SELECT 1 FROM upload_invites WHERE id=invite_id AND status!='REVOKED')`)
        .bind(JSON.stringify({offset:next,hash:hash.snapshot(),content:parser.snapshot()}),now(),session.id,lease,now()).run();
      if(saved.meta.changes!==1)return error('UPLOAD_AUTHORIZATION_CHANGED',410);
      return uploadJson(await sessionResponse(env,(await sessionById(env,session.id))!),202);
    }
    inspected={sizeBytes:next,sha256:hash.digest(),...parser.finish(next)};
  }
  if(inspected.sizeBytes!==session.size_bytes || inspected.sha256!==input.sha256) {
    await env.DB.prepare("UPDATE attachment_upload_sessions SET status='ABORTING',lease_until=0,lease_token=NULL,last_error='UPLOAD_CHECKSUM_MISMATCH',updated_at=? WHERE id=? AND lease_token=?")
      .bind(now(),session.id,lease).run();
    return error('UPLOAD_CHECKSUM_MISMATCH',422);
  }
  const current=await sessionById(env,session.id);
  const invite=(await getUploadInviteById(env,session.invite_id))!;
  const conv=await uploadBoundConversation(env,invite);
  if(current?.lease_token!==lease || current.status!=='COMPLETING' || current.expires_at<=now() ||
    invite.status==='REVOKED' || !conv || !await authoritativeOpen(env,conv)) return error('UPLOAD_AUTHORIZATION_CHANGED',410);
  const admittedAt=now();
  const config=getAttachmentConfig(env);
  const expiry=admittedAt+(inspected.retentionClass==='IMAGE'?config.imageTtlSeconds:config.fileTtlSeconds);
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE attachments SET status='STORED',size_bytes=?,stored_size_bytes=?,stored_at=?,
      retention_class=?,retention_expires_at=?,expires_at=?,sha256=?,mime_type=?,grant_expires_at=?,last_error=NULL,updated_at=?
      WHERE id=? AND stored_at IS NULL AND status IN ('PENDING','FETCHING') AND expires_at>?
        AND EXISTS(SELECT 1 FROM attachment_upload_sessions s JOIN upload_invites i ON i.id=s.invite_id
          JOIN conversations c ON c.id=i.conversation_id WHERE s.id=? AND s.status='COMPLETING' AND s.lease_token=?
          AND s.expires_at>? AND i.status!='REVOKED' AND c.helpdesk_provider='crisp'
          AND c.helpdesk_account_ref=i.crisp_website_ref AND c.helpdesk_conversation_ref=i.crisp_session_ref
          AND c.operator_thread_ref=i.telegram_thread_ref AND c.operator_thread_status='OPEN'
          AND i.telegram_group_ref=? AND i.support_profile_version=COALESCE((SELECT version FROM runtime_config WHERE key='TELEGRAM_SUPPORT_PROFILE'),0))`)
      .bind(inspected.sizeBytes<=20*1024*1024?inspected.sizeBytes:null,inspected.sizeBytes,admittedAt,
        inspected.retentionClass,expiry,expiry,inspected.sha256,inspected.mimeType,expiry,admittedAt,row.id,admittedAt,
        session.id,lease,admittedAt,env.BOT_GROUP_ID),
    env.DB.prepare(`UPDATE attachment_upload_sessions SET status='STORED',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND status='COMPLETING' AND lease_token=? AND EXISTS(SELECT 1 FROM attachments WHERE id=? AND stored_at IS NOT NULL)`)
      .bind(admittedAt,session.id,lease,row.id)
  ]);
  if(results[1]?.meta.changes!==1) return error('UPLOAD_AUTHORIZATION_CHANGED',410);
  await dispatchStoredUpload(env,(await sessionById(env,session.id))!);
  return uploadJson(await sessionResponse(env,(await sessionById(env,session.id))!),202);
  } catch(failure) {
    await env.DB.prepare(`UPDATE attachment_upload_sessions SET lease_until=0,last_error='UPLOAD_STORAGE_RETRY'
      WHERE id=? AND status='COMPLETING' AND lease_token=?`).bind(session.id,lease).run();
    throw failure;
  }
}

export async function initializeQueuedUpload(env:Env,session:UploadSession):Promise<void> {
  const invite=await getUploadInviteById(env,session.invite_id);
  const conv=invite?await uploadBoundConversation(env,invite):null;
  if(!conv||!await authoritativeOpen(env,conv)) {
    await env.DB.prepare("UPDATE attachment_upload_sessions SET status='ABORTING',lease_until=0 WHERE id=? AND status='INITIALIZING'").bind(session.id).run();
    await queueUploadTask(env,session.id,'ABORT');return;
  }
  const row=await attachment(env,session.attachment_id);if(!row)throw new Error('UPLOAD_ATTACHMENT_MISSING');
  await startMultipart(env,session,row);
}
export async function verifyQueuedUpload(env:Env,session:UploadSession):Promise<Response> {
  return complete(new Request('https://upload-work.internal/verify',{method:'POST',body:JSON.stringify({sha256:session.expected_sha256})}),env,session,true);
}

export async function handleUploadSession(request: Request, env: Env, token: string, action: string): Promise<Response> {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)) return error('UPLOAD_SESSION_UNAVAILABLE',404);
  const session=await env.DB.prepare('SELECT * FROM attachment_upload_sessions WHERE token_hash=?').bind(await hashAttachmentToken(token)).first<UploadSession>();
  if(!session) return error('UPLOAD_SESSION_UNAVAILABLE',404);
  const invite=await getUploadInviteById(env,session.invite_id);
  if(!invite || !await uploadBoundConversation(env,invite)) return error('UPLOAD_SESSION_UNAVAILABLE',404);
  const stored=['STORED','QUEUED','DELIVERED','AMBIGUOUS'].includes(session.status);
  if(session.expires_at<=now() || !stored && invite.status==='REVOKED') return error('UPLOAD_SESSION_EXPIRED_OR_REVOKED',410);
  if(request.method==='GET' && action==='page') return uploadPage();
  if(request.method==='GET' && action==='') {
    if(session.async_mode)await redriveUploadWork(env,session);
    else if(session.status==='INITIALIZING') {
      const row=await attachment(env,session.attachment_id);if(row)await startMultipart(env,session,row);
    }
    const part=Number(new URL(request.url).searchParams.get('part') || '1');
    if(!Number.isInteger(part)||part<1||part>session.part_count)return error('UPLOAD_PART_INVALID',400);
    return uploadJson(await sessionResponse(env,(await sessionById(env,session.id))!,part));
  }
  if(!await throttle(env,invite)) return error('UPLOAD_RATE_LIMITED',429);
  if(request.method==='DELETE' && !stored) {
    await env.DB.prepare("UPDATE attachment_upload_sessions SET status='ABORTING',updated_at=? WHERE id=? AND status NOT IN ('STORED','QUEUED','DELIVERED','AMBIGUOUS')").bind(now(),session.id).run();
    if(session.async_mode)await queueUploadTask(env,session.id,'ABORT');
    else await cleanupUploadSessions(env,session.id);
    return uploadJson({state:(await sessionById(env,session.id))?.status || 'ABORTING'});
  }
  if(request.method==='POST' && action==='complete') {
    try{return await complete(request,env,session);}catch{
      await env.DB.prepare("UPDATE attachment_upload_sessions SET lease_until=0,last_error='UPLOAD_STORAGE_RETRY' WHERE id=? AND status='COMPLETING'").bind(session.id).run();
      return error('UPLOAD_STORAGE_RETRY',503);
    }
  }
  if(request.method==='POST' && action==='dispatch' && stored) {await dispatchStoredUpload(env,session);return uploadJson(await sessionResponse(env,session));}
  const match=/^parts\/(\d{1,5})$/.exec(action);
  if(/^parts\/\d{1,5}\/(?:chunks\/\d{1,3}|assemble)$/.test(action))return handleUploadSubpart(request,env,session,action);
  if(request.method==='PUT' && match) return session.async_mode?error('USE_SUBPART_UPLOAD',422):putPart(request,env,session,Number(match[1]));
  return error('UPLOAD_ACTION_INVALID',405);
}

export async function listInviteFiles(env: Env, invite: UploadInviteRow): Promise<Response> {
  if(invite.status!=='ACTIVE' || invite.expires_at<=now()) return error('UPLOAD_INVITE_EXPIRED_OR_REVOKED',410);
  const rows=await env.DB.prepare(`SELECT a.*,s.status AS session_status FROM attachment_upload_sessions s JOIN attachments a ON a.id=s.attachment_id
    WHERE s.invite_id=? AND a.stored_at IS NOT NULL AND a.deleted_at IS NULL AND a.retention_expires_at>? ORDER BY a.stored_at DESC LIMIT 100`)
    .bind(invite.id,now()).all<AttachmentRow & {session_status:string}>();
  return uploadJson({files:await Promise.all(rows.results.map(async row=>({filename:row.safe_filename,sizeBytes:row.stored_size_bytes,
    state:row.status==='DELIVERED'?'DELIVERED':row.session_status,expiresAt:row.retention_expires_at,sha256:row.sha256,url:(await ensureAttachmentGrant(env,row)).url})))});
}

export async function cleanupUploadSessions(env: Env, onlyId?: string): Promise<void> {
  const rows=await env.DB.prepare(`SELECT s.* FROM attachment_upload_sessions s JOIN upload_invites i ON i.id=s.invite_id
    WHERE (? IS NULL OR s.id=?) AND (s.status='ABORTING' OR (s.status IN ('INITIALIZING','UPLOADING','COMPLETING','VERIFYING') AND (s.expires_at<=? OR i.status='REVOKED')))
    ORDER BY s.updated_at LIMIT 50`).bind(onlyId || null,onlyId || null,now()).all<UploadSession>();
  for(const session of rows.results) {
    const lease=crypto.randomUUID();
    const claimed=await env.DB.prepare(`UPDATE attachment_upload_sessions SET status='ABORTING',lease_token=?,lease_until=?,updated_at=?
      WHERE id=? AND NOT EXISTS(SELECT 1 FROM attachments WHERE id=attachment_id AND stored_at IS NOT NULL)
      AND ((status='ABORTING' AND COALESCE(lease_until,0)<=?) OR
        (status IN ('INITIALIZING','UPLOADING','COMPLETING','VERIFYING') AND
          (expires_at<=? OR EXISTS(SELECT 1 FROM upload_invites WHERE id=invite_id AND status='REVOKED'))))`)
      .bind(lease,now()+120,now(),session.id,now(),now()).run();
    if(claimed.meta.changes!==1) continue;
    const row=await attachment(env,session.attachment_id);if(!row || row.stored_at) continue;
    try {
      if(session.r2_upload_id) {try {await env.ATTACHMENTS_BUCKET.resumeMultipartUpload(row.storage_key,session.r2_upload_id).abort();} catch (failure) {
        // Complete may have succeeded before persistence failed; delete the private, never-admitted object.
        const noSuchUpload=typeof failure==='object' && failure!==null && 'code' in failure && Number(failure.code)===10024 ||
          failure instanceof Error && /\b(?:10024|NoSuchUpload)\b/.test(failure.message);
        if(!noSuchUpload && !await env.ATTACHMENTS_BUCKET.head(row.storage_key)) throw new Error('UPLOAD_ABORT_UNCONFIRMED');
      }}
      if(!row.stored_at) await env.ATTACHMENTS_BUCKET.delete(row.storage_key);
      const chunks=await cleanupUploadSubparts(env,session.id);if(chunks.pending)throw new Error('UPLOAD_CHUNK_CLEANUP_PENDING');
      await env.DB.prepare("UPDATE attachment_upload_sessions SET status='ABORTED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='ABORTING' AND lease_token=?").bind(now(),session.id,lease).run();
    } catch { await env.DB.prepare("UPDATE attachment_upload_sessions SET last_error='R2_ABORT_RETRY',lease_until=?,updated_at=? WHERE id=? AND status='ABORTING' AND lease_token=?").bind(now()+60,now(),session.id,lease).run(); }
  }
  if(onlyId)return;
  const pendingWork=await env.DB.prepare(`SELECT s.* FROM attachment_upload_sessions s JOIN upload_invites i ON i.id=s.invite_id
    WHERE s.async_mode=1 AND s.expires_at>? AND i.status!='REVOKED' AND COALESCE(s.lease_until,0)<=?
      AND COALESCE(s.last_error,'')!='UPLOAD_ASYNC_RETRY_EXHAUSTED'
      AND (s.status IN ('INITIALIZING','VERIFYING','COMPLETING','STORED') OR (s.status='UPLOADING' AND EXISTS(
        SELECT 1 FROM attachment_upload_parts p WHERE p.session_id=s.id AND p.status='WRITING' AND p.lease_until<=?)))
    ORDER BY s.updated_at LIMIT 20`).bind(now(),now(),now()).all<UploadSession>();
  for(const session of pendingWork.results)try{await redriveUploadWork(env,session);}catch{/* Durable intent remains for the next bounded maintenance pass. */}
  await env.DB.prepare(`UPDATE attachment_upload_sessions SET status='DELIVERED',updated_at=? WHERE status IN ('STORED','QUEUED')
    AND EXISTS(SELECT 1 FROM attachments a WHERE a.id=attachment_id AND a.status='DELIVERED')`).bind(now()).run();
  const recover=await env.DB.prepare(`SELECT s.* FROM attachment_upload_sessions s JOIN attachments a ON a.id=s.attachment_id
    WHERE s.status IN ('STORED','QUEUED') AND a.status='STORED' AND a.deleted_at IS NULL AND a.retention_expires_at>?
      AND s.updated_at<? ORDER BY s.updated_at LIMIT 30`).bind(now(),now()-60).all<UploadSession>();
  for(const session of recover.results) { try { await dispatchStoredUpload(env,session); } catch { /* durable row remains recoverable */ } }
  const retired=await env.DB.prepare(`SELECT DISTINCT p.session_id FROM attachment_upload_subparts p
    JOIN attachment_upload_sessions s ON s.id=p.session_id WHERE p.state!='DELETED'
    AND s.status IN ('STORED','QUEUED','DELIVERED','AMBIGUOUS','ABORTED','ABORTING','FAILED') LIMIT 20`).all<{session_id:string}>();
  for(const row of retired.results){try{await cleanupUploadSubparts(env,row.session_id);}catch{/* durable retry next cron */}}
  await env.DB.prepare('DELETE FROM attachment_upload_requests WHERE minute_bucket<?').bind(Math.floor(now()/60)-60).run();
}
