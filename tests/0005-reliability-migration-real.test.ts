import { execSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

describe('Real 0005 Reliability Migration', () => {
  const tmpDir = join(tmpdir(), `d1-migration-test-${Date.now()}`);
  let queryId = 0;
  
  const runSql = (sql: string) => {
    queryId++;
    const file = join(tmpDir, `query-${queryId}.sql`);
    writeFileSync(file, sql);
    try {
      const result = execSync(`npx wrangler d1 execute cz2128-db --local --persist-to ${tmpDir} --file ${file} --json`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const clean = result.trim().replace(/^[\s\S]*?(?=\[)/, '');
      return JSON.parse(clean);
    } catch (e: any) {
      console.error(e.stdout, e.stderr);
      throw e;
    }
  };

  const runMigration = (num: string) => {
    const file = `migrations/${num}`;
    execSync(`npx wrangler d1 execute cz2128-db --local --persist-to ${tmpDir} --file ${file}`, { stdio: 'pipe' });
  };

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    // Apply 0001 - 0004
    runMigration('0001_initial_schema.sql');
    runMigration('0002_ai_handoff.sql');
    runMigration('0003_attachments.sql');
    runMigration('0004_runtime_config.sql');

    // Seed Data
    runSql(`
      INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, created_at, updated_at, version) 
      VALUES ('conv_1', 'chatwoot', 'acc1', 'cw_1', 'cust1', 'telegram', 0, 0, 1);

      INSERT INTO messages (id, conversation_id, provider, direction, actor_role, message_type, created_at)
      VALUES ('msg_1', 'conv_1', 'chatwoot', 'INBOUND', 'CUSTOMER', 'TEXT', 0);

      INSERT INTO event_receipts (source, source_event_ref, status)
      VALUES ('telegram', 'ev_1', 'PROCESSED');

      INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, created_at, updated_at)
      VALUES 
        ('op_pending', 'conv_1', 'chatwoot', 'SEND_MESSAGE', 'PENDING', 0, 0),
        ('op_sending', 'conv_1', 'chatwoot', 'SEND_MESSAGE', 'SENDING', 0, 0),
        ('op_sent', 'conv_1', 'chatwoot', 'SEND_MESSAGE', 'SENT', 0, 0),
        ('op_failed_retryable', 'conv_1', 'chatwoot', 'SEND_MESSAGE', 'FAILED_RETRYABLE', 0, 0),
        ('op_failed_final', 'conv_1', 'chatwoot', 'SEND_MESSAGE', 'FAILED_FINAL', 0, 0),
        ('op_ambiguous', 'conv_1', 'chatwoot', 'SEND_MESSAGE', 'AMBIGUOUS', 0, 0);

      INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, handoff_epoch, status, created_at, updated_at)
      VALUES 
        ('ai_pending', 'conv_1', 'msg_1', 0, 'PENDING', 0, 0),
        ('ai_success', 'conv_1', 'msg_1', 0, 'SUCCESS', 0, 0),
        ('ai_failed', 'conv_1', 'msg_1', 0, 'FAILED', 0, 0),
        ('ai_cancelled', 'conv_1', 'msg_1', 0, 'CANCELLED_BY_HANDOFF', 0, 0),
        ('ai_stale', 'conv_1', 'msg_1', 0, 'DISCARDED_STALE', 0, 0);
        
      INSERT INTO attachments (id, conversation_id, source_provider, source_message_ref, source_attachment_ref, attachment_type, original_filename, safe_filename, mime_type, storage_key, access_token_hash, status, destination_provider, created_at, updated_at)
      VALUES 
        ('att_1', 'conv_1', 'telegram', 'msg_1', 'src_att_1', 'photo', 'test.jpg', 'test.jpg', 'image/jpeg', 'key1', 'hash1', 'STORED', 'chatwoot', 0, 0);
        
      INSERT INTO runtime_config (key, value_kind, value_text, version, updated_by, updated_at)
      VALUES ('test_key', 'PLAIN', 'test_value', 1, 'admin', 0);
    `);
  }, 60000);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves all rows and identities during 0005 upgrade', () => {
    const getCounts = () => {
      const res = runSql(`
        SELECT 
          (SELECT COUNT(*) FROM conversations) as c_count,
          (SELECT COUNT(*) FROM event_receipts) as e_count,
          (SELECT COUNT(*) FROM outbound_operations) as o_count,
          (SELECT COUNT(*) FROM ai_runs) as a_count,
          (SELECT COUNT(*) FROM attachments) as att_count,
          (SELECT COUNT(*) FROM runtime_config) as r_count
      `);
      return res[0].results[0];
    };

    const before = getCounts();
    expect(before.c_count).toBe(1);
    expect(before.e_count).toBe(1);
    expect(before.o_count).toBe(6);
    expect(before.a_count).toBe(5);
    expect(before.att_count).toBe(1);
    expect(before.r_count).toBe(1);

    runMigration('0005_reliability.sql');

    const after = getCounts();
    expect(after).toEqual(before);
  }, 60000);

  it('maps AMBIGUOUS to PENDING reconciliation status', () => {
    const res = runSql(`SELECT id, reconciliation_status FROM outbound_operations`);
    const ops = res[0].results;
    const ambiguous = ops.find((o: any) => o.id === 'op_ambiguous');
    const others = ops.filter((o: any) => o.id !== 'op_ambiguous');
    
    expect(ambiguous.reconciliation_status).toBe('PENDING');
    others.forEach((o: any) => {
      expect(o.reconciliation_status).toBe('NOT_REQUIRED');
    });
  }, 30000);

  it('safely maps FAILED to FAILED_FINAL for legacy AI runs but preserves the others', () => {
    const res = runSql(`SELECT trigger_event_ref, status FROM ai_runs`);
    const runs = res[0].results;
    
    const getStatus = (id: string) => runs.find((r: any) => r.trigger_event_ref === id).status;
    expect(getStatus('ai_pending')).toBe('PENDING');
    expect(getStatus('ai_success')).toBe('SUCCESS');
    expect(getStatus('ai_failed')).toBe('FAILED_FINAL');
    expect(getStatus('ai_cancelled')).toBe('CANCELLED_BY_HANDOFF');
    expect(getStatus('ai_stale')).toBe('DISCARDED_STALE');
  }, 30000);

  it('sets new AI run fields to defaults', () => {
    const res = runSql(`SELECT attempt_count, next_retry_at FROM ai_runs`);
    const runs = res[0].results;
    runs.forEach((r: any) => {
      expect(r.attempt_count).toBe(0);
      expect(r.next_retry_at).toBeNull();
    });
  }, 30000);
  
  it('allows inserting old FAILED and new FAILED_RETRYABLE statuses on AI runs for compatibility window', () => {
    runSql(`
      INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, handoff_epoch, status, created_at, updated_at)
      VALUES 
        ('ai_failed_compat', 'conv_1', 'msg_1', 0, 'FAILED', 0, 0),
        ('ai_failed_retryable', 'conv_1', 'msg_1', 0, 'FAILED_RETRYABLE', 0, 0),
        ('ai_retry_exhausted', 'conv_1', 'msg_1', 0, 'RETRY_EXHAUSTED', 0, 0);
    `);
    const res = runSql(`SELECT status FROM ai_runs WHERE trigger_event_ref IN ('ai_failed_compat', 'ai_failed_retryable', 'ai_retry_exhausted') ORDER BY status`);
    const statuses = res[0].results.map((r: any) => r.status);
    expect(statuses.sort()).toEqual(['FAILED', 'FAILED_RETRYABLE', 'RETRY_EXHAUSTED'].sort());
  }, 30000);

  it('passes integrity and foreign key checks via sqlite3 CLI', () => {
    const outFK = execSync(`find ${tmpDir} -name "*.sqlite" -print0 | xargs -0 -I {} sqlite3 {} "PRAGMA foreign_key_check;"`, { encoding: 'utf8' }).trim();
    expect(outFK).toBe('');

    const outInt = execSync(`find ${tmpDir} -name "*.sqlite" -print0 | xargs -0 -I {} sqlite3 {} "PRAGMA integrity_check;"`, { encoding: 'utf8' }).trim();
    expect(outInt).toMatch(/^ok(\nok)*$/);
  }, 30000);
});
