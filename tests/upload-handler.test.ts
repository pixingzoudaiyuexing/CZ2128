import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import { handleUploadCapabilityRequest } from '../src/uploads/handler';
import { processAttachmentTransfer } from '../src/attachments/handler';
import { handleAttachmentProxy } from '../src/attachments/proxy';
import {
  deriveUploadDownloadToken,
  deriveUploadInviteToken,
  hashUploadCapability
} from '../src/uploads/capability';

const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  metadata = new Map<string, any>();
  deleted: string[] = [];

  async createMultipartUpload(key: string, options?: any) {
    const parts = new Map<number, Uint8Array>();
    this.metadata.set(key, options || {});
    return {
      uploadPart: async (partNumber: number, value: Uint8Array) => {
        parts.set(partNumber, value.slice());
        return { partNumber, etag: 'part-' + partNumber };
      },
      complete: async () => {
        const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
        const size = ordered.reduce((sum, value) => sum + value.byteLength, 0);
        const merged = new Uint8Array(size);
        let offset = 0;
        for (const value of ordered) {
          merged.set(value, offset);
          offset += value.byteLength;
        }
        this.objects.set(key, merged);
      },
      abort: async () => undefined
    };
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }

  async get(key: string, options?: any) {
    const original = this.objects.get(key);
    if (!original) return null;
    const offset = options?.range?.offset || 0;
    const length = options?.range?.length ?? original.byteLength;
    const bytes = original.slice(offset, offset + length);
    return {
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.buffer
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
    this.deleted.push(key);
  }
}

describe('Crisp temporary upload capability', () => {
  let db: SqliteD1;
  let bucket: MemoryBucket;
  let queue: any[];
  let env: any;
  let inviteToken: string;
  let inviteId: string;

  beforeEach(async () => {
    db = new SqliteD1();
    db.migrate();
    bucket = new MemoryBucket();
    queue = [];
    inviteId = 'uplinv_test';
    inviteToken = await deriveUploadInviteToken(SECRET, inviteId);
    const tokenHash = await hashUploadCapability(inviteToken);
    const now = Math.floor(Date.now() / 1000);

    await db.prepare(
      `INSERT INTO conversations
       (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
        operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
       VALUES ('conv', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO upload_invites
       (id, token_hash, conversation_id, crisp_website_ref, crisp_session_ref,
        telegram_group_ref, telegram_thread_ref, support_profile_version,
        created_by_operator_ref, created_from_update_ref, status, expires_at,
        max_files, max_total_bytes, consumed_files, consumed_bytes, version,
        created_at, updated_at)
       VALUES (?, ?, 'conv', 'site', 'session', '-100', '77', 0, '42', '100',
               'ACTIVE', ?, 1, 20971520, 0, 0, 1, ?, ?)`
    ).bind(inviteId, tokenHash, now + 900, now, now).run();

    env = {
      DB: db,
      QUEUE: { send: async (value: any) => { queue.push(value); } },
      ATTACHMENTS_BUCKET: bucket,
      BOT_GROUP_ID: '-100',
      TELEGRAM_BOT_TOKEN: 'bot-secret-token',
      CRISP_API_IDENTIFIER: 'crisp-id',
      CRISP_API_KEY: 'crisp-key',
      CHATWOOT_API_URL: 'https://chat.example',
      UPLOAD_CAPABILITY_SECRET: SECRET
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function uploadRequest(
    uploadId = UPLOAD_ID,
    filename = 'report.txt',
    mime = 'text/plain',
    body = 'hello'
  ) {
    return new Request('https://worker.example/uploads/' + inviteToken, {
      method: 'POST',
      headers: {
        'Content-Type': mime,
        'Content-Length': String(new TextEncoder().encode(body).byteLength),
        'X-CZ2128-Upload-Id': uploadId,
        'X-CZ2128-Filename': encodeURIComponent(filename)
      },
      body
    });
  }

  it('renders an active no-store capability page without internal routing identifiers', async () => {
    const response = await handleUploadCapabilityRequest(
      new Request('https://worker.example/uploads/' + inviteToken),
      env,
      inviteToken
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).not.toContain('session');
    expect(html).not.toContain('site');
    expect(html).not.toContain('77');
    expect(html).not.toContain(inviteId);
  });

  it('rejects provider/topic/profile drift before accepting bytes', async () => {
    await db.prepare("UPDATE conversations SET operator_thread_ref = '78' WHERE id = 'conv'").run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleUploadCapabilityRequest(uploadRequest(), env, inviteToken);
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucket.objects.size).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('fails closed when Crisp authoritative state is resolved', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { state: 'resolved' } }), { status: 200 })
    );
    const response = await handleUploadCapabilityRequest(uploadRequest(), env, inviteToken);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CONVERSATION_RESOLVED' });
    expect(bucket.objects.size).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it.each([
    ['photo.png', 'image/png'],
    ['page.html', 'text/html'],
    ['vector.svg', 'image/svg+xml'],
    ['tool.exe', 'application/octet-stream']
  ])('rejects blocked upload %s before R2 write', async (filename, mime) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { state: 'unresolved' } }), { status: 200 })
    );
    const response = await handleUploadCapabilityRequest(
      uploadRequest(UPLOAD_ID, filename, mime, 'blocked'),
      env,
      inviteToken
    );
    expect(response.status).toBe(415);
    expect(bucket.objects.size).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('stores one ordinary file privately, survives exhausted-invite retry, and sends one controlled Topic link', async () => {
    const bytes = new TextEncoder().encode('hello');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/state')) {
        return new Response(JSON.stringify({ data: { state: 'unresolved' } }), { status: 200 });
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), { status: 200 });
      }
      throw new Error('unexpected fetch ' + url);
    });

    const first = await handleUploadCapabilityRequest(uploadRequest(), env, inviteToken);
    expect(first.status).toBe(202);
    expect(queue).toHaveLength(1);

    const invite = await db.prepare(
      'SELECT status, consumed_files, consumed_bytes FROM upload_invites WHERE id = ?'
    ).bind(inviteId).first<any>();
    expect(invite).toEqual({ status: 'EXHAUSTED', consumed_files: 1, consumed_bytes: bytes.byteLength });

    const item = await db.prepare(
      'SELECT status, size_bytes, attachment_id FROM upload_invite_items WHERE invite_id = ? AND upload_id = ?'
    ).bind(inviteId, UPLOAD_ID).first<any>();
    expect(item).toMatchObject({ status: 'ACCEPTED', size_bytes: bytes.byteLength });

    const attachment = await db.prepare('SELECT * FROM attachments WHERE id = ?')
      .bind(item.attachment_id).first<any>();
    expect(attachment).toMatchObject({
      source_provider: 'upload',
      destination_provider: 'telegram',
      status: 'STORED',
      size_bytes: bytes.byteLength,
      original_filename: 'report.txt'
    });

    const downloadToken = await deriveUploadDownloadToken(SECRET, inviteId, UPLOAD_ID);
    expect(attachment.access_token_hash).toBe(await hashUploadCapability(downloadToken));
    expect(attachment.access_token_hash).not.toBe(downloadToken);
    expect(JSON.stringify(attachment)).not.toContain(SECRET);
    expect(bucket.objects.get(attachment.storage_key)).toEqual(bytes);
    expect(JSON.stringify(bucket.metadata.get(attachment.storage_key))).not.toContain(downloadToken);
    expect(JSON.stringify(bucket.metadata.get(attachment.storage_key))).not.toContain(SECRET);

    // The invite is already EXHAUSTED, but the same accepted upload id remains recoverable.
    const retry = await handleUploadCapabilityRequest(uploadRequest(), env, inviteToken);
    expect(retry.status).toBe(202);
    expect(queue).toHaveLength(2);
    expect(await db.prepare(
      'SELECT consumed_files, consumed_bytes FROM upload_invites WHERE id = ?'
    ).bind(inviteId).first<any>()).toEqual({
      consumed_files: 1,
      consumed_bytes: bytes.byteLength
    });

    // A different upload id is not accepted after exhaustion.
    const different = await handleUploadCapabilityRequest(
      uploadRequest('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'other.txt', 'text/plain', 'other'),
      env,
      inviteToken
    );
    expect(different.status).toBe(404);

    await processAttachmentTransfer(queue[0], env);
    await processAttachmentTransfer(queue[1], env);

    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/sendMessage'))).toHaveLength(1);
    const telegramCall = fetchMock.mock.calls.find(call => String(call[0]).includes('/sendMessage'));
    const telegramBody = JSON.parse(String(telegramCall?.[1]?.body));
    expect(telegramBody).toMatchObject({ chat_id: '-100', message_thread_id: '77' });
    expect(telegramBody.text).toContain('report.txt');
    expect(telegramBody.text).toContain('/attachments/' + downloadToken + '/download');
    expect(telegramBody.text).not.toContain(attachment.storage_key);
    expect(telegramBody.text).not.toContain('bot-secret-token');
    expect(telegramBody.text).not.toContain(SECRET);

    expect(await db.prepare('SELECT status, destination_message_ref FROM attachments WHERE id = ?')
      .bind(attachment.id).first<any>()).toEqual({
      status: 'DELIVERED',
      destination_message_ref: '501'
    });
    expect(await db.prepare(
      "SELECT status, operation_type, destination_provider FROM outbound_operations WHERE id = ?"
    ).bind('attachment_telegram:' + attachment.id).first<any>()).toEqual({
      status: 'SENT',
      operation_type: 'SEND_ATTACHMENT',
      destination_provider: 'telegram'
    });

    // Invite expiry/exhaustion does not revoke an already accepted attachment download capability.
    const proxy = await handleAttachmentProxy(
      new Request('https://worker.example/attachments/' + downloadToken + '/download'),
      env,
      downloadToken,
      'download'
    );
    expect(proxy.status).toBe(200);
    expect(await proxy.text()).toBe('hello');
    expect(proxy.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });
});
