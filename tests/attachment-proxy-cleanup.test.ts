import { describe, expect, it, vi } from 'vitest';
import { cleanupExpiredAttachments } from '../src/attachments/cleanup';
import { handleAttachmentProxy } from '../src/attachments/proxy';
import { generateAttachmentToken, hashAttachmentToken } from '../src/core/attachments';

class ProxyDb {
  attachments: any[] = [];
  uploadInvites: any[] = [];
  uploadInviteItems: any[] = [];
  failAttachmentDeleteFor = new Set<string>();

  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      first: async () => {
        if (!query.includes('FROM attachments')) return null;
        return this.attachments.find(row =>
          row.access_token_hash === params[0] && row.expires_at > params[1] &&
          (['STORED', 'DELIVERED'].includes(row.status) ||
           (row.status === 'FAILED_FINAL' && row.last_error === 'ATTACHMENT_DELIVERY_AMBIGUOUS'))) || null;
      },
      all: async () => ({
        results: this.attachments
          .filter(row => row.expires_at !== null && row.expires_at <= params[0])
          .sort((left, right) => left.expires_at - right.expires_at || left.id.localeCompare(right.id))
          .slice(0, params[1])
      }),
      run: async () => {
        if (query.startsWith('DELETE FROM upload_invite_items')) {
          const attachmentId = params[0];
          const now = params[1];
          const before = this.uploadInviteItems.length;
          this.uploadInviteItems = this.uploadInviteItems.filter(item => {
            if (item.attachment_id !== attachmentId) return true;
            const invite = this.uploadInvites.find(row => row.id === item.invite_id);
            if (!invite) return true;
            return invite.status === 'ACTIVE' && invite.expires_at > now;
          });
          return { meta: { changes: before - this.uploadInviteItems.length } };
        }

        if (!query.startsWith('DELETE FROM attachments')) return { meta: { changes: 0 } };
        if (this.failAttachmentDeleteFor.has(params[0])) throw new Error('d1 cleanup failure');
        if (this.uploadInviteItems.some(item => item.attachment_id === params[2])) {
          return { meta: { changes: 0 } };
        }
        const index = this.attachments.findIndex(row => row.id === params[0] && row.expires_at <= params[1]);
        if (index < 0) return { meta: { changes: 0 } };
        this.attachments.splice(index, 1);
        return { meta: { changes: 1 } };
      }
    };
    return statement;
  }

  async batch(statements: any[]) {
    const snapshot = {
      attachments: this.attachments.map(row => ({ ...row })),
      uploadInvites: this.uploadInvites.map(row => ({ ...row })),
      uploadInviteItems: this.uploadInviteItems.map(row => ({ ...row }))
    };
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.attachments = snapshot.attachments;
      this.uploadInvites = snapshot.uploadInvites;
      this.uploadInviteItems = snapshot.uploadInviteItems;
      throw error;
    }
  }
}

class ProxyBucket {
  bytes = new TextEncoder().encode('0123456789');
  missing = false;
  getCalls: any[] = [];
  deleted: string[] = [];
  failDeleteFor = new Set<string>();

  async head() {
    return this.missing ? null : { size: this.bytes.byteLength };
  }

  async get(_key: string, options?: any) {
    this.getCalls.push(options);
    if (this.missing) return null;
    const offset = options?.range?.offset || 0;
    const length = options?.range?.length ?? this.bytes.byteLength;
    const value = this.bytes.slice(offset, offset + length);
    return { size: value.byteLength, body: new Blob([value]).stream(), arrayBuffer: async () => value.buffer };
  }

  async delete(key: string) {
    if (this.failDeleteFor.has(key)) throw new Error('private R2 error');
    this.deleted.push(key);
  }
}

async function fixture(status = 'STORED', expiresOffset = 3600) {
  const token = generateAttachmentToken();
  return {
    token,
    row: {
      id: 'att_proxy', access_token_hash: await hashAttachmentToken(token),
      storage_key: 'attachments/att_proxy', safe_filename: 'safe_文件.txt',
      mime_type: 'application/octet-stream', status, last_error: null as string | null,
      expires_at: Math.floor(Date.now() / 1000) + expiresOffset
    }
  };
}

describe('secure attachment proxy', () => {
  it('serves GET with private download headers', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture();
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}`),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any,
      item.token
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''");
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('serves HEAD with identical metadata and no R2 body read', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture('DELIVERED');
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}`, { method: 'HEAD' }),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any,
      item.token
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(bucket.getCalls).toHaveLength(0);
  });

  it('defines HEAD range as metadata-only partial response', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture();
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}`, { method: 'HEAD', headers: { Range: 'bytes=2-4' } }),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any,
      item.token
    );
    expect(response.status).toBe(206);
    expect(response.body).toBeNull();
    expect(response.headers.get('Content-Range')).toBe('bytes 2-4/10');
    expect(response.headers.get('Content-Length')).toBe('3');
    expect(bucket.getCalls).toHaveLength(0);
  });

  it.each([
    ['bytes=0-2', '012', 'bytes 0-2/10'],
    ['bytes=4-', '456789', 'bytes 4-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10']
  ])('serves single range %s', async (range, body, contentRange) => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture();
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}`, { headers: { Range: range } }),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any,
      item.token
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Content-Length')).toBe(String(body.length));
  });

  it.each(['bytes=20-', 'bytes=0-1,3-4'])('returns 416 for invalid range %s', async range => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture();
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}`, { headers: { Range: range } }),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any,
      item.token
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('returns the same 404 for malformed, unknown, expired and missing-object tokens', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const expired = await fixture('STORED', -1);
    db.attachments.push(expired.row);
    const unknown = generateAttachmentToken();

    expect((await handleAttachmentProxy(new Request('https://worker.example/attachments/bad'), { DB: db, ATTACHMENTS_BUCKET: bucket } as any, 'bad')).status).toBe(404);
    const unknownResponse = await handleAttachmentProxy(new Request(`https://worker.example/attachments/${unknown}`), { DB: db, ATTACHMENTS_BUCKET: bucket } as any, unknown);
    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await handleAttachmentProxy(new Request(`https://worker.example/attachments/${expired.token}`), { DB: db, ATTACHMENTS_BUCKET: bucket } as any, expired.token)).status).toBe(404);

    const valid = await fixture();
    db.attachments.push(valid.row);
    bucket.missing = true;
    expect((await handleAttachmentProxy(new Request(`https://worker.example/attachments/${valid.token}`), { DB: db, ATTACHMENTS_BUCKET: bucket } as any, valid.token)).status).toBe(404);
  });
  it('serves image mode inline repeatedly until expiry without consuming the token', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture();
    item.row.mime_type = 'image/png';
    item.row.safe_filename = 'image.png';
    db.attachments.push(item.row);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleAttachmentProxy(
        new Request(`https://worker.example/attachments/${item.token}/inline`),
        { DB: db, ATTACHMENTS_BUCKET: bucket } as any, item.token, 'inline'
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
      await response.arrayBuffer();
    }
    expect(bucket.getCalls).toHaveLength(2);
  });

  it('never serves ordinary files through inline mode', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture();
    item.row.mime_type = 'image/svg+xml';
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}/inline`),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any, item.token, 'inline'
    );
    expect(response.status).toBe(404);
    expect(bucket.getCalls).toHaveLength(0);
  });

  it('keeps a possibly delivered AMBIGUOUS Crisp capability readable until TTL', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const item = await fixture('FAILED_FINAL');
    item.row.last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS';
    db.attachments.push(item.row);
    const response = await handleAttachmentProxy(
      new Request(`https://worker.example/attachments/${item.token}/download`),
      { DB: db, ATTACHMENTS_BUCKET: bucket } as any, item.token, 'download'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });
});

describe('attachment cleanup', () => {
  it('deletes expired D1 metadata before removing managed R2 objects', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    db.attachments.push(
      { id: 'stored', storage_key: 'attachments/stored', expires_at: now - 2, status: 'STORED' },
      { id: 'delivered', storage_key: 'attachments/delivered', expires_at: now - 1, status: 'DELIVERED' },
      { id: 'future', storage_key: 'attachments/future', expires_at: now + 1, status: 'STORED' }
    );

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(bucket.deleted).toEqual(['attachments/stored', 'attachments/delivered']);
    expect(db.attachments.map(row => row.id)).toEqual(['future']);
  });

  it('keeps an expired attachment while an active unexpired upload invite still references it', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    db.attachments.push({ id: 'active-ref', storage_key: 'attachments/active-ref', expires_at: now - 1, status: 'DELIVERED' });
    db.uploadInvites.push({ id: 'inv-active', status: 'ACTIVE', expires_at: now + 60 });
    db.uploadInviteItems.push({ invite_id: 'inv-active', upload_id: 'u1', attachment_id: 'active-ref' });

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(db.attachments.map(row => row.id)).toEqual(['active-ref']);
    expect(db.uploadInviteItems).toHaveLength(1);
    expect(bucket.deleted).toEqual([]);
  });

  it('atomically removes an expired upload-invite reference before deleting attachment metadata and R2', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    db.attachments.push({ id: 'expired-ref', storage_key: 'attachments/expired-ref', expires_at: now - 1, status: 'DELIVERED' });
    db.uploadInvites.push({ id: 'inv-expired', status: 'ACTIVE', expires_at: now - 1 });
    db.uploadInviteItems.push({ invite_id: 'inv-expired', upload_id: 'u1', attachment_id: 'expired-ref' });

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(db.uploadInviteItems).toEqual([]);
    expect(db.attachments).toEqual([]);
    expect(bucket.deleted).toEqual(['attachments/expired-ref']);
  });

  it('does not touch R2 and rolls back upload-item deletion when the D1 batch fails', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    db.attachments.push({ id: 'd1-fail', storage_key: 'attachments/d1-fail', expires_at: now - 1, status: 'DELIVERED' });
    db.uploadInvites.push({ id: 'inv-done', status: 'REVOKED', expires_at: now + 60 });
    db.uploadInviteItems.push({ invite_id: 'inv-done', upload_id: 'u1', attachment_id: 'd1-fail' });
    db.failAttachmentDeleteFor.add('d1-fail');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(db.attachments).toHaveLength(1);
    expect(db.uploadInviteItems).toHaveLength(1);
    expect(bucket.deleted).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps logical expiry safe when R2 deletion fails after D1 metadata is removed', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    db.attachments.push({ id: 'r2-fail', storage_key: 'attachments/r2-fail', expires_at: now - 1, status: 'DELIVERED' });
    bucket.failDeleteFor.add('attachments/r2-fail');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(db.attachments).toEqual([]);
    expect(bucket.deleted).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('attachments/r2-fail'));
  });

  it('fails closed for storage keys outside the managed attachments prefix', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    db.attachments.push({ id: 'unsafe', storage_key: 'quarantine/not-an-attachment', expires_at: now - 1, status: 'DELIVERED' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(db.attachments.map(row => row.id)).toEqual(['unsafe']);
    expect(bucket.deleted).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('quarantine/not-an-attachment'));
  });

  it('respects the cleanup batch limit', async () => {
    const db = new ProxyDb();
    const bucket = new ProxyBucket();
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < 101; index++) {
      db.attachments.push({ id: `att_${index}`, storage_key: `attachments/key_${index}`, expires_at: now - 1, status: 'STORED' });
    }

    await cleanupExpiredAttachments({ DB: db, ATTACHMENTS_BUCKET: bucket } as any);
    expect(bucket.deleted).toHaveLength(100);
    expect(db.attachments).toHaveLength(1);
  });
});
