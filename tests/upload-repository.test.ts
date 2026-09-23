import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import {
  acceptUploadItem,
  claimUploadItem,
  createOrGetUploadInvite,
  getUploadInviteById
} from '../src/uploads/repository';

describe('upload invite repository ordering and leases', () => {
  let db: SqliteD1;
  let env: any;

  beforeEach(async () => {
    db = new SqliteD1();
    db.migrate();
    env = { DB: db };
    await db.prepare(
      `INSERT INTO conversations
       (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
        operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
       VALUES ('conv', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1)`
    ).run();
  });

  afterEach(() => db.close());

  function input(updateRef: string) {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: 'inv-' + updateRef,
      tokenHash: 'hash-' + updateRef,
      conversationId: 'conv',
      crispWebsiteRef: 'site',
      crispSessionRef: 'session',
      telegramGroupRef: '-100',
      telegramThreadRef: '77',
      supportProfileVersion: 3,
      operatorRef: '42',
      updateRef,
      expiresAt: now + 900,
      maxFiles: 3,
      maxTotalBytes: 10
    };
  }

  it('keeps the newest Telegram update active and fences an older late event', async () => {
    const newer = await createOrGetUploadInvite(env, input('101'));
    expect(newer.outcome).toBe('CURRENT');

    const older = await createOrGetUploadInvite(env, input('100'));
    expect(older.outcome).toBe('STALE');
    expect(older.row.id).toBe('inv-101');

    expect(await getUploadInviteById(env, 'inv-101')).toMatchObject({ status: 'ACTIVE' });
    expect(await getUploadInviteById(env, 'inv-100')).toBeNull();
  });

  it('revokes only an older active invite when a newer command wins', async () => {
    await createOrGetUploadInvite(env, input('100'));
    const newer = await createOrGetUploadInvite(env, input('101'));
    expect(newer).toMatchObject({ outcome: 'CURRENT', row: { id: 'inv-101', status: 'ACTIVE' } });
    expect(await getUploadInviteById(env, 'inv-100')).toMatchObject({ status: 'REVOKED' });
    expect(await getUploadInviteById(env, 'inv-101')).toMatchObject({ status: 'ACTIVE' });
  });

  it('reuses the exact same invite for a duplicate queue event', async () => {
    const first = await createOrGetUploadInvite(env, input('100'));
    const duplicate = await createOrGetUploadInvite(env, input('100'));
    expect(first).toEqual(duplicate);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM upload_invites')
      .first<{ count: number }>()).toEqual({ count: 1 });
  });

  it('gives one upload-id one lease owner and never double-counts an accepted retry', async () => {
    await createOrGetUploadInvite(env, input('200'));
    await db.prepare(
      `INSERT INTO attachments
       (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
        attachment_type, original_filename, safe_filename, mime_type, storage_key,
        access_token_hash, status, destination_provider, created_at, updated_at)
       VALUES ('att-a', 'conv', 'upload', 'inv-200', 'upload-a', 'document',
               'a.txt', 'a.txt', 'text/plain', 'attachments/att-a', 'ha',
               'FETCHING', 'telegram', 1, 1)`
    ).run();

    const first = await claimUploadItem(env, 'inv-200', 'upload-a', 'att-a', 120);
    expect(first.outcome).toBe('CLAIMED');
    const second = await claimUploadItem(env, 'inv-200', 'upload-a', 'att-a', 120);
    expect(second.outcome).toBe('BUSY');

    if (first.outcome !== 'CLAIMED') throw new Error('expected claim');
    expect(await acceptUploadItem(env, 'inv-200', 'upload-a', first.leaseToken, 4)).toBe('ACCEPTED');

    const replay = await claimUploadItem(env, 'inv-200', 'upload-a', 'att-a', 120);
    expect(replay.outcome).toBe('ACCEPTED');
    expect(await getUploadInviteById(env, 'inv-200')).toMatchObject({
      consumed_files: 1,
      consumed_bytes: 4
    });
  });

  it('accepts trigger-inclusive D1 change counts after the item transition commits', async () => {
    await createOrGetUploadInvite(env, input('250'));
    await db.prepare(
      `INSERT INTO attachments
       (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
        attachment_type, original_filename, safe_filename, mime_type, storage_key,
        access_token_hash, status, destination_provider, created_at, updated_at)
       VALUES ('att-trigger-count', 'conv', 'upload', 'inv-250', 'upload-trigger-count', 'document',
               'trigger.txt', 'trigger.txt', 'text/plain', 'attachments/att-trigger-count', 'h-trigger-count',
               'FETCHING', 'telegram', 1, 1)`
    ).run();

    const claim = await claimUploadItem(
      env, 'inv-250', 'upload-trigger-count', 'att-trigger-count', 120
    );
    if (claim.outcome !== 'CLAIMED') throw new Error('expected claim');

    const baseDb = env.DB;
    env.DB = {
      prepare(query: string) {
        const statement = baseDb.prepare(query);
        if (!query.startsWith("UPDATE upload_invite_items SET status = 'ACCEPTED'")) return statement;
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async run() {
                const result = await bound.run();
                return {
                  ...result,
                  meta: { ...result.meta, changes: result.meta.changes + 1 }
                };
              }
            };
          }
        };
      }
    };

    expect(
      await acceptUploadItem(env, 'inv-250', 'upload-trigger-count', claim.leaseToken, 4)
    ).toBe('ACCEPTED');
    expect(await getUploadInviteById(env, 'inv-250')).toMatchObject({
      consumed_files: 1,
      consumed_bytes: 4,
      status: 'ACTIVE'
    });
  });

  it('uses the trigger as the final atomic byte-limit fence', async () => {
    await createOrGetUploadInvite(env, input('300'));
    for (const [id, suffix] of [['att-a', 'a'], ['att-b', 'b']] as const) {
      await db.prepare(
        `INSERT INTO attachments
         (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
          attachment_type, original_filename, safe_filename, mime_type, storage_key,
          access_token_hash, status, destination_provider, created_at, updated_at)
         VALUES (?, 'conv', 'upload', 'inv-300', ?, 'document', ?, ?, 'text/plain', ?,
                 ?, 'FETCHING', 'telegram', 1, 1)`
      ).bind(
        id, 'upload-' + suffix, suffix + '.txt', suffix + '.txt',
        'attachments/' + id, 'hash-' + id
      ).run();
    }

    const first = await claimUploadItem(env, 'inv-300', 'upload-a', 'att-a', 120);
    if (first.outcome !== 'CLAIMED') throw new Error('expected first claim');
    expect(await acceptUploadItem(env, 'inv-300', 'upload-a', first.leaseToken, 8)).toBe('ACCEPTED');

    const second = await claimUploadItem(env, 'inv-300', 'upload-b', 'att-b', 120);
    if (second.outcome !== 'CLAIMED') throw new Error('expected second claim');
    expect(await acceptUploadItem(env, 'inv-300', 'upload-b', second.leaseToken, 3)).toBe('LIMIT');
    expect(await getUploadInviteById(env, 'inv-300')).toMatchObject({
      consumed_files: 1,
      consumed_bytes: 8,
      status: 'ACTIVE'
    });
  });
});