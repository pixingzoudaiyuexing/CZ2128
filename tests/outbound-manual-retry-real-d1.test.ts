import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveOutboundDomainState } from '../src/core/outbound-domain-resolution';

const execFileAsync = promisify(execFile);

describe('real D1 manual retry and domain CAS', () => {
  const persistDir = join(tmpdir(), `cz2128-manual-retry-d1-${Date.now()}`);
  let queryId = 0;

  function args(file: string, json = false): string[] {
    return [
      'wrangler', 'd1', 'execute', 'cz2128-db', '--local', '--persist-to', persistDir,
      '--file', file, ...(json ? ['--json'] : [])
    ];
  }

  function runFile(file: string, json = false): string {
    try {
      return execFileSync('npx', args(file, json), {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(`${failure.stdout || ''}\n${failure.stderr || ''}`.trim());
    }
  }

  function runSql(sql: string): any[] {
    const file = join(persistDir, `query-${++queryId}.sql`);
    writeFileSync(file, sql);
    return JSON.parse(runFile(file, true).trim().replace(/^[\s\S]*?(?=\[)/, ''));
  }

  function sqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') throw new Error('Unsupported real D1 test binding');
    return `'${value.replace(/'/g, "''")}'`;
  }

  function bindSql(query: string, values: unknown[]): string {
    let index = 0;
    const bound = query.replace(/\?/g, () => {
      if (index >= values.length) throw new Error('Missing real D1 test binding');
      return sqlValue(values[index++]);
    });
    if (index !== values.length) throw new Error('Unused real D1 test binding');
    return bound;
  }

  const realD1 = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...params: unknown[]) {
          values = params;
          return statement;
        },
        async first<T>() {
          const result = runSql(`${bindSql(query, values)};`)[0];
          return (result.results?.[0] as T | undefined) || null;
        },
        async all<T>() {
          const result = runSql(`${bindSql(query, values)};`)[0];
          return { results: (result.results || []) as T[], success: true, meta: result.meta || {} };
        },
        async run() {
          const result = runSql(`${bindSql(query, values)};`)[0];
          return { success: true, meta: result.meta || { changes: 0 } };
        }
      };
      return statement;
    }
  };

  beforeAll(() => {
    mkdirSync(persistDir, { recursive: true });
    for (const migration of [
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql'
    ]) runFile(join('migrations', migration));

    runSql(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
      VALUES
      ('conv-create', 'chatwoot', '1', '2', '3', 'telegram', NULL, 'OPEN', 1, 1, 1),
      ('conv-status', 'chatwoot', '1', '4', '5', 'telegram', '77', 'OPEN', 1, 1, 1),
      ('conv-stale-group', 'chatwoot', '1', '6', '7', 'telegram', '88', 'OPEN', 1, 1, 1);

      INSERT INTO outbound_operations
      (id, conversation_id, destination_provider, operation_type, status, attempt_count,
       request_started_at, reconciliation_status, subject_type, subject_ref, target_evidence_json,
       created_at, updated_at)
      VALUES
      ('parent-race', 'conv-status', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 1, 1, 'PENDING',
       'MESSAGE', 'chatwoot:1',
       '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-1001","threadRef":"77","method":"sendMessage"}', 1, 1),
      ('op-attachment', 'conv-status', 'telegram', 'SEND_ATTACHMENT', 'SENT', 1, 1, 'NOT_REQUIRED',
       'ATTACHMENT', 'att-race',
       '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-1001","threadRef":"77","method":"sendDocument"}', 1, 1),
      ('op-create', 'conv-create', 'telegram', 'CREATE_TOPIC', 'SENT', 1, 1, 'NOT_REQUIRED',
       'CONVERSATION', 'conv-create',
       '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-1001","method":"createForumTopic"}', 1, 1),
      ('op-close', 'conv-status', 'telegram', 'CLOSE_TOPIC', 'SENT', 1, 1, 'NOT_REQUIRED',
       'CONVERSATION', 'conv-status',
       '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-1001","threadRef":"77","method":"closeForumTopic"}', 1, 1),
      ('op-stale-group', 'conv-stale-group', 'telegram', 'CLOSE_TOPIC', 'SENT', 1, 1, 'NOT_REQUIRED',
       'CONVERSATION', 'conv-stale-group',
       '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-100111","threadRef":"88","method":"closeForumTopic"}', 1, 1);

      UPDATE outbound_operations SET provider_message_ref = '701' WHERE id = 'op-create';
      UPDATE outbound_operations SET provider_message_ref = '601' WHERE id = 'op-attachment';

      INSERT INTO attachments
      (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
       attachment_type, original_filename, safe_filename, mime_type, size_bytes,
       storage_key, access_token_hash, status, destination_provider, attempt_count,
       expires_at, last_error, created_at, updated_at)
      VALUES ('att-race', 'conv-status', 'chatwoot', '1', '1', 'document', 'a', 'a',
              'application/octet-stream', 1, 'attachments/a', 'hash-a', 'FAILED_FINAL',
              'telegram', 2, 9999999999, 'ATTACHMENT_DELIVERY_AMBIGUOUS', 1, 1);
    `);
  }, 60_000);

  afterAll(() => rmSync(persistDir, { recursive: true, force: true }));

  it('two concurrent creators produce one child, one parent transition and one audit', async () => {
    const creatorSql = `
      INSERT INTO outbound_operations
      (id, conversation_id, destination_provider, operation_type, status,
       provider_message_ref, attempt_count, lease_until, lease_token, last_error,
       created_at, updated_at, request_started_at, response_observed_at,
       response_http_status, next_retry_at, retry_after_seconds, reconciliation_status,
       resolved_by, resolved_at, resolution_reason, parent_operation_id,
       subject_type, subject_ref, target_evidence_json)
      SELECT 'manual_retry:fixed', conversation_id, destination_provider, operation_type, 'PENDING',
             NULL, 0, NULL, NULL, NULL, 2, 2, NULL, NULL, NULL, NULL, NULL, 'NOT_REQUIRED',
             NULL, NULL, NULL, id, subject_type, subject_ref,
             '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-1001","threadRef":"77","method":"sendMessage"}'
      FROM outbound_operations
      WHERE id = 'parent-race' AND status = 'AMBIGUOUS'
        AND reconciliation_status = 'PENDING'
        AND NOT EXISTS (
          SELECT 1 FROM outbound_operations child WHERE child.parent_operation_id = outbound_operations.id
        )
      ON CONFLICT (id) DO NOTHING;

      UPDATE outbound_operations
      SET reconciliation_status = 'MANUAL_RETRY_CREATED', resolved_by = 'admin:42', resolved_at = 2,
          resolution_reason = 'OPERATOR_ACCEPTS_DUPLICATE_RISK', updated_at = 2
      WHERE id = 'parent-race' AND status = 'AMBIGUOUS'
        AND reconciliation_status = 'PENDING'
        AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM outbound_operations child
          WHERE child.id = 'manual_retry:fixed' AND child.parent_operation_id = outbound_operations.id
        );

      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'manual-retry-audit', 'OUTBOUND_OPERATION', 'parent-race',
             'MANUAL_RETRY_CHILD_CREATED', 'ADMIN', '42', 'PENDING', 'MANUAL_RETRY_CREATED',
             'OPERATOR_ACCEPTS_DUPLICATE_RISK', 2
      WHERE changes() = 1;
    `;
    const first = join(persistDir, 'creator-a.sql');
    const second = join(persistDir, 'creator-b.sql');
    writeFileSync(first, creatorSql);
    writeFileSync(second, creatorSql);

    const attempts = await Promise.allSettled([
      execFileAsync('npx', args(first), { encoding: 'utf8' }),
      execFileAsync('npx', args(second), { encoding: 'utf8' })
    ]);
    expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true);

    const row = runSql(`
      SELECT status, reconciliation_status, parent_operation_id,
        (SELECT COUNT(*) FROM outbound_operations WHERE parent_operation_id = 'parent-race') AS child_count,
        (SELECT COUNT(*) FROM reliability_audit
         WHERE entity_id = 'parent-race' AND action = 'MANUAL_RETRY_CHILD_CREATED') AS audit_count
      FROM outbound_operations WHERE id = 'parent-race';
    `)[0].results[0];
    expect(row).toEqual({
      status: 'AMBIGUOUS', reconciliation_status: 'MANUAL_RETRY_CREATED',
      parent_operation_id: null, child_count: 1, audit_count: 1
    });
    const child = runSql(`
      SELECT status, attempt_count, request_started_at, response_observed_at,
             response_http_status, reconciliation_status, parent_operation_id
      FROM outbound_operations WHERE id = 'manual_retry:fixed';
    `)[0].results[0];
    expect(child).toEqual({
      status: 'PENDING', attempt_count: 0, request_started_at: null,
      response_observed_at: null, response_http_status: null,
      reconciliation_status: 'NOT_REQUIRED', parent_operation_id: 'parent-race'
    });
  }, 60_000);

  it('attachment domain CAS produces one delivery transition and matching audit', async () => {
    const resolutionSql = `
      UPDATE attachments
      SET status = 'DELIVERED', destination_message_ref = '601', last_error = NULL,
          updated_at = 3
      WHERE id = 'att-race' AND conversation_id = 'conv-status' AND destination_provider = 'telegram'
        AND (status = 'STORED' OR (status = 'FAILED_FINAL' AND last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS'));
      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'domain-attachment-audit', 'OUTBOUND_OPERATION', 'op-attachment',
             'DOMAIN_STATE_RESOLVED', 'SYSTEM', 'system:outbound-domain-resolution',
             'FAILED_FINAL', 'DELIVERED', 'ATTACHMENT_EFFECTIVE_DELIVERY', 3
      WHERE changes() = 1;
    `;
    const first = join(persistDir, 'attachment-a.sql');
    const second = join(persistDir, 'attachment-b.sql');
    writeFileSync(first, resolutionSql);
    writeFileSync(second, resolutionSql);
    await Promise.allSettled([
      execFileAsync('npx', args(first), { encoding: 'utf8' }),
      execFileAsync('npx', args(second), { encoding: 'utf8' })
    ]);

    const row = runSql(`
      SELECT status, destination_message_ref, last_error, attempt_count,
        (SELECT COUNT(*) FROM reliability_audit WHERE id = 'domain-attachment-audit') AS audit_count
      FROM attachments WHERE id = 'att-race';
    `)[0].results[0];
    expect(row).toEqual({
      status: 'DELIVERED', destination_message_ref: '601', last_error: null,
      attempt_count: 2, audit_count: 1
    });
  }, 60_000);

  it('conversation thread mapping CAS sets only the missing mapping', () => {
    runSql(`
      UPDATE conversations
      SET operator_thread_ref = '701', updated_at = 3, version = version + 1
      WHERE id = 'conv-create' AND operator_thread_ref IS NULL AND version = 1;
      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'domain-create-audit', 'OUTBOUND_OPERATION', 'op-create', 'DOMAIN_STATE_RESOLVED',
             'SYSTEM', 'system:outbound-domain-resolution', 'THREAD_REF_NULL', 'THREAD_REF_SET',
             'CREATE_TOPIC_EFFECTIVE_DELIVERY', 3 WHERE changes() = 1;
    `);
    runSql(`
      UPDATE conversations SET operator_thread_ref = 'conflict', version = version + 1
      WHERE id = 'conv-create' AND operator_thread_ref IS NULL AND version = 1;
    `);
    const row = runSql(`
      SELECT operator_thread_ref, version,
        (SELECT COUNT(*) FROM reliability_audit WHERE id = 'domain-create-audit') AS audit_count
      FROM conversations WHERE id = 'conv-create';
    `)[0].results[0];
    expect(row).toEqual({ operator_thread_ref: '701', version: 2, audit_count: 1 });
  }, 30_000);

  it('conversation status CAS closes only the persisted current thread', () => {
    runSql(`
      UPDATE conversations
      SET operator_thread_status = 'CLOSED', updated_at = 4, version = version + 1
      WHERE id = 'conv-status' AND version = 1 AND operator_thread_status = 'OPEN'
        AND operator_thread_ref = '77';
      INSERT INTO reliability_audit
      (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
      SELECT 'domain-close-audit', 'OUTBOUND_OPERATION', 'op-close', 'DOMAIN_STATE_RESOLVED',
             'SYSTEM', 'system:outbound-domain-resolution', 'OPEN', 'CLOSED',
             'CLOSE_TOPIC_EFFECTIVE_DELIVERY', 4 WHERE changes() = 1;
    `);
    runSql(`
      UPDATE conversations SET operator_thread_status = 'OPEN', version = version + 1
      WHERE id = 'conv-status' AND version = 1 AND operator_thread_ref = 'wrong-thread';
    `);
    const row = runSql(`
      SELECT operator_thread_status, operator_thread_ref, version,
        (SELECT COUNT(*) FROM reliability_audit WHERE id = 'domain-close-audit') AS audit_count
      FROM conversations WHERE id = 'conv-status';
    `)[0].results[0];
    expect(row).toEqual({
      operator_thread_status: 'CLOSED', operator_thread_ref: '77', version: 2, audit_count: 1
    });
  }, 30_000);

  it('real D1 service blocks a stale-group operation with the same thread reference', async () => {
    const env = { DB: realD1, BOT_GROUP_ID: '-100222' } as any;

    await expect(resolveOutboundDomainState(env, 'op-stale-group')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    await expect(resolveOutboundDomainState(env, 'op-stale-group')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });

    const row = runSql(`
      SELECT operator_thread_ref, operator_thread_status,
        (SELECT COUNT(*) FROM reliability_audit
         WHERE entity_id = 'op-stale-group' AND action = 'DOMAIN_STATE_CONFLICT') AS audit_count
      FROM conversations WHERE id = 'conv-stale-group';
    `)[0].results[0];
    expect(row).toEqual({
      operator_thread_ref: '88', operator_thread_status: 'OPEN', audit_count: 1
    });
  }, 60_000);
});
