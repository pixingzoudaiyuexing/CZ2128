import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Real 0009 knowledge FTS migration', () => {
  const tmpDir = join(tmpdir(), `d1-knowledge-migration-${Date.now()}`);
  let queryId = 0;

  const runSql = (sql: string) => {
    queryId += 1;
    const file = join(tmpDir, `query-${queryId}.sql`);
    writeFileSync(file, sql);
    const result = execSync(
      `npx wrangler d1 execute cz2128-db --local --persist-to ${tmpDir} --file ${file} --json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result.trim().replace(/^[\s\S]*?(?=\[)/, ''));
  };

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    for (const migration of [
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql',
      '0006_crisp_attachment_provider.sql',
      '0007_crisp_upload_invites.sql',
      '0008_crisp_legacy_ux.sql',
      '0009_knowledge_base.sql'
    ]) {
      execSync(
        `npx wrangler d1 execute cz2128-db --local --persist-to ${tmpDir} --file migrations/${migration}`,
        { stdio: 'pipe' }
      );
    }
  }, 120_000);

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('indexes insert, update and delete through FTS triggers', () => {
    runSql(`
      INSERT INTO knowledge_entries
        (id, title, body, search_terms, enabled, version, created_by, updated_by, created_at, updated_at)
      VALUES ('kb_test', '退款规则', '退款会在三个工作日处理', '退款 处理', 1, 1, '1', '1', 1, 1);
    `);
    let rows = runSql(`
      SELECT k.id FROM knowledge_entries_fts
      JOIN knowledge_entries k ON k.rowid = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH '退款'
    `)[0].results;
    expect(rows).toEqual([{ id: 'kb_test' }]);

    runSql(`
      UPDATE knowledge_entries
      SET title='发票规则', body='发票会发送到邮箱', search_terms='发票 邮箱', version=2
      WHERE id='kb_test';
    `);
    rows = runSql(`
      SELECT k.id FROM knowledge_entries_fts
      JOIN knowledge_entries k ON k.rowid = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH '发票'
    `)[0].results;
    expect(rows).toEqual([{ id: 'kb_test' }]);

    runSql("DELETE FROM knowledge_entries WHERE id='kb_test';");
    rows = runSql("SELECT rowid FROM knowledge_entries_fts WHERE knowledge_entries_fts MATCH '发票'")[0].results;
    expect(rows).toEqual([]);
  }, 30_000);
});
