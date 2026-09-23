import { describe, expect, it } from 'vitest';
import {
  deriveUploadDownloadToken,
  deriveUploadInviteToken,
  hashUploadCapability,
  stableUploadInviteId
} from '../src/uploads/capability';

const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('upload capability derivation', () => {
  it('derives stable opaque invite identity and token for the same Telegram command', async () => {
    const id1 = await stableUploadInviteId('conv-1', 4, '12345');
    const id2 = await stableUploadInviteId('conv-1', 4, '12345');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^uplinv_[a-f0-9]{64}$/);

    const token1 = await deriveUploadInviteToken(SECRET, id1);
    const token2 = await deriveUploadInviteToken(SECRET, id2);
    expect(token1).toBe(token2);
    expect(token1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hashUploadCapability(token1)).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashUploadCapability(token1)).not.toBe(token1);
  });

  it('domain-separates invite and download capabilities and upload ids', async () => {
    const inviteId = await stableUploadInviteId('conv-1', 4, '12345');
    const invite = await deriveUploadInviteToken(SECRET, inviteId);
    const downloadA = await deriveUploadDownloadToken(
      SECRET, inviteId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    const downloadB = await deriveUploadDownloadToken(
      SECRET, inviteId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    );
    expect(new Set([invite, downloadA, downloadB]).size).toBe(3);
  });

  it('rejects malformed secrets and malformed capability tokens', async () => {
    const inviteId = await stableUploadInviteId('conv-1', 1, '1');
    await expect(deriveUploadInviteToken('short', inviteId)).rejects.toThrow('UPLOAD_CAPABILITY_SECRET_INVALID');
    await expect(hashUploadCapability('not-a-capability')).rejects.toThrow('UPLOAD_CAPABILITY_TOKEN_INVALID');
  });
});
