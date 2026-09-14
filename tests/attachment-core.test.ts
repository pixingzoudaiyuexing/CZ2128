import { describe, expect, it } from 'vitest';
import { ATTACHMENT_HARD_MAX_BYTES, getAttachmentConfig } from '../src/config/attachments';
import {
  contentDisposition,
  generateAttachmentToken,
  hashAttachmentToken,
  isValidAttachmentToken,
  normalizeMime,
  parseSingleRange,
  sanitizeFilename,
  stableAttachmentId
} from '../src/core/attachments';
import { eventLeaseSeconds } from '../src/queue/consumer';

describe('attachment core security primitives', () => {
  it('creates stable anonymous attachment identities', async () => {
    const first = await stableAttachmentId('telegram', '10', 'unique-20');
    const second = await stableAttachmentId('telegram', '10', 'unique-20');
    expect(first).toBe(second);
    expect(first).toMatch(/^att_[0-9a-f]{64}$/);
    expect(first).not.toContain('unique-20');
  });

  it('generates 256-bit base64url tokens and stores a SHA-256 representation', async () => {
    const token = generateAttachmentToken();
    expect(isValidAttachmentToken(token)).toBe(true);
    expect(token).toHaveLength(43);
    expect(await hashAttachmentToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashAttachmentToken(token)).not.toBe(token);
  });

  it.each([
    '../../etc/passwd',
    '../',
    '..\\..\\secret.txt',
    'file\r\nX-Evil: yes.txt',
    'file\u0000\u0007.txt',
    `${'文件'.repeat(200)}.txt`
  ])('sanitizes hostile filename %j for metadata and headers', value => {
    const filename = sanitizeFilename(value, 'document');
    const header = contentDisposition(filename.safe);
    expect(filename.safe).not.toMatch(/[\\/\r\n\u0000-\u001f\u007f]/);
    expect(Array.from(filename.safe).length).toBeLessThanOrEqual(180);
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
  });

  it('provides safe filename and MIME defaults', () => {
    expect(sanitizeFilename(undefined, 'voice').safe).toBe('voice.bin');
    expect(normalizeMime(undefined)).toBe('application/octet-stream');
    expect(normalizeMime('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(normalizeMime('IMAGE/JPEG')).toBe('image/jpeg');
  });

  it('strictly bounds attachment configuration', () => {
    const config = getAttachmentConfig({
      CHATWOOT_API_URL: 'https://chatwoot.example/api',
      CHATWOOT_ATTACHMENT_ALLOWED_HOSTS: 'cdn.example, *.invalid.example, 127.0.0.1',
      ATTACHMENT_MAX_BYTES: String(ATTACHMENT_HARD_MAX_BYTES + 1),
      ATTACHMENT_MAX_COUNT_PER_MESSAGE: '100junk',
      ATTACHMENT_TTL_SECONDS: '999999'
    } as any);
    expect(config.maxBytes).toBe(ATTACHMENT_HARD_MAX_BYTES);
    expect(config.maxCountPerMessage).toBe(10);
    expect(config.ttlSeconds).toBe(86400);
    expect(config.eventLeaseSeconds).toBe(90);
    expect(config.allowedChatwootAttachmentHosts.has('cdn.example')).toBe(true);
    expect(config.allowedChatwootAttachmentHosts.has('*.invalid.example')).toBe(false);
  });

  it('extends only attachment event receipts to source plus destination plus safety', () => {
    const env = { CHATWOOT_API_URL: 'https://chatwoot.example' } as any;
    expect(eventLeaseSeconds({
      version: 1, source: 'internal', type: 'attachment_transfer', eventId: 'attachment:1',
      payload: { attachmentId: '1', accessToken: 'x'.repeat(43), locator: { provider: 'telegram', fileId: '1' } }
    }, env)).toBe(90);
    expect(eventLeaseSeconds({
      version: 1, source: 'telegram', type: 'message_created', eventId: 'tg',
      payload: { supportProfileVersion: 0, updateRef: '1', messageRef: '1', threadRef: '1', content: 'text' }
    }, env)).toBe(30);
  });

  it.each([
    ['bytes=0-99', 1000, { offset: 0, length: 100, contentRange: 'bytes 0-99/1000' }],
    ['bytes=100-', 1000, { offset: 100, length: 900, contentRange: 'bytes 100-999/1000' }],
    ['bytes=-100', 1000, { offset: 900, length: 100, contentRange: 'bytes 900-999/1000' }]
  ])('parses single range %s', (header, size, expected) => {
    expect(parseSingleRange(header, size)).toEqual(expected);
  });

  it.each(['bytes=1000-', 'bytes=100-1', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-0'])('rejects range %s', header => {
    expect(parseSingleRange(header, 1000)).toBeNull();
  });
});
