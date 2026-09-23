import { execFile, execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('real D1 outbound reconciliation persistence', () => {
  const persistDir = join(tmpdir(), `cz2128-reconciliation-d1-${Date.now()}`);
  let queryId = 0;

  function wranglerArgs(file: string, json = false): string[] {
    return [
      'wrangler', 'd1', 'execute', 'cz2128-db', '--local', '--persist-to', persistDir,
      '--file', file, ...(json ? ['--json'] : [])
    ];
  }

  function runFile(file: string, json = false): string {
    return execFileSync('npx', wranglerArgs(file, json), {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  function runSql(sql: string): any[] {
    const file = join(persistDir, `query-${++queryId}.sql`);
    writeFileSync(file, sql);
    const output = runFile(file, true);
    return JSON.parse(output.trim().replace(/^[\s\S]*?(?=\[)/, ''));
  }

  beforeAll(() => {
    mkdirSync(persistDir, { recursive: true });
    for (const migration of [
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql'
    ]) {
      runFile(join('migrations', migration));
    }
    runSql(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, created_at, updated_at, version)
      VALUES ('conv', 'chatwoot', '1', '2', 'customer', 'telegram', 1, 1, 1);

      INSERT INTO outbound_operations
      (id, conversation_id, destination_provider, operation_type, status, attempt_count,
       request_started_at, reconciliation_status, subject_type, subject_ref, target_evidence_json,
       created_at, updated_at)
      VALUES
      ('op-confirm', 'conv', 'chatwoot', 'SEND_MESSAGE', 'AMBIGUOUS', 1, 1, 'PENDING',
       'MESSAGE', 'message:1', '{"version":1,"provider":"chatwoot"}', 1, 1),
      ('op-race', 'conv', 'chatwoot', 'SEND_MESSAGE', 'AMBIGUOUS', 1, 1, 'PENDING',
       'MESSAGE', 'message:2', '{"version":1,"provider":"chatwoot"}', 1, 1);
    `);
  }, 60_000);

  afterAll(() => rmSync(persistDir, { recursive: true, force: true }));

  it('uses only fresh migrations 0001 through 0006', () => {
    expect(readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()).toEqual([
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql',
      '0006_crisp_attachment_provider.sql'
    ]);
  });

  it('atomically preserves AMBIGUOUS history while resolving and auditing CONFIRMED_SENT', () => {
    runSql(`
      UPDATE outbound_operations
      SET reconciliation_status = 'CONFIRMED_SENT', provider_message_ref = '91',
          resolved_by = 'system:chatwoot-source-id', resolved_at = 2,
          resolution_reason = 'CHATWOOT_SOURCE_ID_UNIQUE_MATCH', updated_at = 2
      WHERE id = 'op-confirm' AND status = 'AMBIGUOUS' AND reconciliation_status = 'PENDING';

      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'audit-confirm', 'OUTBOUND_OPERATION', 'op-confirm', 'RECONCILIATION_CONFIRMED_SENT',
             'SYSTEM', 'chatwoot-source-id', 'PENDING', 'CONFIRMED_SENT',
             'CHATWOOT_SOURCE_ID_UNIQUE_MATCH', 2
      WHERE changes() = 1;
    `);
    const row = runSql(`
      SELECT status, reconciliation_status, provider_message_ref,
             (SELECT COUNT(*) FROM reliability_audit WHERE entity_id = 'op-confirm') AS audit_count
      FROM outbound_operations WHERE id = 'op-confirm';
    `)[0].results[0];

    expect(row).toEqual({
      status: 'AMBIGUOUS',
      reconciliation_status: 'CONFIRMED_SENT',
      provider_message_ref: '91',
      audit_count: 1
    });
  }, 30_000);

  it('allows only one competing resolver CAS and matching audit to win', async () => {
    const deliveredFile = join(persistDir, 'resolve-delivered.sql');
    const cancelledFile = join(persistDir, 'resolve-cancelled.sql');
    writeFileSync(deliveredFile, `
      UPDATE outbound_operations
      SET reconciliation_status = 'MANUAL_MARK_DELIVERED', resolved_by = 'admin:1', resolved_at = 3,
          resolution_reason = 'OPERATOR_CONFIRMED_DELIVERY', updated_at = 3
      WHERE id = 'op-race' AND status = 'AMBIGUOUS' AND reconciliation_status = 'PENDING';
      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'audit-delivered', 'OUTBOUND_OPERATION', 'op-race', 'MANUAL_MARK_DELIVERED',
             'ADMIN', '1', 'PENDING', 'MANUAL_MARK_DELIVERED', 'OPERATOR_CONFIRMED_DELIVERY', 3
      WHERE changes() = 1;
    `);
    writeFileSync(cancelledFile, `
      UPDATE outbound_operations
      SET reconciliation_status = 'MANUAL_CANCELLED', resolved_by = 'admin:2', resolved_at = 3,
          resolution_reason = 'OPERATOR_CANCELLED', updated_at = 3
      WHERE id = 'op-race' AND status = 'AMBIGUOUS' AND reconciliation_status = 'PENDING';
      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'audit-cancelled', 'OUTBOUND_OPERATION', 'op-race', 'MANUAL_CANCELLED',
             'ADMIN', '2', 'PENDING', 'MANUAL_CANCELLED', 'OPERATOR_CANCELLED', 3
      WHERE changes() = 1;
    `);

    const attempts = await Promise.allSettled([
      execFileAsync('npx', wranglerArgs(deliveredFile), { encoding: 'utf8' }),
      execFileAsync('npx', wranglerArgs(cancelledFile), { encoding: 'utf8' })
    ]);
    expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true);

    const row = runSql(`
      SELECT status, reconciliation_status,
             (SELECT COUNT(*) FROM reliability_audit WHERE entity_id = 'op-race') AS audit_count
      FROM outbound_operations WHERE id = 'op-race';
    `)[0].results[0];
    expect(row.status).toBe('AMBIGUOUS');
    expect(['MANUAL_MARK_DELIVERED', 'MANUAL_CANCELLED']).toContain(row.reconciliation_status);
    expect(row.audit_count).toBe(1);

    const databaseFiles = execSync(`find ${persistDir} -name "*.sqlite" -print`, { encoding: 'utf8' }).trim();
    expect(databaseFiles).not.toBe('');
  }, 60_000);
});
