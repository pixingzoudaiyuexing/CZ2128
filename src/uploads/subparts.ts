import { Env } from '../config/env';
import { verifiedPartStream } from '../attachments/content';
import type { UploadSession } from './sessions';
import { queueUploadTask } from './async-work';
import { fetchCrispConversationState } from '../adapters/crisp/api';

export const UPLOAD_NETWORK_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_R2_PART_BYTES = 5 * 1024 * 1024 * 1024;
const LEASE_SECONDS = 300;
const CLEANUP_BATCH = 100;
const SHA256 = /^[a-f0-9]{64}$/;
interface Subpart {
  session_id: string; part_number: number; chunk_number: number; size_bytes: number;
  sha256: string; temp_key: string; etag: string | null; state: 'WRITING' | 'STORED' | 'DELETING' | 'DELETED';
  lease_token: string; lease_until: number; cleanup_attempts: number;
}
interface Part { part_number: number; size_bytes: number; sha256: string; etag: string | null; status: string; lease_token: string; lease_until: number }
const now = () => Math.floor(Date.now() / 1000);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'
} });
const failure = (code: string, status = 409) => json({ ok: false, code }, status);

// Every admission rechecks authoritative D1 binding, not only the caller's
// previously authenticated snapshot; invitation expiry alone does not revoke a session.
const WRITABLE = `EXISTS(SELECT 1 FROM attachment_upload_sessions s
  JOIN upload_invites i ON i.id=s.invite_id JOIN conversations c ON c.id=i.conversation_id
  WHERE s.id=? AND s.status='UPLOADING' AND s.expires_at>? AND i.status!='REVOKED'
    AND c.helpdesk_provider='crisp' AND c.helpdesk_account_ref=i.crisp_website_ref
    AND c.helpdesk_conversation_ref=i.crisp_session_ref AND c.operator_channel='telegram'
    AND c.operator_thread_ref=i.telegram_thread_ref AND c.operator_thread_status='OPEN'
    AND i.telegram_group_ref=? AND i.support_profile_version=
      COALESCE((SELECT version FROM runtime_config WHERE key='TELEGRAM_SUPPORT_PROFILE'),0))`;

async function writableSession(env: Env, id: string): Promise<UploadSession | null> {
  return env.DB.prepare(`SELECT * FROM attachment_upload_sessions WHERE id=? AND ${WRITABLE}`)
    .bind(id, id, now(), env.BOT_GROUP_ID).first<UploadSession>();
}

function partLength(session: UploadSession, number: number): number | null {
  if (!Number.isSafeInteger(number) || number < 1 || number > session.part_count ||
      !Number.isSafeInteger(session.size_bytes) || !Number.isSafeInteger(session.part_size) ||
      session.part_size < 5 * 1024 * 1024 || session.part_size > MAX_R2_PART_BYTES) return null;
  const length = number === session.part_count ? session.size_bytes - (number - 1) * session.part_size : session.part_size;
  return Number.isSafeInteger(length) && length > 0 && length <= MAX_R2_PART_BYTES ? length : null;
}

async function subpart(env: Env, id: string, part: number, chunk: number): Promise<Subpart | null> {
  return env.DB.prepare('SELECT * FROM attachment_upload_subparts WHERE session_id=? AND part_number=? AND chunk_number=?')
    .bind(id, part, chunk).first<Subpart>();
}
async function part(env: Env, id: string, number: number): Promise<Part | null> {
  return env.DB.prepare('SELECT * FROM attachment_upload_parts WHERE session_id=? AND part_number=?')
    .bind(id, number).first<Part>();
}

export async function listUploadSubparts(env: Env, sessionId: string, partNumber = 1): Promise<Array<{ number: number; index: number; sha256: string; sizeBytes: number }>> {
  const result = await env.DB.prepare(`SELECT part_number,chunk_number,sha256,size_bytes
    FROM attachment_upload_subparts WHERE session_id=? AND part_number=? AND state='STORED' ORDER BY chunk_number LIMIT 640`)
    .bind(sessionId,partNumber).all<Subpart>();
  return result.results.map(row => ({ number: row.part_number, index: row.chunk_number, sha256: row.sha256, sizeBytes: row.size_bytes }));
}

async function putChunk(request: Request, env: Env, session: UploadSession, number: number, index: number): Promise<Response> {
  const length = partLength(session, number);
  if (length === null || !Number.isSafeInteger(index) || index < 1 || index > Math.ceil(length / UPLOAD_NETWORK_CHUNK_BYTES)) {
    return failure('UPLOAD_CHUNK_INVALID', 400);
  }
  const expected = Math.min(UPLOAD_NETWORK_CHUNK_BYTES, length - (index - 1) * UPLOAD_NETWORK_CHUNK_BYTES);
  const hash = request.headers.get('X-Part-SHA256') || request.headers.get('X-Chunk-SHA256') || '';
  if (!SHA256.test(hash) || Number(request.headers.get('Content-Length')) !== expected || !request.body) return failure('UPLOAD_CHUNK_INVALID', 400);
  if (!await writableSession(env, session.id)) return failure('UPLOAD_AUTHORIZATION_CHANGED', 410);
  const currentPart = await part(env, session.id, number);
  if (currentPart?.status === 'STORED') return failure('UPLOAD_PART_ALREADY_STORED');
  const lease = crypto.randomUUID();
  const key = `upload-parts/${session.id}/${number}/${index}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(session.id)) return failure('UPLOAD_SESSION_UNAVAILABLE', 404);
  await env.DB.prepare(`INSERT INTO attachment_upload_subparts
    (session_id,part_number,chunk_number,size_bytes,sha256,temp_key,state,lease_token,lease_until,created_at,updated_at)
    SELECT ?,?,?,?,?,?,'WRITING',?,?,?,? WHERE ${WRITABLE}
    ON CONFLICT(session_id,part_number,chunk_number) DO NOTHING`)
    .bind(session.id, number, index, expected, hash, key, lease, now() + LEASE_SECONDS, now(), now(),
      session.id, now(), env.BOT_GROUP_ID).run();
  const row = await subpart(env, session.id, number, index);
  if (!row || row.sha256 !== hash || row.size_bytes !== expected || row.temp_key !== key) return failure('UPLOAD_CHUNK_CONFLICT');
  if (row.state === 'STORED') return json({ ok: true, number, index, sizeBytes: expected, sha256: hash });
  if (row.state !== 'WRITING') return failure('UPLOAD_CHUNK_RETIRED');
  if (row.lease_token !== lease) {
    const claimed = await env.DB.prepare(`UPDATE attachment_upload_subparts SET lease_token=?,lease_until=?,updated_at=?
      WHERE session_id=? AND part_number=? AND chunk_number=? AND state='WRITING' AND lease_until<=? AND ${WRITABLE}`)
      .bind(lease, now() + LEASE_SECONDS, now(), session.id, number, index, now(), session.id, now(), env.BOT_GROUP_ID).run();
    if (claimed.meta.changes !== 1) return failure('UPLOAD_CHUNK_BUSY', 429);
  }
  const stream = session.async_mode?null:verifiedPartStream(request.body, expected, hash);
  let object: R2Object | null;
  try {
    if(session.async_mode) {
      // R2 validates the declared SHA-256 natively; HTTP performs no JS hashing loop.
      object=await env.ATTACHMENTS_BUCKET.put(key,request.body,{sha256:hash,
        httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sessionId:session.id}});
    } else [object] = await Promise.all([env.ATTACHMENTS_BUCKET.put(key, stream!.readable,
      { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { sessionId: session.id } }), stream!.done]);
    if (!object || object.size !== expected) throw new Error('UPLOAD_CHUNK_STORE_INVALID');
  } catch (error) {
    await stream?.abort(error);
    await env.DB.prepare(`UPDATE attachment_upload_subparts SET lease_until=0,updated_at=?
      WHERE session_id=? AND part_number=? AND chunk_number=? AND lease_token=? AND state='WRITING'`)
      .bind(now(), session.id, number, index, lease).run();
    return failure('UPLOAD_CHUNK_CHECKSUM_OR_TRANSPORT_FAILURE', 422);
  }
  const saved = await env.DB.prepare(`UPDATE attachment_upload_subparts SET state='STORED',etag=?,lease_until=0,updated_at=?
    WHERE session_id=? AND part_number=? AND chunk_number=? AND state='WRITING' AND lease_token=? AND sha256=? AND ${WRITABLE}`)
    .bind(object.etag, now(), session.id, number, index, lease, hash, session.id, now(), env.BOT_GROUP_ID).run();
  if (saved.meta.changes !== 1) {
    // An expired writer can finish after cancellation/cleanup. Reopen managed
    // cleanup evidence before retiring anything; never delete a newer live owner.
    if(!await writableSession(env,session.id)) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE attachment_upload_subparts SET state='WRITING',lease_until=0,cleanup_next_retry_at=0,updated_at=?
          WHERE session_id=? AND part_number=? AND chunk_number=? AND state!='STORED'`)
          .bind(now(),session.id,number,index),
        env.DB.prepare(`UPDATE attachment_upload_sessions SET status='ABORTING',lease_until=0,updated_at=? WHERE id=?
          AND status NOT IN ('STORED','QUEUED','DELIVERED','AMBIGUOUS')`)
          .bind(now(),session.id)
      ]);
      if(session.async_mode)try{await queueUploadTask(env,session.id,'ABORT');}catch{/* Durable ABORTING metadata is retried by maintenance. */}
    }
    return failure('UPLOAD_AUTHORIZATION_CHANGED', 410);
  }
  return json({ ok: true, number, index, sizeBytes: expected, sha256: hash });
}

async function boundedMetadata(request: Request): Promise<{ sha256: string } | null> {
  const reader = request.body?.getReader(); if (!reader) return null;
  const bytes = new Uint8Array(4096); let used = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      if (used + item.value.length > bytes.length) { await reader.cancel(); return null; }
      bytes.set(item.value, used); used += item.value.length;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, used)));
    return value && typeof value === 'object' && !Array.isArray(value) && SHA256.test(value.sha256 || '') ? value : null;
  } catch { return null; } finally { reader.releaseLock(); }
}

function concatenateChunks(bucket: R2Bucket, chunks: Subpart[]): ReadableStream<Uint8Array> {
  let index = 0; let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let currentBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (index < chunks.length) {
          if (!current) {
            const object = await bucket.get(chunks[index].temp_key);
            if (!object?.body || object.size !== chunks[index].size_bytes) throw new Error('UPLOAD_CHUNK_UNAVAILABLE');
            current = object.body.getReader(); currentBytes = 0;
          }
          const item = await current.read();
          if (!item.done) {
            currentBytes += item.value.length;
            if (currentBytes > chunks[index].size_bytes) throw new Error('UPLOAD_CHUNK_LENGTH_MISMATCH');
            controller.enqueue(item.value); return;
          }
          if (currentBytes !== chunks[index].size_bytes) throw new Error('UPLOAD_CHUNK_LENGTH_MISMATCH');
          current.releaseLock(); current = null; index++;
        }
        controller.close();
      } catch (error) {
        if (current) { try { await current.cancel(error); } catch { /* storage read failed */ } }
        controller.error(error);
      }
    },
    async cancel(reason) { if (current) { try { await current.cancel(reason); } finally { current.releaseLock(); } } }
  });
}

async function assemble(request: Request, env: Env, session: UploadSession, number: number, queued=false): Promise<Response> {
  const metadata = await boundedMetadata(request); if (!metadata) return failure('UPLOAD_ASSEMBLY_METADATA_INVALID', 400);
  const length = partLength(session, number); if (length === null) return failure('UPLOAD_PART_INVALID', 400);
  const current = await writableSession(env, session.id);
  if (!current?.r2_upload_id || current.r2_upload_id !== session.r2_upload_id) return failure('UPLOAD_AUTHORIZATION_CHANGED', 410);
  const existingPart = await part(env, session.id, number);
  if (existingPart && (existingPart.sha256 !== metadata.sha256 || existingPart.size_bytes !== length)) return failure('UPLOAD_PART_CONFLICT');
  if (existingPart?.status === 'STORED') return json({ ok: true, number, sha256: metadata.sha256 });
  const result = await env.DB.prepare(`SELECT * FROM attachment_upload_subparts
    WHERE session_id=? AND part_number=? ORDER BY chunk_number`).bind(session.id, number).all<Subpart>();
  const chunks = result.results;
  const count = Math.ceil(length / UPLOAD_NETWORK_CHUNK_BYTES);
  if (chunks.length !== count || chunks.some((row, index) => row.chunk_number !== index + 1 || row.state !== 'STORED' ||
      row.size_bytes !== Math.min(UPLOAD_NETWORK_CHUNK_BYTES, length - index * UPLOAD_NETWORK_CHUNK_BYTES)) ||
      chunks.reduce((total, row) => total + row.size_bytes, 0) !== length) return failure('UPLOAD_CHUNKS_INCOMPLETE');
  if(session.async_mode&&!queued) {
    await env.DB.prepare(`INSERT INTO attachment_upload_parts(session_id,part_number,size_bytes,sha256,status,lease_token,lease_until,updated_at)
      SELECT ?,?,?,?,'WRITING','PENDING',0,? WHERE ${WRITABLE} ON CONFLICT(session_id,part_number) DO NOTHING`)
      .bind(session.id,number,length,metadata.sha256,now(),session.id,now(),env.BOT_GROUP_ID).run();
    const pending=await part(env,session.id,number);
    if(!pending||pending.sha256!==metadata.sha256||pending.size_bytes!==length)return failure('UPLOAD_PART_CONFLICT');
    await queueUploadTask(env,session.id,'ASSEMBLE',{partNumber:number});
    return json({ok:true,state:'ASSEMBLING',number,sizeBytes:length,sha256:metadata.sha256},202);
  }
  const lease = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO attachment_upload_parts(session_id,part_number,size_bytes,sha256,status,lease_token,lease_until,updated_at)
    SELECT ?,?,?,?,'WRITING',?,?,? WHERE ${WRITABLE} ON CONFLICT(session_id,part_number) DO NOTHING`)
    .bind(session.id, number, length, metadata.sha256, lease, now() + LEASE_SECONDS, now(), session.id, now(), env.BOT_GROUP_ID).run();
  const manifest = await part(env, session.id, number);
  if (!manifest || manifest.sha256 !== metadata.sha256 || manifest.size_bytes !== length) return failure('UPLOAD_PART_CONFLICT');
  if (manifest.status === 'STORED') return json({ ok: true, number, sha256: metadata.sha256 });
  if (manifest.lease_token !== lease) {
    const claimed = await env.DB.prepare(`UPDATE attachment_upload_parts SET lease_token=?,lease_until=?,updated_at=?
      WHERE session_id=? AND part_number=? AND status='WRITING' AND lease_until<=? AND ${WRITABLE}`)
      .bind(lease, now() + LEASE_SECONDS, now(), session.id, number, now(), session.id, now(), env.BOT_GROUP_ID).run();
    if (claimed.meta.changes !== 1) return failure('UPLOAD_PART_BUSY', 429);
  }
  const attachment = await env.DB.prepare('SELECT storage_key FROM attachments WHERE id=? AND deleted_at IS NULL')
    .bind(session.attachment_id).first<{ storage_key: string }>();
  if (!attachment) return failure('UPLOAD_ATTACHMENT_UNAVAILABLE', 410);
  const stream = verifiedPartStream(concatenateChunks(env.ATTACHMENTS_BUCKET, chunks), length, metadata.sha256);
  let uploaded: R2UploadedPart;
  try {
    [uploaded] = await Promise.all([env.ATTACHMENTS_BUCKET.resumeMultipartUpload(attachment.storage_key, current.r2_upload_id)
      .uploadPart(number, stream.readable), stream.done]);
  } catch (error) {
    await stream.abort(error);
    await env.DB.prepare(`UPDATE attachment_upload_parts SET lease_until=0,updated_at=?
      WHERE session_id=? AND part_number=? AND status='WRITING' AND lease_token=?`).bind(now(), session.id, number, lease).run();
    return failure('UPLOAD_PART_ASSEMBLY_RETRY', 503);
  }
  const saved = await env.DB.prepare(`UPDATE attachment_upload_parts SET status='STORED',etag=?,lease_until=0,updated_at=?
    WHERE session_id=? AND part_number=? AND status='WRITING' AND lease_token=? AND sha256=? AND ${WRITABLE}`)
    .bind(uploaded.etag, now(), session.id, number, lease, metadata.sha256, session.id, now(), env.BOT_GROUP_ID).run();
  if (saved.meta.changes !== 1) return failure('UPLOAD_AUTHORIZATION_CHANGED', 410);
  await cleanupUploadSubparts(env, session.id);
  return json({ ok: true, number, sha256: metadata.sha256 });
}

export async function assembleQueuedUploadPart(env:Env,session:UploadSession,number:number):Promise<Response> {
  const bound=await env.DB.prepare(`SELECT i.crisp_website_ref,i.crisp_session_ref FROM upload_invites i WHERE i.id=?`).bind(session.invite_id)
    .first<{crisp_website_ref:string;crisp_session_ref:string}>();
  if(!bound||await fetchCrispConversationState(env,bound.crisp_website_ref,bound.crisp_session_ref)==='resolved')return failure('UPLOAD_AUTHORIZATION_CHANGED',410);
  const manifest=await part(env,session.id,number);
  if(!manifest)return failure('UPLOAD_PART_INVALID',400);
  return assemble(new Request('https://upload-work.internal/assemble',{method:'POST',body:JSON.stringify({sha256:manifest.sha256})}),env,session,number,true);
}

/** Called only after the existing session capability/binding authorization. */
export async function handleUploadSubpart(request: Request, env: Env, session: UploadSession, action: string): Promise<Response> {
  const chunk = /^parts\/(\d{1,5})\/chunks\/(\d{1,3})$/.exec(action);
  if (request.method === 'PUT' && chunk) return putChunk(request, env, session, Number(chunk[1]), Number(chunk[2]));
  const assembly = /^parts\/(\d{1,5})\/assemble$/.exec(action);
  if (request.method === 'POST' && assembly) return assemble(request, env, session, Number(assembly[1]));
  return failure('UPLOAD_ACTION_INVALID', 405);
}

export async function cleanupUploadSubparts(env: Env, sessionId: string): Promise<{ deleted: number; pending: number }> {
  const eligible = `EXISTS(SELECT 1 FROM attachment_upload_sessions s WHERE s.id=session_id
    AND s.status IN ('STORED','QUEUED','DELIVERED','AMBIGUOUS','ABORTING','ABORTED','FAILED')) OR
    EXISTS(SELECT 1 FROM attachment_upload_parts p WHERE p.session_id=attachment_upload_subparts.session_id
      AND p.part_number=attachment_upload_subparts.part_number AND p.status='STORED')`;
  const rows = await env.DB.prepare(`SELECT * FROM attachment_upload_subparts WHERE session_id=? AND state!='DELETED'
    AND COALESCE(cleanup_next_retry_at,0)<=? AND (${eligible}) ORDER BY part_number,chunk_number LIMIT ?`)
    .bind(sessionId, now(), CLEANUP_BATCH).all<Subpart>();
  let deleted = 0;
  for (const row of rows.results) {
    const expectedKey = `upload-parts/${row.session_id}/${row.part_number}/${row.chunk_number}`;
    if (row.temp_key !== expectedKey || !/^[A-Za-z0-9_-]{1,80}$/.test(row.session_id)) continue;
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE attachment_upload_subparts SET state='DELETING',lease_token=?,lease_until=?,updated_at=?
      WHERE session_id=? AND part_number=? AND chunk_number=? AND state!='DELETED'
      AND (state NOT IN ('DELETING','WRITING') OR lease_until<=?)
      AND (${eligible})`).bind(lease, now() + LEASE_SECONDS, now(), row.session_id, row.part_number, row.chunk_number, now()).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await env.ATTACHMENTS_BUCKET.delete(row.temp_key);
      const saved = await env.DB.prepare(`UPDATE attachment_upload_subparts SET state='DELETED',lease_until=0,updated_at=?
        WHERE session_id=? AND part_number=? AND chunk_number=? AND state='DELETING' AND lease_token=?`)
        .bind(now(), row.session_id, row.part_number, row.chunk_number, lease).run();
      if (saved.meta.changes === 1) deleted++;
    } catch {
      await env.DB.prepare(`UPDATE attachment_upload_subparts SET cleanup_attempts=cleanup_attempts+1,
        cleanup_next_retry_at=?,lease_until=0,updated_at=? WHERE session_id=? AND part_number=? AND chunk_number=? AND lease_token=?`)
        .bind(now() + 60, now(), row.session_id, row.part_number, row.chunk_number, lease).run();
    }
  }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM attachment_upload_subparts WHERE session_id=? AND state!='DELETED'")
    .bind(sessionId).first<{ count: number }>();
  return { deleted, pending: pending?.count || 0 };
}
