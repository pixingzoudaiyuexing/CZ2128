import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processAttachmentTransfer } from '../src/attachments/handler';
import { generateAttachmentToken, hashAttachmentToken } from '../src/core/attachments';
import { RetryableProcessingError } from '../src/core/errors';
import { AttachmentTransferEvent } from '../src/core/events';

class HandlerDb {
  attachments: any[] = [];
  conversations = [{
    id: 'conv', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
    operator_thread_ref: '7'
  }];
  outbound: any[] = [];
  lastOutboundLeaseUntil = 0;
  failStoredPersistence = false;

  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      first: async () => {
        if (query.includes('FROM attachments')) {
          const row = this.attachments.find(item => item.id === params[0]);
          if (!row) return null;
          return query.includes('attempt_count') ? { attempt_count: row.attempt_count } : { ...row };
        }
        if (query.includes('FROM conversations')) {
          return this.conversations.find(item => item.id === params[0]) || null;
        }
        if (query.includes('FROM outbound_operations')) {
          const row = this.outbound.find(item => item.id === params[0]);
          return row ? { ...row } : null;
        }
        return null;
      },
      run: async () => this.run(query, params)
    };
    return statement;
  }

  private run(query: string, params: any[]) {
    let changes = 0;

    if (query.includes("status = 'SENDING'") && query.includes("lease_until = ?")) {
      const row = this.outbound.find(item => item.id === params[3]);
      if (row && ['PENDING', 'FAILED_RETRYABLE'].includes(row.status)) {
        row.status = 'SENDING'; row.lease_until = params[0]; row.lease_token = params[1]; row.request_started_at = null; row.response_observed_at = null; row.response_http_status = null;
        this.lastOutboundLeaseUntil = params[0]; 
        return { meta: { changes: 1 } };
      }
    }
    if (query.includes("request_started_at = ?, attempt_count = attempt_count + 1")) {
      const row = this.outbound.find(x => x.id === params[2]);
      if (row && row.status === 'SENDING' && row.lease_token === params[3] && row.request_started_at == null) {
        row.request_started_at = params[0]; row.attempt_count++; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("response_observed_at = ?")) {
      const row = this.outbound.find(x => x.id === params[3]);
      if (row && row.status === 'SENDING' && row.lease_token === params[4] && row.request_started_at != null) {
        row.response_observed_at = params[0]; row.response_http_status = params[1]; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("status = 'PENDING', lease_until = NULL, lease_token = NULL,") && query.includes("request_started_at IS NULL")) {
      const row = this.outbound.find(x => x.id === params[1]);
      if (row && row.status === 'SENDING' && (row.lease_until || 0) <= params[2] && row.lease_token === params[3] && row.request_started_at === null) {
        row.status = 'PENDING'; row.lease_until = null; row.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("status = 'AMBIGUOUS', reconciliation_status = 'PENDING'") && query.includes("lease_until <=")) {
      const row = this.outbound.find(x => x.id === params[1]);
      if (row && row.status === 'SENDING' && (row.lease_until === null || (row.lease_until || 0) <= params[2]) && (!row.lease_token || row.lease_token === params[3])) {
        row.status = 'AMBIGUOUS'; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("status = 'FAILED_FINAL', last_error = 'OUTBOUND_RETRY_EXHAUSTED'")) {
      const row = this.outbound.find(x => x.id === params[1]);
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'FAILED_FINAL'; row.last_error = 'OUTBOUND_RETRY_EXHAUSTED'; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("status = 'SENT'") && query.includes("provider_message_ref = ?")) {
      const row = this.outbound.find(item => item.id === params[2]);
      if (row?.status === 'SENDING' && row.lease_token === params[3] && !this.failStoredPersistence) {
        row.status = 'SENT'; row.provider_message_ref = params[0]; row.lease_until = null; row.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes('SET status = ?, last_error = ?, lease_until = NULL')) {
      const row = this.outbound.find(item => item.id === params[6]);
      if (row?.status === 'SENDING' && row.lease_token === params[7]) {
        row.status = params[0]; row.last_error = params[1]; row.lease_until = null; row.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("status = 'AMBIGUOUS', last_error = 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED'")) {
      const row = this.outbound.find(item => item.id === params[1]);
      if (row?.status === 'SENDING' && row.lease_token === params[2]) {
        row.status = 'AMBIGUOUS'; row.lease_until = null; row.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (query.includes("status = 'FAILED_FINAL', last_error = ?")) {
      const row = this.outbound.find(item => item.id === params[2]);
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'FAILED_FINAL'; row.last_error = params[0]; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (query.includes("SET status = 'FETCHING'")) {
      const row = this.attachments.find(item => item.id === params[1]);
      if (row && row.attempt_count < params[2] && ['PENDING', 'FETCHING', 'FAILED_RETRYABLE'].includes(row.status)) {
        row.status = 'FETCHING'; row.attempt_count += 1; changes = 1;
      }
    } else if (query.includes("SET status = 'STORED'")) {
      const row = this.attachments.find(item => item.id === params[3] && item.status === 'FETCHING');
      if (row && !this.failStoredPersistence) {
        row.status = 'STORED'; row.size_bytes = params[0]; row.expires_at = params[1]; changes = 1;
      }
    } else if (query.includes("SET status = 'DELIVERED'")) {
      const row = this.attachments.find(item => item.id === params[2] && item.status === 'STORED');
      if (row) { row.status = 'DELIVERED'; row.destination_message_ref = params[0]; changes = 1; }
    } else if (query.includes('UPDATE attachments') && query.includes('SET status = ?, last_error = ?')) {
      const row = this.attachments.find(item => item.id === params[5] && item.status !== 'DELIVERED');
      if (row) {
        row.status = params[0]; row.last_error = params[1];
        if (params[2] === 'FAILED_FINAL' && !row.expires_at) row.expires_at = params[3];
        changes = 1;
      }
    } else if (query.includes("WHERE id = ? AND status = 'STORED'")) {
      const row = this.attachments.find(item => item.id === params[2] && item.status === 'STORED');
      if (row) { row.last_error = params[0]; changes = 1; }
    } else if (query.includes('INSERT INTO outbound_operations')) {
      if (!this.outbound.some(item => item.id === params[0])) {
        this.outbound.push({
          id: params[0], conversation_id: params[1], destination_provider: params[2],
          operation_type: params[3], status: params[4], attempt_count: 0,
          created_at: params[5], updated_at: params[6]
        });
        changes = 1;
      }
    } else if (query.includes('attempt_count = attempt_count + 1')) {
      const row = this.outbound.find(item => item.id === params[3]);
      if (row && ['PENDING', 'FAILED_RETRYABLE'].includes(row.status)) {
        this.lastOutboundLeaseUntil = params[0];
        row.status = 'SENDING'; row.lease_until = params[0]; row.lease_token = params[1];
        row.attempt_count += 1; changes = 1;
      }
    } else if (query.includes("SET status = 'SENT'")) {
      const row = this.outbound.find(item => item.id === params[2]);
      if (row?.status === 'SENDING' && row.lease_token === params[3]) {
        row.status = 'SENT'; row.provider_message_ref = params[0]; row.lease_token = null; changes = 1;
      }
    } else if (query.includes('SET status = ?, last_error = ?')) {
      const row = this.outbound.find(item => item.id === params[3]);
      if (row?.status === 'SENDING' && row.lease_token === params[4]) {
        row.status = params[0]; row.last_error = params[1]; row.lease_token = null; changes = 1;
      }
    } else if (query.includes("SET status = 'AMBIGUOUS'")) {
      const row = this.outbound.find(item => item.id === params[1]);
      if (row?.status === 'SENDING') { row.status = 'AMBIGUOUS'; changes = 1; }
    }
    return { meta: { changes } };
  }
}

function bucket() {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    get: async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer })
  };
}

async function setup(sourceProvider: 'telegram' | 'chatwoot', status = 'STORED') {
  const token = generateAttachmentToken();
  const db = new HandlerDb();
  db.attachments.push({
    id: 'att', conversation_id: 'conv', source_provider: sourceProvider,
    source_message_ref: 'message', source_attachment_ref: 'source', attachment_type: 'document',
    original_filename: 'a.txt', safe_filename: 'a.txt', mime_type: 'text/plain', size_bytes: 3,
    storage_key: 'attachments/att', access_token_hash: await hashAttachmentToken(token), status,
    destination_provider: sourceProvider === 'telegram' ? 'chatwoot' : 'telegram',
    destination_message_ref: null, attempt_count: status === 'PENDING' ? 0 : 1,
    expires_at: 9999999999, last_error: null
  });
  const event: AttachmentTransferEvent = {
    version: 1, source: 'internal', type: 'attachment_transfer', eventId: 'attachment:att',
    payload: {
      attachmentId: 'att', accessToken: token,
      locator: sourceProvider === 'telegram'
        ? { provider: 'telegram', fileId: 'file' }
        : { provider: 'chatwoot', dataUrl: 'https://chatwoot.example/a' }
    }
  };
  return { db, event, env: {
    DB: db, ATTACHMENTS_BUCKET: bucket(), CHATWOOT_API_URL: 'https://chatwoot.example',
    CHATWOOT_API_TOKEN: 'token', TELEGRAM_BOT_TOKEN: 'bot', BOT_GROUP_ID: '-100'
  } as any };
}

describe('attachment transfer ledger', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each(['telegram', 'chatwoot'] as const)('delivers a duplicate %s attachment job visibly once', async source => {
    const fixture = await setup(source);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(source === 'telegram'
      ? new Response(JSON.stringify({ id: 1 }), { status: 200 })
      : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));

    await processAttachmentTransfer(fixture.event, fixture.env);
    await processAttachmentTransfer(fixture.event, fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.attachments[0].status).toBe('DELIVERED');
    expect(fixture.db.outbound[0].status).toBe('SENT');
  });

  it.each([
    ['transport', null],
    ['HTTP 503', 503],
    ['invalid success', 200]
  ] as const)('marks destination %s AMBIGUOUS and never invokes it again', async (_label, status) => {
    const fixture = await setup('telegram');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    if (status === null) fetchMock.mockRejectedValue(new Error('response lost'));
    else if (status === 200) fetchMock.mockResolvedValue(new Response('{}', { status }));
    else fetchMock.mockResolvedValue(new Response('provider private body', { status }));

    await processAttachmentTransfer(fixture.event, fixture.env);
    await processAttachmentTransfer(fixture.event, fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.outbound[0].status).toBe('AMBIGUOUS');
    expect(fixture.db.attachments[0].status).toBe('FAILED_FINAL');
  });

  it('retries only the destination after HTTP 429 and then marks delivered', async () => {
    const fixture = await setup('telegram');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 200 }));

    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    expect(fixture.db.attachments[0].status).toBe('STORED');
    expect(fixture.db.lastOutboundLeaseUntil - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(60);
    await processAttachmentTransfer(fixture.event, fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.db.outbound[0].attempt_count).toBe(2);
    expect(fixture.db.attachments[0].status).toBe('DELIVERED');
  });

  it('rejects a superseded Queue token before consuming an attachment attempt', async () => {
    const fixture = await setup('telegram');
    fixture.event.payload.accessToken = generateAttachmentToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    expect(fixture.db.attachments[0].attempt_count).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams a Telegram source through multipart R2 storage before Chatwoot delivery', async () => {
    const fixture = await setup('telegram', 'PENDING');
    const storedParts: Uint8Array[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    fixture.env.ATTACHMENTS_BUCKET = {
      createMultipartUpload: async () => ({
        uploadPart: async (partNumber: number, value: Uint8Array) => {
          storedParts.push(value.slice());
          return { partNumber, etag: `part-${partNumber}` };
        },
        complete: async () => undefined,
        abort: async () => undefined
      }),
      get: async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer })
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/private.bin' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob([bytes]).stream(), { status: 200, headers: { 'Content-Length': '3' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 }), { status: 200 }));

    await processAttachmentTransfer(fixture.event, fixture.env);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(storedParts.reduce((total, part) => total + part.byteLength, 0)).toBe(3);
    expect(fixture.db.attachments[0].status).toBe('DELIVERED');
    expect(fixture.db.attachments[0].expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(JSON.stringify(fixture.db.attachments[0])).not.toContain('docs/private.bin');
    expect(JSON.stringify(fixture.db.attachments[0])).not.toContain('bot');
  });

  it('marks R2 multipart failure retryable without persisting private details', async () => {
    const fixture = await setup('telegram', 'PENDING');
    fixture.env.ATTACHMENTS_BUCKET = {
      createMultipartUpload: async () => ({
        uploadPart: async () => { throw new Error('private R2 provider detail'); },
        complete: async () => undefined,
        abort: async () => undefined
      })
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/token-path' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob([new Uint8Array([1])]).stream(), { status: 200 }));

    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    expect(fixture.db.attachments[0].status).toBe('FAILED_RETRYABLE');
    expect(fixture.db.attachments[0].last_error).toBe('R2_STORE_TRANSIENT');
    expect(JSON.stringify(fixture.db.attachments[0])).not.toContain('token-path');
    expect(JSON.stringify(fixture.db.attachments[0])).not.toContain('private R2');
  });

  it('keeps STORED status when R2 read fails so retry does not redownload source', async () => {
    const fixture = await setup('telegram');
    fixture.env.ATTACHMENTS_BUCKET = { get: async () => { throw new Error('private read failure'); } };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    expect(fixture.db.attachments[0].status).toBe('STORED');
    expect(fixture.db.attachments[0].last_error).toBe('R2_READ_TRANSIENT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks an exhausted FETCHING attachment final without source or R2 execution', async () => {
    const fixture = await setup('telegram', 'PENDING');
    fixture.db.attachments[0].status = 'FETCHING';
    fixture.db.attachments[0].attempt_count = 3;
    const createMultipartUpload = vi.fn();
    fixture.env.ATTACHMENTS_BUCKET = { createMultipartUpload };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await processAttachmentTransfer(fixture.event, fixture.env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createMultipartUpload).not.toHaveBeenCalled();
    expect(fixture.db.attachments[0].status).toBe('FAILED_FINAL');
    expect(fixture.db.attachments[0].last_error).toBe('ATTACHMENT_RETRY_EXHAUSTED');
  });

  it('bounds retries when R2 completes but the STORED transition is not persisted', async () => {
    const fixture = await setup('telegram', 'PENDING');
    fixture.db.failStoredPersistence = true;
    const bytes = new Uint8Array([1]);
    const createMultipartUpload = vi.fn(async () => ({
      uploadPart: async (partNumber: number) => ({ partNumber, etag: `part-${partNumber}` }),
      complete: async () => undefined,
      abort: async () => undefined
    }));
    fixture.env.ATTACHMENTS_BUCKET = { createMultipartUpload };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) =>
      String(url).includes('/getFile')
        ? new Response(JSON.stringify({ ok: true, result: { file_path: 'file' } }), { status: 200 })
        : new Response(new Blob([bytes]).stream(), { status: 200 })
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    }
    await expect(processAttachmentTransfer(fixture.event, fixture.env)).resolves.toBeUndefined();

    expect(fixture.db.attachments[0].attempt_count).toBe(3);
    expect(fixture.db.attachments[0].status).toBe('FAILED_FINAL');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(createMultipartUpload).toHaveBeenCalledTimes(3);
  });

  it('allows a normal retryable source/storage failure to succeed on the next attempt', async () => {
    const fixture = await setup('telegram', 'PENDING');
    const bytes = new Uint8Array([1]);
    let storageAttempt = 0;
    fixture.env.ATTACHMENTS_BUCKET = {
      createMultipartUpload: async () => ({
        uploadPart: async (partNumber: number) => {
          storageAttempt += 1;
          if (storageAttempt === 1) throw new Error('temporary R2 failure');
          return { partNumber, etag: `part-${partNumber}` };
        },
        complete: async () => undefined,
        abort: async () => undefined
      }),
      get: async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer })
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'file' } }), { status: 200 });
      }
      if (String(url).includes('/file/bot')) {
        return new Response(new Blob([bytes]).stream(), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    });

    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    expect(fixture.db.attachments[0].status).toBe('FAILED_RETRYABLE');
    await processAttachmentTransfer(fixture.event, fixture.env);

    expect(fixture.db.attachments[0].attempt_count).toBe(2);
    expect(fixture.db.attachments[0].status).toBe('DELIVERED');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('stops retrying after the third source/storage attempt', async () => {
    const fixture = await setup('telegram', 'PENDING');
    fixture.env.ATTACHMENTS_BUCKET = {
      createMultipartUpload: async () => ({
        uploadPart: async () => { throw new Error('R2 unavailable'); },
        complete: async () => undefined,
        abort: async () => undefined
      })
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) =>
      String(url).includes('/getFile')
        ? new Response(JSON.stringify({ ok: true, result: { file_path: 'file' } }), { status: 200 })
        : new Response(new Blob([new Uint8Array([1])]).stream(), { status: 200 })
    );

    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    await expect(processAttachmentTransfer(fixture.event, fixture.env)).rejects.toBeInstanceOf(RetryableProcessingError);
    await expect(processAttachmentTransfer(fixture.event, fixture.env)).resolves.toBeUndefined();
    await expect(processAttachmentTransfer(fixture.event, fixture.env)).resolves.toBeUndefined();

    expect(fixture.db.attachments[0].attempt_count).toBe(3);
    expect(fixture.db.attachments[0].status).toBe('FAILED_FINAL');
    expect(fixture.db.attachments[0].expires_at).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
