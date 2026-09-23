import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Real 0006 Crisp attachment provider migration', () => {
  const tmpDir = join(tmpdir(), `d1-crisp-attachment-migration-${Date.now()}`);
  let queryId = 0;
  let beforeRows: any[] = [];

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
      '0005_reliability.sql'
    ]) runMigration(migration);

    runSql(`
      INSERT INTO conversations
        (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
         operator_channel, created_at, updated_at, version)
      VALUES
        ('conv-cw', 'chatwoot', '1', '11', 'c1', 'telegram', 1, 2, 3),
        ('conv-tg', 'chatwoot', '2', '22', 'c2', 'telegram', 4, 5, 6);

      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, size_bytes,
         storage_key, access_token_hash, status, destination_provider, destination_message_ref,
         attempt_count, expires_at, last_error, created_at, updated_at)
      VALUES
        ('att-cw', 'conv-cw', 'chatwoot', 'cw-msg', 'cw-att',
         'photo', 'old.jpg', 'old.jpg', 'image/jpeg', 123,
         'attachments/att-cw', 'hash-cw', 'DELIVERED', 'telegram', '77',
         2, 9999999999, NULL, 10, 11),
        ('att-tg', 'conv-tg', 'telegram', 'tg-msg', 'tg-att',
         'document', 'old.pdf', 'old.pdf', 'application/pdf', 456,
         'attachments/att-tg', 'hash-tg', 'FAILED_FINAL', 'chatwoot', NULL,
         3, 8888888888, 'ATTACHMENT_DELIVERY_AMBIGUOUS', 12, 13);
    `);
    beforeRows = attachmentRows();
    runMigration('0006_crisp_attachment_provider.sql');
  }, 60000);

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('preserves every legacy attachment field exactly', () => {
    expect(attachmentRows()).toEqual(beforeRows);
  }, 15_000);

  it('accepts Crisp as a qualified source and destination provider', () => {
    runSql(`
      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, size_bytes,
         storage_key, access_token_hash, status, destination_provider, attempt_count,
         expires_at, created_at, updated_at)
      VALUES
        ('att-crisp-in', 'conv-cw', 'crisp', 'crisp-msg', 'file', 'photo',
         'image.png', 'image.png', 'image/png', 1, 'attachments/att-crisp-in', 'hash-ci',
         'STORED', 'telegram', 1, 9999999999, 20, 20),
        ('att-crisp-out', 'conv-tg', 'telegram', 'tg-msg-2', 'tg-att-2', 'document',
         'file.pdf', 'file.pdf', 'application/pdf', 2, 'attachments/att-crisp-out', 'hash-co',
         'STORED', 'crisp', 1, 9999999999, 21, 21);
    `);
    const rows = attachmentRows();
    expect(rows.find((row: any) => row.id === 'att-crisp-in')).toMatchObject({
      source_provider: 'crisp', destination_provider: 'telegram'
    });
    expect(rows.find((row: any) => row.id === 'att-crisp-out')).toMatchObject({
      source_provider: 'telegram', destination_provider: 'crisp'
    });
  }, 15_000);

  it('continues rejecting unknown providers after the rebuild', () => {
    expect(() => runSql(`
      INSERT INTO attachments
        (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
         attachment_type, original_filename, safe_filename, mime_type, storage_key,
         access_token_hash, status, destination_provider, created_at, updated_at)
      VALUES ('bad', 'conv-cw', 'unknown', 'm', 'a', 'document', 'x', 'x',
              'application/octet-stream', 'attachments/bad', 'hash-bad', 'PENDING',
              'telegram', 1, 1);
    `)).toThrow();
  }, 15_000);
});
