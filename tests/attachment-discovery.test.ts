import { describe, expect, it, vi } from 'vitest';
import { discoverChatwootAttachments, discoverTelegramAttachments } from '../src/attachments/discovery';
import { getAttachmentConfig } from '../src/config/attachments';
import { discoverAttachment, enqueueAttachmentJobs } from '../src/core/attachment-repository';

const config = getAttachmentConfig({ CHATWOOT_API_URL: 'https://chatwoot.example' } as any);

class DiscoveryDb {
  attachments: any[] = [];

  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      first: async () => {
        const row = this.attachments.find(item => item.id === params[0]);
        return row ? { ...row } : null;
      },
      run: async () => {
        if (query.includes('INSERT INTO attachments')) {
          const [
            id, conversationId, sourceProvider, sourceMessageRef, sourceAttachmentRef,
            attachmentType, originalFilename, safeFilename, mimeType, sizeBytes,
            storageKey, tokenHash, status, destinationProvider, expiresAt, lastError, createdAt, updatedAt
          ] = params;
          const existing = this.attachments.find(item =>
            item.source_provider === sourceProvider && item.source_message_ref === sourceMessageRef &&
            item.source_attachment_ref === sourceAttachmentRef);
          if (!existing) {
            this.attachments.push({
              id, conversation_id: conversationId, source_provider: sourceProvider,
              source_message_ref: sourceMessageRef, source_attachment_ref: sourceAttachmentRef,
              attachment_type: attachmentType, original_filename: originalFilename,
              safe_filename: safeFilename, mime_type: mimeType, size_bytes: sizeBytes,
              storage_key: storageKey, access_token_hash: tokenHash, status,
              destination_provider: destinationProvider, attempt_count: 0,
              expires_at: expiresAt, last_error: lastError, created_at: createdAt, updated_at: updatedAt
            });
            return { meta: { changes: 1 } };
          }
        }
        if (query.includes('SET access_token_hash = ?')) {
          const row = this.attachments.find(item => item.id === params[2] && item.status === 'PENDING');
          if (row) {
            row.access_token_hash = params[0];
            row.updated_at = params[1];
            return { meta: { changes: 1 } };
          }
        }
        return { meta: { changes: 0 } };
      }
    };
    return statement;
  }
}

describe('attachment discovery', () => {
  it('selects only the largest Telegram photo variant within the limit', () => {
    const descriptors = discoverTelegramAttachments({ photo: [
      { file_id: 'small', file_unique_id: 'small-u', file_size: 10, width: 10, height: 10 },
      { file_id: 'fit', file_unique_id: 'fit-u', file_size: config.maxBytes, width: 20, height: 20 },
      { file_id: 'large', file_unique_id: 'large-u', file_size: config.maxBytes + 1, width: 30, height: 30 }
    ] }, config);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].sourceAttachmentRef).toBe('fit-u');
    expect(descriptors[0].locator).toEqual({ provider: 'telegram', fileId: 'fit' });
  });

  it('marks a Telegram photo final when no variant is within the limit', () => {
    const descriptors = discoverTelegramAttachments({ photo: [
      { file_id: 'large', file_unique_id: 'large-u', file_size: config.maxBytes + 1 }
    ] }, config);
    expect(descriptors[0].rejectionCode).toBe('SOURCE_TOO_LARGE');
  });

  it.each(['document', 'video', 'audio', 'voice'] as const)('discovers Telegram %s metadata', type => {
    const descriptors = discoverTelegramAttachments({
      [type]: {
        file_id: `${type}-id`, file_unique_id: `${type}-unique`, file_size: 100,
        file_name: `${type}.bin`, mime_type: 'application/octet-stream'
      }
    }, config);
    expect(descriptors).toEqual([expect.objectContaining({
      sourceAttachmentRef: `${type}-unique`, attachmentType: type,
      locator: { provider: 'telegram', fileId: `${type}-id` }
    })]);
  });

  it('discovers one and multiple Chatwoot attachments with stable attachment IDs', async () => {
    const descriptors = discoverChatwootAttachments({ attachments: [
      { id: 1, file_type: 'image', data_url: 'https://chatwoot.example/a', file_name: 'a.jpg', content_type: 'image/jpeg' },
      { id: 2, file_type: 'file', data_url: 'https://chatwoot.example/b', file_name: 'b.pdf', content_type: 'application/pdf' }
    ] }, config);
    expect(descriptors).toHaveLength(2);
    expect(descriptors.map(item => item.attachmentType)).toEqual(['photo', 'document']);

    const db = new DiscoveryDb();
    const env = { DB: db } as any;
    const first = await discoverAttachment(env, config, 'conv', 'chatwoot', 'message', descriptors[0]);
    const second = await discoverAttachment(env, config, 'conv', 'chatwoot', 'message', descriptors[0]);
    expect((await first).row.id).toBe(second.row.id);
    expect((await first).row.storage_key).toBe(second.row.storage_key);
    expect(db.attachments).toHaveLength(1);
    expect(second.job?.eventId).toBe(`attachment:${second.row.id}`);
  });

  it('processes only ten attachments and logs a redacted count warning', async () => {
    const db = new DiscoveryDb();
    const sent: any[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const descriptors = Array.from({ length: 12 }, (_, index) => ({
      sourceAttachmentRef: `unique-${index}`,
      attachmentType: 'document' as const,
      originalFilename: `private-${index}.txt`,
      locator: { provider: 'telegram' as const, fileId: `file-${index}` }
    }));

    await enqueueAttachmentJobs(
      { DB: db, QUEUE: { send: async (event: any) => { sent.push(event); } } } as any,
      config,
      'conv',
      'telegram',
      'message',
      descriptors
    );
    expect(db.attachments).toHaveLength(10);
    expect(sent).toHaveLength(10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('private-');
  });

  it('persists oversized metadata as FAILED_FINAL without a Queue job', async () => {
    const db = new DiscoveryDb();
    const discovered = await discoverAttachment(
      { DB: db } as any,
      config,
      'conv',
      'telegram',
      'message',
      {
        sourceAttachmentRef: 'too-large', attachmentType: 'document', sizeBytes: config.maxBytes + 1,
        locator: { provider: 'telegram', fileId: 'file-id' }, rejectionCode: 'SOURCE_TOO_LARGE'
      }
    );
    expect(discovered.row.status).toBe('FAILED_FINAL');
    expect(discovered.row.last_error).toBe('SOURCE_TOO_LARGE');
    expect(discovered.job).toBeUndefined();
  });
});
