import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Real 0007 Crisp upload invite migration', () => {
  const tmpDir = join(tmpdir(), `d1-crisp-upload-migration-${Date.now()}`);
  let queryId = 0;
  let beforeRows: any[] = [];

  const migrationText = readFileSync(new URL('../migrations/0007_crisp_upload_invites.sql', import.meta.url), 'utf8');

  const runSql = (sql: string) => {
    queryId += 1;
    const file = join(tmpDir, `query-${queryId}.sql`);
    writeFileSync(file, sql);
    const result = execSync(
      `npx wrangler d1 execute cz2128-db --local --persist-to ${tmpDir} --file ${file} --json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const clean = result.trim().replace(/^[\s\S]*?(?=\[)/, '');
    return JSON.parse(clean);
  };

  const runMigration = (name: string) => {
    execSync(
      `npx wrangler d1 execute cz2128-db --local --persist-to ${tmpDir} --file migrations/${name}`,
      { stdio: 'pipe' }
    );
  };

  const attachmentRows = () => runSql(
    `SELECT id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
            attachment_type, original_filename, safe_filename, mime_type, size_bytes,
            storage_key, access_token_hash, status, destination_provider, destination_message_ref,
            attempt_count, expires_at, last_error, created_at, updated_at
       FROM attachments ORDER BY id`
  )[0].results;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    for (const migration of [
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql',
      '0006_crisp_attachment_provider.sql'
    ]) runMigration(migration);

    runSql(`
      INSERT INTO conversations
        (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
         operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
      VALUES
        ('conv', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 2, 3);

      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, size_bytes,
         storage_key, access_token_hash, status, destination_provider, destination_message_ref,
         attempt_count, expires_at, last_error, created_at, updated_at)
      VALUES
        ('att-tg', 'conv', 'telegram', 'm1', 'a1', 'document', 'old.pdf', 'old.pdf',
         'application/pdf', 10, 'attachments/att-tg', 'hash-tg', 'DELIVERED', 'crisp',
         '99', 1, 9999999999, NULL, 10, 11),
        ('att-crisp', 'conv', 'crisp', 'm2', 'a2', 'photo', 'old.png', 'old.png',
         'image/png', 20, 'attachments/att-crisp', 'hash-crisp', 'STORED', 'telegram',
         NULL, 2, 9999999999, NULL, 12, 13);
    `);
    beforeRows = attachmentRows();
    runMigration('0007_crisp_upload_invites.sql');
  }, 90_000);

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('uses the D1 remote-safe parenthesized CASE form inside the trigger', () => {
    expect(migrationText).toContain('SELECT (CASE');
    expect(migrationText).not.toContain('SELECT CASE');
  });

  it('preserves every pre-0007 attachment field exactly', () => {
    expect(attachmentRows()).toEqual(beforeRows);
  }, 15_000);

  it('accepts upload as a source only and keeps destination providers bounded', () => {
    runSql(`
      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, size_bytes,
         storage_key, access_token_hash, status, destination_provider, attempt_count,
         expires_at, created_at, updated_at)
      VALUES ('att-upload', 'conv', 'upload', 'invite-1', 'upload-1', 'document',
              'file.txt', 'file.txt', 'text/plain', 3, 'attachments/att-upload',
              'hash-upload', 'STORED', 'telegram', 1, 9999999999, 20, 20);
    `);
    expect(attachmentRows().find((row: any) => row.id === 'att-upload')).toMatchObject({
      source_provider: 'upload',
      destination_provider: 'telegram'
    });
    expect(() => runSql(`
      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, storage_key,
         access_token_hash, status, destination_provider, created_at, updated_at)
      VALUES ('bad-dst', 'conv', 'telegram', 'm3', 'a3', 'document', 'x', 'x',
              'application/octet-stream', 'attachments/bad-dst', 'hash-bad-dst',
              'PENDING', 'upload', 1, 1);
    `)).toThrow();
  }, 20_000);

  it('atomically counts an accepted item and refuses a file beyond invite limits', () => {
    const now = Math.floor(Date.now() / 1000);
    runSql(`
      INSERT INTO upload_invites
        (id, token_hash, conversation_id, crisp_website_ref, crisp_session_ref,
         telegram_group_ref, telegram_thread_ref, support_profile_version,
         created_by_operator_ref, created_from_update_ref, status, expires_at,
         max_files, max_total_bytes, consumed_files, consumed_bytes, version,
         created_at, updated_at)
      VALUES ('inv', 'token-hash', 'conv', 'site', 'session', '-100', '77', 1,
              '42', '100', 'ACTIVE', ${now + 3600}, 3, 5, 0, 0, 1, ${now}, ${now});

      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, storage_key,
         access_token_hash, status, destination_provider, created_at, updated_at)
      VALUES
        ('u1', 'conv', 'upload', 'inv', 'one', 'document', 'one.txt', 'one.txt',
         'text/plain', 'attachments/u1', 'h1', 'FETCHING', 'telegram', ${now}, ${now}),
        ('u2', 'conv', 'upload', 'inv', 'two', 'document', 'two.txt', 'two.txt',
         'text/plain', 'attachments/u2', 'h2', 'FETCHING', 'telegram', ${now}, ${now});

      INSERT INTO upload_invite_items
        (invite_id, upload_id, attachment_id, status, lease_token, lease_until, created_at, updated_at)
      VALUES
        ('inv', 'one', 'u1', 'UPLOADING', 'lease-1', ${now + 120}, ${now}, ${now}),
        ('inv', 'two', 'u2', 'UPLOADING', 'lease-2', ${now + 120}, ${now}, ${now});

      UPDATE upload_invite_items
      SET status = 'ACCEPTED', size_bytes = 4, updated_at = ${now + 1}
      WHERE invite_id = 'inv' AND upload_id = 'one';
    `);

    const invite = runSql(
      "SELECT consumed_files, consumed_bytes, status, version FROM upload_invites WHERE id='inv'"
    )[0].results[0];
    expect(invite).toMatchObject({ consumed_files: 1, consumed_bytes: 4, status: 'ACTIVE', version: 2 });

    expect(() => runSql(`
      UPDATE upload_invite_items
      SET status = 'ACCEPTED', size_bytes = 2, updated_at = ${now + 2}
      WHERE invite_id = 'inv' AND upload_id = 'two';
    `)).toThrow();

    const unchanged = runSql(
      "SELECT consumed_files, consumed_bytes, status, version FROM upload_invites WHERE id='inv'"
    )[0].results[0];
    expect(unchanged).toEqual(invite);
  }, 30_000);
});
