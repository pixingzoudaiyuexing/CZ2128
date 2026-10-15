import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getAttachmentConfig } from '../src/config/attachments';
import { discoverAttachment, markAttachmentStored } from '../src/core/attachment-repository';
import { attachmentByteSize, effectiveExpiry } from '../src/core/attachments';
import { cleanupExpiredAttachments } from '../src/attachments/cleanup';
import { SqliteD1 } from './helpers/sqlite-d1';

const databases: SqliteD1[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });

function database(): SqliteD1 {
  const db = new SqliteD1();
  db.migrate();
  const columns = db.database.prepare('PRAGMA table_info(attachments)').all() as Array<{name: string}>;
  for (const definition of [
    'declared_size_bytes INTEGER', 'stored_size_bytes INTEGER', 'stored_at INTEGER',
    'retention_class TEXT', 'retention_expires_at INTEGER', 'sha256 TEXT', 'deleted_at INTEGER',
    'cleanup_attempts INTEGER DEFAULT 0', 'cleanup_next_retry_at INTEGER',
    'grant_expires_at INTEGER', 'grant_revoked_at INTEGER', 'transfer_version INTEGER DEFAULT 1'
  ]) if (!columns.some(column => column.name === definition.split(' ')[0])) db.exec('ALTER TABLE attachments ADD COLUMN ' + definition);
  db.exec("INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,created_at,updated_at) VALUES('conv','crisp','website','session','synthetic','telegram',1,1)");
  databases.push(db);
  return db;
}

function bucket(bytes: Uint8Array, mime = 'image/png') {
  return {
    get: vi.fn(async () => ({ size: bytes.byteLength, httpMetadata: { contentType: mime },
      body: new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 19) controller.enqueue(bytes.subarray(offset, offset + 19));
        controller.close();
      } }), arrayBuffer: vi.fn(() => { throw new Error('whole file buffering forbidden'); }) })),
    delete: vi.fn(async () => undefined)
  };
}

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));

describe('verified attachment storage and retention', () => {
  it('uses a length-bound stream and rejects modified multipart data before successful completion', async () => {
    const { verifiedPartStream } = await import('../src/attachments/content');
    const implementation = class {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor(length: number) {
        let count = 0;
        const stream = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { count += chunk.length; if (count > length) throw new Error('LONG'); controller.enqueue(chunk); },
          flush() { if (count !== length) throw new Error('SHORT'); }
        });
        this.readable = stream.readable; this.writable = stream.writable;
      }
    };
    vi.stubGlobal('FixedLengthStream', implementation);
    try {
      const bytes = new TextEncoder().encode('verified chunk');
      const source = () => new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
      const good = verifiedPartStream(source(), bytes.length, createHash('sha256').update(bytes).digest('hex'));
      const sink = new Response(good.readable).arrayBuffer();
      await expect(Promise.all([sink, good.done])).resolves.toBeDefined();
      const bad = verifiedPartStream(source(), bytes.length, '0'.repeat(64));
      await expect(Promise.all([new Response(bad.readable).arrayBuffer(), bad.done])).rejects.toBeDefined();
      const short = verifiedPartStream(source(), bytes.length + 1, createHash('sha256').update(bytes).digest('hex'));
      await expect(Promise.all([new Response(short.readable).arrayBuffer(), short.done])).rejects.toBeDefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it('retires historical product size/count/TTL overrides', () => {
    const config = getAttachmentConfig({ ATTACHMENT_MAX_BYTES: '1024', ATTACHMENT_MAX_COUNT_PER_MESSAGE: '1', ATTACHMENT_TTL_SECONDS: '60' } as any);
    expect(config.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.maxCountPerMessage).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.fileTtlSeconds).toBe(259200);
    expect(config.imageTtlSeconds).toBe(604800);
  });

  it('classifies persisted bytes and hashes all content without trusting MIME', async () => {
    const { inspectStoredAttachment } = await import('../src/attachments/content');
    const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic ordinary file');
    const result = await inspectStoredAttachment(bucket(bytes) as any, 'attachments-v2/file');
    expect(result).toEqual({ sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'application/pdf', retentionClass: 'FILE' });
    const image = await inspectStoredAttachment(bucket(png, 'text/plain') as any, 'attachments-v2/image');
    expect(image.retentionClass).toBe('IMAGE');
    expect(image.mimeType).toBe('image/png');
  });

  it('hashes a 32 MiB stored object with bounded chunks and no whole-file read', async () => {
    const { inspectStoredAttachment } = await import('../src/attachments/content');
    const chunk = new Uint8Array(1024 * 1024).fill(97); let sent = 0;
    const storage = { get: async () => ({ size: 32 * 1024 * 1024,
      arrayBuffer: () => { throw new Error('whole file read forbidden'); },
      body: new ReadableStream<Uint8Array>({ pull(controller) {
        if (sent++ < 32) controller.enqueue(chunk); else controller.close();
      } }) }) };
    expect(await inspectStoredAttachment(storage as any, 'attachments-v2/large')).toEqual({
      sizeBytes: 33554432, sha256: 'facb58ac139bf9fc0e1f8b1f147003236b1b69e84f3a4c94166fa66f18f89932',
      mimeType: 'application/octet-stream', retentionClass: 'FILE'
    });
  });

  it('gives a verified image exactly seven days from storage admission', async () => {
    const db = database(); const env = { DB: db, ATTACHMENTS_BUCKET: bucket(png, 'text/plain') } as any;
    const item = await discoverAttachment(env, getAttachmentConfig(env), 'conv', 'upload', 'image-invite', {
      sourceAttachmentRef: 'image', attachmentType: 'document', mimeType: 'text/plain', originalFilename: 'misnamed.txt',
      locator: { provider: 'upload', inviteId: 'image-invite', uploadId: 'image' }
    }, 'telegram');
    db.exec("UPDATE attachments SET status='FETCHING' WHERE id='" + item.row.id + "'");
    expect(await markAttachmentStored(env, item.row.id, png.length, getAttachmentConfig(env))).toBe(true);
    const row = await db.prepare('SELECT * FROM attachments WHERE id=?').bind(item.row.id).first<any>();
    expect(row.retention_class).toBe('IMAGE');
    expect(row.retention_expires_at - row.stored_at).toBe(604800);
    expect(row.mime_type).toBe('image/png');
  });

  it('does not admit a truncated image as an inline image', async () => {
    const { inspectStoredAttachment } = await import('../src/attachments/content');
    const result = await inspectStoredAttachment(bucket(png.slice(0, 35)) as any, 'attachments-v2/truncated');
    expect(result.retentionClass).toBe('FILE');
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('rejects a forged PNG container whose payload checksum is invalid', async () => {
    const { inspectStoredAttachment } = await import('../src/attachments/content');
    const corrupt = png.slice(); corrupt[45] ^= 1;
    const result = await inspectStoredAttachment(bucket(corrupt) as any, 'attachments-v2/forged');
    expect(result.retentionClass).toBe('FILE');
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('persists declarations above the former SQLite size CHECK and starts retention only after verified storage', async () => {
    const db = database();
    const bytes = new TextEncoder().encode('ordinary synthetic file');
    const env = { DB: db, ATTACHMENTS_BUCKET: bucket(bytes) } as any;
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const discovered = await discoverAttachment(env, getAttachmentConfig(env), 'conv', 'upload', 'invite', {
      sourceAttachmentRef: 'upload-id', attachmentType: 'document', sizeBytes: 40 * 1024 * 1024,
      originalFilename: 'claimed.png', mimeType: 'image/png', locator: { provider: 'upload', inviteId: 'invite', uploadId: 'upload-id' }
    }, 'telegram');
    expect(discovered.row.size_bytes).toBeNull();
    expect(discovered.row.declared_size_bytes).toBe(41943040);
    expect(discovered.row.stored_at).toBeNull();
    expect(discovered.row.storage_key).toBe('attachments-v2/' + discovered.row.id);
    db.exec("UPDATE attachments SET status='FETCHING' WHERE id='" + discovered.row.id + "'");
    vi.setSystemTime(new Date('2026-10-15T01:00:00Z'));
    expect(await markAttachmentStored(env, discovered.row.id, bytes.length, getAttachmentConfig(env))).toBe(true);
    const row = await db.prepare('SELECT * FROM attachments WHERE id=?').bind(discovered.row.id).first<any>();
    expect(row.stored_at).toBe(1792026000);
    expect(row.retention_expires_at - row.stored_at).toBe(259200);
    expect(row.grant_expires_at).toBe(row.retention_expires_at);
    expect(row.retention_class).toBe('FILE');
    expect(attachmentByteSize(row)).toBe(bytes.length);
    expect(effectiveExpiry(row)).toBe(row.retention_expires_at);
    vi.setSystemTime(new Date('2026-10-16T01:00:00Z'));
    expect(await markAttachmentStored(env, row.id, bytes.length, getAttachmentConfig(env))).toBe(false);
    expect((await db.prepare('SELECT stored_at FROM attachments WHERE id=?').bind(row.id).first<any>()).stored_at).toBe(row.stored_at);
  });

  it('keeps expired metadata after R2 deletion failure and retries before tombstoning, preserving foreign keys', async () => {
    const db = database(); const bytes = new TextEncoder().encode('data'); const storage = bucket(bytes);
    const env = { DB: db, ATTACHMENTS_BUCKET: storage } as any;
    const discovered = await discoverAttachment(env, getAttachmentConfig(env), 'conv', 'upload', 'invite', {
      sourceAttachmentRef: 'cleanup-id', attachmentType: 'document', locator: { provider: 'upload', inviteId: 'invite', uploadId: 'cleanup-id' }
    }, 'telegram');
    db.exec("UPDATE attachments SET status='STORED',stored_at=1,retention_expires_at=2,expires_at=2 WHERE id='" + discovered.row.id + "'");
    storage.delete.mockRejectedValueOnce(new Error('synthetic R2 outage'));
    await cleanupExpiredAttachments(env);
    let row = await db.prepare('SELECT * FROM attachments WHERE id=?').bind(discovered.row.id).first<any>();
    expect(row.deleted_at).toBeNull();
    expect(row.storage_key).toBe(discovered.row.storage_key);
    expect(row.cleanup_attempts).toBe(1);
    db.exec("UPDATE attachments SET cleanup_next_retry_at=0 WHERE id='" + row.id + "'");
    await cleanupExpiredAttachments(env);
    row = await db.prepare('SELECT * FROM attachments WHERE id=?').bind(row.id).first<any>();
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(storage.delete).toHaveBeenCalledTimes(2);
    await cleanupExpiredAttachments(env);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('never admits an expired pending object after its cleanup deadline', async () => {
    const db = database(); const bytes = new TextEncoder().encode('expired upload');
    const env = { DB: db, ATTACHMENTS_BUCKET: bucket(bytes) } as any;
    const item = await discoverAttachment(env, getAttachmentConfig(env), 'conv', 'upload', 'old-invite', {
      sourceAttachmentRef: 'late', attachmentType: 'document', locator: { provider: 'upload', inviteId: 'old-invite', uploadId: 'late' }
    }, 'telegram');
    db.exec("UPDATE attachments SET status='FETCHING',expires_at=1 WHERE id='" + item.row.id + "'");
    expect(await markAttachmentStored(env, item.row.id, bytes.length, getAttachmentConfig(env))).toBe(false);
    expect((await db.prepare('SELECT stored_at FROM attachments WHERE id=?').bind(item.row.id).first<any>()).stored_at).toBeNull();
  });
});
