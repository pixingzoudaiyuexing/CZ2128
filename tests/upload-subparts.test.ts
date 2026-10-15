import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteD1 } from './helpers/sqlite-d1';
import { TestFixedLengthStream } from './fixtures/fixed-length-stream';
import type { UploadSession } from '../src/uploads/sessions';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const CHUNK = 8 * 1024 * 1024;
class Bucket {
  objects = new Map<string, Uint8Array>();
  uploaded: Uint8Array[] = [];
  failDelete = false;
  failPart = false;
  beforePutCommit?: () => void;
  async put(key: string, body: ReadableStream<Uint8Array>) {
    const data = new Uint8Array(await new Response(body).arrayBuffer());
    this.beforePutCommit?.(); this.objects.set(key, data);
    return { key, size: data.length, etag: sha(data) };
  }
  async get(key: string) {
    const bytes = this.objects.get(key); if (!bytes) return null;
    return { size: bytes.length, body: new Blob([Uint8Array.from(bytes).buffer]).stream(),
      arrayBuffer: () => { throw new Error('WHOLE_PART_BUFFER_FORBIDDEN'); } };
  }
  resumeMultipartUpload() {
    return { uploadPart: async (partNumber: number, body: ReadableStream<Uint8Array>) => {
      if (this.failPart) throw new Error('TRANSIENT_PART');
      const value = new Uint8Array(await new Response(body).arrayBuffer()); this.uploaded.push(value);
      return { partNumber, etag: sha(value) };
    } };
  }
  async delete(key: string) { if (this.failDelete) throw new Error('TRANSIENT_DELETE'); this.objects.delete(key); }
}

describe('durable network subparts inside an R2 multipart part', () => {
  let db: SqliteD1; let bucket: Bucket; let env: any; let session: UploadSession;
  beforeEach(async () => {
    db = new SqliteD1(); db.migrate(); bucket = new Bucket();
    vi.stubGlobal('FixedLengthStream', TestFixedLengthStream);
    const now = Math.floor(Date.now() / 1000);
    db.exec("INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,operator_thread_ref,created_at,updated_at) VALUES('conv','crisp','site','session','synthetic','telegram','703',1,1)");
    db.exec("INSERT INTO upload_invites(id,token_hash,conversation_id,crisp_website_ref,crisp_session_ref,telegram_group_ref,telegram_thread_ref,support_profile_version,created_by_operator_ref,created_from_update_ref,status,expires_at,max_files,max_total_bytes,created_at,updated_at,transfer_version) VALUES('invite','invite-hash','conv','site','session','-100','703',0,'admin','1','ACTIVE',9999999999,3,1024,1,1,2)");
    db.exec("INSERT INTO attachments(id,conversation_id,source_provider,source_message_ref,source_attachment_ref,attachment_type,original_filename,safe_filename,mime_type,storage_key,access_token_hash,status,destination_provider,created_at,updated_at,transfer_version,expires_at) VALUES('att','conv','upload','invite','file','document','x.bin','x.bin','application/octet-stream','attachments-v2/att','file-hash','PENDING','telegram',1,1,2,9999999999)");
    await db.prepare("INSERT INTO attachment_upload_sessions(id,invite_id,attachment_id,token_hash,size_bytes,part_size,part_count,r2_upload_id,status,expires_at,created_at,updated_at) VALUES('upload','invite','att','session-hash',?,?,1,'r2-upload','UPLOADING',?,?,?)")
      .bind(CHUNK + 37, CHUNK + 37, now + 86400, now, now).run();
    session = (await db.prepare("SELECT * FROM attachment_upload_sessions WHERE id='upload'").first()) as UploadSession;
    env = { DB: db, ATTACHMENTS_BUCKET: bucket, BOT_GROUP_ID: '-100' };
  });
  afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function chunk(number: number, bytes: Uint8Array, hash = sha(bytes)) {
    const { handleUploadSubpart } = await import('../src/uploads/subparts');
    return handleUploadSubpart(new Request('https://worker.example/upload', { method: 'PUT',
      headers: { 'Content-Length': String(bytes.length), 'X-Part-SHA256': hash }, body: Uint8Array.from(bytes).buffer }), env, session, `parts/1/chunks/${number}`);
  }
  async function assemble(hash: string, body?: string) {
    const { handleUploadSubpart } = await import('../src/uploads/subparts');
    return handleUploadSubpart(new Request('https://worker.example/upload', { method: 'POST',
      body: body ?? JSON.stringify({ sha256: hash }) }), env, session, 'parts/1/assemble');
  }

  it('persists chunks and assembles the original part with a verified stream, preserving retry identity', async () => {
    const first = new Uint8Array(CHUNK).fill(31), last = new Uint8Array(37).fill(32);
    const full = createHash('sha256').update(first).update(last).digest('hex');
    expect((await chunk(1, first)).status).toBe(200);
    expect((await chunk(2, last)).status).toBe(200);
    expect((await chunk(1, first)).status).toBe(200);
    expect((await assemble(full)).status).toBe(200);
    expect(bucket.uploaded).toHaveLength(1);
    expect(sha(bucket.uploaded[0])).toBe(full);
    expect((await assemble(full)).status).toBe(200);
    expect(bucket.uploaded).toHaveLength(1);
    const part = await db.prepare("SELECT status,sha256,size_bytes FROM attachment_upload_parts WHERE session_id='upload'").first();
    expect(part).toEqual({ status: 'STORED', sha256: full, size_bytes: CHUNK + 37 });
  });

  it('rejects altered chunk identity, incomplete manifests and corrupt bytes without recording success', async () => {
    const bytes = new Uint8Array(CHUNK).fill(11);
    expect((await chunk(1, bytes, '0'.repeat(64))).status).toBe(422);
    expect((await chunk(1, bytes)).status).toBe(409);
    expect((await assemble(sha(bytes))).status).toBe(409);
    expect(bucket.uploaded).toHaveLength(0);
  });

  it('does not admit a chunk after its invitation is revoked while bytes are being stored', async () => {
    bucket.beforePutCommit = () => db.exec("UPDATE upload_invites SET status='REVOKED' WHERE id='invite'");
    expect((await chunk(1, new Uint8Array(CHUNK).fill(1))).status).toBe(410);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM attachment_upload_subparts WHERE state='STORED'").first()).toEqual({ count: 0 });
  });

  it('recovers a failed part assembly from persisted chunks instead of reuploading them', async () => {
    const first = new Uint8Array(CHUNK).fill(3), last = new Uint8Array(37).fill(4);
    const hash = createHash('sha256').update(first).update(last).digest('hex');
    await chunk(1, first); await chunk(2, last); bucket.failPart = true;
    expect((await assemble(hash)).status).toBe(503);
    bucket.failPart = false;
    expect((await assemble(hash)).status).toBe(200);
    expect(bucket.uploaded).toHaveLength(1);
  });

  it('retains temporary-object cleanup identity when R2 deletion fails, then retires after success', async () => {
    const { cleanupUploadSubparts } = await import('../src/uploads/subparts');
    await chunk(1, new Uint8Array(CHUNK).fill(5));
    db.exec("UPDATE attachment_upload_sessions SET status='ABORTED' WHERE id='upload'");
    bucket.failDelete = true;
    expect(await cleanupUploadSubparts(env, session.id)).toMatchObject({ deleted: 0, pending: 1 });
    expect(bucket.objects.size).toBe(1);
    bucket.failDelete = false;
    db.exec("UPDATE attachment_upload_subparts SET cleanup_next_retry_at=0 WHERE session_id='upload'");
    expect(await cleanupUploadSubparts(env, session.id)).toMatchObject({ deleted: 1, pending: 0 });
    expect(bucket.objects.size).toBe(0);
    expect(await db.prepare("SELECT state FROM attachment_upload_subparts WHERE session_id='upload'").first()).toEqual({ state: 'DELETED' });
  });

  it('bounds actual assembly metadata even without a declared Content-Length', async () => {
    expect((await assemble('0'.repeat(64), '{"sha256":"' + 'a'.repeat(5000) + '"}')).status).toBe(400);
    expect(bucket.uploaded).toHaveLength(0);
  });
});
