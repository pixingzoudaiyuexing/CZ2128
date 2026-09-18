import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDlqQuarantine, persistDlqQuarantine } from '../src/queue/dlq-quarantine';

const sentinels = [
  'PRIVATE_DLQ_MESSAGE_BODY_123',
  'SUPER_SECRET_DLQ_TOKEN_456',
  'PRIVATE_CHATWOOT_URL_789',
  'PRIVATE_ATTACHMENT_ACCESS_TOKEN_ABC',
  'PRIVATE_AI_TEXT_DEF'
];

function validEvent() {
  return {
    version: 1,
    source: 'chatwoot',
    type: 'message_created',
    eventId: 'event-1',
    payload: {
      accountRef: 'account-1',
      conversationRef: 'conversation-1',
      content: sentinels[0],
      token: sentinels[1],
      privateUrl: sentinels[2],
      accessToken: sentinels[3],
      aiText: sentinels[4]
    }
  };
}

class MemoryBucket {
  objects = new Map<string, { body: string; customMetadata?: Record<string, string>; uploaded: Date }>();

  async put(key: string, value: string, options?: R2PutOptions) {
    this.objects.set(key, {
      body: value,
      customMetadata: options?.customMetadata,
      uploaded: new Date('2026-09-19T00:00:00Z')
    });
    return { key };
  }

  async list(options?: R2ListOptions) {
    const objects = Array.from(this.objects.entries())
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => ({
        key,
        uploaded: value.uploaded,
        customMetadata: value.customMetadata
      }));
    return { objects, truncated: false };
  }
}

describe('DLQ terminal quarantine', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes an allowlisted deterministic receipt and excludes raw content', async () => {
    const bucket = new MemoryBucket();
    const input = {
      id: 'cloudflare-message-1',
      body: validEvent(),
      attempts: 4,
      timestamp: new Date('2026-09-18T23:59:00Z')
    };
    const first = await persistDlqQuarantine(bucket as any, input);
    const second = await persistDlqQuarantine(bucket as any, input);

    expect(second).toEqual(first);
    expect(bucket.objects).toHaveLength(1);
    const [[key, stored]] = Array.from(bucket.objects.entries());
    expect(key).toMatch(/^terminal-dlq\/v1\/[0-9a-f]{64}\.json$/);
    const parsed = JSON.parse(stored.body);
    expect(parsed).toEqual({
      schemaVersion: 1,
      quarantineId: expect.stringMatching(/^dlq-quarantine:v1:[0-9a-f]{64}$/),
      canonicalReceiptId: expect.stringMatching(/^dlq:v1:[0-9a-f]{64}$/),
      queueName: 'cz2128-dlq',
      eventSource: 'chatwoot',
      eventType: 'message_created',
      queueAttempts: 4,
      messageTimestamp: 1789775940,
      reason: 'D1_DLQ_RECEIPT_PERSIST_FAILED',
      state: 'QUARANTINED'
    });
    const durable = JSON.stringify({ stored, parsed });
    for (const sentinel of sentinels) expect(durable).not.toContain(sentinel);
  });

  it('uses a minimal safe schema for a malformed body', async () => {
    const bucket = new MemoryBucket();
    await persistDlqQuarantine(bucket as any, {
      id: 'cloudflare-message-malformed',
      body: { arbitrary: sentinels.join('|') },
      attempts: 3,
      timestamp: new Date('2026-09-19T00:00:00Z')
    });
    const stored = Array.from(bucket.objects.values())[0];
    expect(JSON.parse(stored.body)).toMatchObject({
      eventSource: null,
      eventType: null,
      queueAttempts: 3,
      messageTimestamp: 1789776000
    });
    for (const sentinel of sentinels) expect(stored.body).not.toContain(sentinel);
  });

  it('lists only valid allowlisted metadata without reading object bodies', async () => {
    const bucket = new MemoryBucket();
    await persistDlqQuarantine(bucket as any, {
      id: 'cloudflare-message-list', body: validEvent(), attempts: 2
    });
    bucket.objects.set('terminal-dlq/v1/invalid.json', {
      body: sentinels[0],
      uploaded: new Date('2026-09-19T00:01:00Z'),
      customMetadata: { schemaVersion: '1', raw: sentinels[1] }
    });
    const get = vi.fn(() => { throw new Error('body read forbidden'); });
    const result = await listDlqQuarantine({ list: bucket.list.bind(bucket), get } as any, 10);
    expect(get).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(1);
    expect(result.invalidMetadataCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(sentinels[0]);
    expect(JSON.stringify(result)).not.toContain(sentinels[1]);
  });
});
