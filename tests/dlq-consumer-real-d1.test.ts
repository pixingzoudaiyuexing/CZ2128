import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureDlqMessage } from '../src/queue/dlq-consumer';

const execFileAsync = promisify(execFile);

describe('real D1 DLQ receipt durability', () => {
  const persistDir = join(tmpdir(), `cz2128-dlq-d1-${Date.now()}`);
  let queryId = 0;

  function args(file: string, json = false): string[] {
    return [
      'wrangler', 'd1', 'execute', 'cz2128-db', '--local', '--persist-to', persistDir,
      '--file', file, ...(json ? ['--json'] : [])
    ];
  }

  function runFile(file: string, json = false): string {
    return execFileSync('npx', args(file, json), { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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
        query,
        get values() { return values; },
        bind(...params: unknown[]) { values = params; return statement; },
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
    },
    async batch(statements: Array<{ query: string; values: unknown[] }>) {
      runSql(statements.map(statement => `${bindSql(statement.query, statement.values)};`).join('\n'));
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
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
       operator_channel, created_at, updated_at, version)
      VALUES ('conv-1', 'chatwoot', 'account-1', 'conversation-1', 'customer-1', 'telegram', 1, 1, 1);
      INSERT INTO event_receipts
      (source, source_event_ref, status, attempt_count, last_error, processed_at)
      VALUES
      ('chatwoot', 'event-failed', 'FAILED', 3, 'D1_WRITE_FAILED', NULL),
      ('chatwoot', 'event-processed', 'PROCESSED', 2, NULL, 90);
    `);
  }, 60_000);

  afterAll(() => rmSync(persistDir, { recursive: true, force: true }));

  it('uses only migrations 0001 through 0005', () => {
    expect(readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()).toEqual([
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql'
    ]);
  });

  it('serializes concurrent duplicate upserts with exact delivery count and immutable first_seen', async () => {
    const id = 'dlq:v1:concurrent';
    runSql(`
      INSERT INTO dlq_receipts
      (id, queue_name, safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
      VALUES ('${id}', 'cz2128-dlq', 'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, 100, 100);
    `);
    const upsert = (lastSeen: number) => `
      INSERT INTO dlq_receipts
      (id, queue_name, safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
      VALUES ('${id}', 'cz2128-dlq', 'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, ${lastSeen}, ${lastSeen})
      ON CONFLICT (id) DO UPDATE SET
        delivery_count = dlq_receipts.delivery_count + 1,
        last_seen_at = MAX(dlq_receipts.last_seen_at, excluded.last_seen_at);
    `;
    const first = join(persistDir, 'dlq-upsert-a.sql');
    const second = join(persistDir, 'dlq-upsert-b.sql');
    writeFileSync(first, upsert(200));
    writeFileSync(second, upsert(300));
    const attempts = await Promise.allSettled([
      execFileAsync('npx', args(first), { encoding: 'utf8' }),
      execFileAsync('npx', args(second), { encoding: 'utf8' })
    ]);
    expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true);
    if (attempts[0].status === 'rejected') runFile(first);
    if (attempts[1].status === 'rejected') runFile(second);
    const row = runSql(
      `SELECT delivery_count, first_seen_at, last_seen_at FROM dlq_receipts WHERE id = '${id}';`
    )[0].results[0];
    expect(row).toEqual({ delivery_count: 3, first_seen_at: 100, last_seen_at: 300 });
  }, 60_000);

  it('updates event dead-letter metadata and resolves an already processed race through the service', async () => {
    const failedCapture = await captureDlqMessage({ DB: realD1 as any }, {
      id: 'cf-failed',
      body: {
        version: 1,
        source: 'chatwoot',
        type: 'message_created',
        eventId: 'event-failed',
        payload: { accountRef: 'account-1', conversationRef: 'conversation-1' }
      }
    } as any, 400);
    const failed = runSql(`SELECT * FROM dlq_receipts WHERE id = '${failedCapture.id}';`)[0].results[0];
    expect(failed).toMatchObject({ status: 'OPEN', conversation_id: 'conv-1', safe_error_code: 'D1_WRITE_FAILED' });

    const processedCapture = await captureDlqMessage({ DB: realD1 as any }, {
      id: 'cf-processed',
      body: {
        version: 1,
        source: 'chatwoot',
        type: 'message_created',
        eventId: 'event-processed',
        payload: { accountRef: 'account-1', conversationRef: 'conversation-1' }
      }
    } as any, 500);
    const processed = runSql(`SELECT * FROM dlq_receipts WHERE id = '${processedCapture.id}';`)[0].results[0];
    expect(processed).toMatchObject({ status: 'RESOLVED', resolved_at: 500 });

    const rows = runSql(`
      SELECT source_event_ref, status, attempt_count, last_error, processed_at,
             last_attempt_at, dead_lettered_at
      FROM event_receipts
      WHERE source_event_ref IN ('event-failed', 'event-processed')
      ORDER BY source_event_ref;
    `)[0].results;
    expect(rows).toEqual([
      {
        source_event_ref: 'event-failed', status: 'FAILED', attempt_count: 3,
        last_error: 'D1_WRITE_FAILED', processed_at: null, last_attempt_at: 400, dead_lettered_at: 400
      },
      {
        source_event_ref: 'event-processed', status: 'PROCESSED', attempt_count: 2,
        last_error: null, processed_at: 90, last_attempt_at: 500, dead_lettered_at: 500
      }
    ]);
  }, 60_000);
});
