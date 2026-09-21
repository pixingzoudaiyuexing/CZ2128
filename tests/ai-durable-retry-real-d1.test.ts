import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Env } from '../src/config/env';
import {
  cancelDurableAiRunForScope,
  claimDurableAiRun,
  discardOwnedStaleAiRun,
  getDurableAiRun,
  normalizeLegacyAiRun,
  saveAiGenerationFailure,
  saveGeneratedAiResult,
  startAiGenerationAttempt
} from '../src/core/ai-state';

const execFileAsync = promisify(execFile);

describe('real D1 durable AI retry CAS', () => {
  const persistDir = join(tmpdir(), `cz2128-ai-retry-d1-${Date.now()}`);
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
          const results = runSql(`${bindSql(query, values)}; SELECT changes() AS changes;`);
          const changes = Number(results[results.length - 1]?.results?.[0]?.changes || 0);
          return { success: true, meta: { changes } };
        }
      };
      return statement;
    }
  };

  const env = {
    DB: realD1,
    AI_BASE_URL: 'https://ai.example/v1',
    AI_API_KEY: 'key',
    AI_MODEL: 'model',
    AI_GENERATION_LEASE_SECONDS: '60'
  } as unknown as Env;

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
      VALUES
      ('conv-attempt', 'chatwoot', '1', '1', '1', 'telegram', 1, 1, 1),
      ('conv-exhaust', 'chatwoot', '1', '2', '2', 'telegram', 1, 1, 1),
      ('conv-race', 'chatwoot', '1', '3', '3', 'telegram', 1, 1, 1),
      ('conv-legacy', 'chatwoot', '1', '4', '4', 'telegram', 1, 1, 1),
      ('conv-stale', 'chatwoot', '1', '5', '5', 'telegram', 1, 1, 1),
      ('conv-scope', 'chatwoot', '1', '6', '6', 'telegram', 1, 1, 1);
    `);
  }, 60_000);

  afterAll(() => rmSync(persistDir, { recursive: true, force: true }));

  it('increments attempt_count only through the owned attempt-start CAS', async () => {
    const now = Math.floor(Date.now() / 1000);
    runSql(`
      UPDATE conversations
      SET ai_generation_id = 'generation-attempt', ai_generation_started_at = ${now},
          ai_generation_message_id = 'message-attempt'
      WHERE id = 'conv-attempt';
    `);
    expect(await claimDurableAiRun(
      env, 'run-attempt', 'conv-attempt', 'message-attempt', 'generation-attempt', 0
    )).toBe(true);
    expect(await startAiGenerationAttempt(
      env, 'run-attempt', 'conv-attempt', 'generation-attempt', 0
    )).toBe(1);
    runSql("UPDATE conversations SET ai_generation_id = 'other-generation' WHERE id = 'conv-attempt';");
    expect(await startAiGenerationAttempt(
      env, 'run-attempt', 'conv-attempt', 'generation-attempt', 0
    )).toBeNull();
    expect(runSql("SELECT attempt_count FROM ai_runs WHERE trigger_event_ref = 'run-attempt';")[0].results[0])
      .toEqual({ attempt_count: 1 });
  }, 60_000);

  it('persists three-attempt exhaustion and leaves no fourth attempt capacity', async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const generation = `generation-exhaust-${attempt}`;
      const now = Math.floor(Date.now() / 1000);
      runSql(`
        UPDATE conversations
        SET ai_generation_id = '${generation}', ai_generation_started_at = ${now},
            ai_generation_message_id = 'message-exhaust'
        WHERE id = 'conv-exhaust';
      `);
      expect(await claimDurableAiRun(
        env, 'run-exhaust', 'conv-exhaust', 'message-exhaust', generation, 0
      )).toBe(true);
      expect(await startAiGenerationAttempt(
        env, 'run-exhaust', 'conv-exhaust', generation, 0
      )).toBe(attempt);
      const failed = await saveAiGenerationFailure(
        env, 'run-exhaust', 'conv-exhaust', generation, 0, 'AI_PROVIDER_5XX', true, 5
      );
      expect(failed?.status).toBe(attempt === 3 ? 'RETRY_EXHAUSTED' : 'FAILED_RETRYABLE');
      runSql("UPDATE ai_runs SET next_retry_at = 0 WHERE trigger_event_ref = 'run-exhaust' AND status = 'FAILED_RETRYABLE';");
    }
    expect(await claimDurableAiRun(
      env, 'run-exhaust', 'conv-exhaust', 'message-exhaust', 'generation-exhaust-4', 0
    )).toBe(false);
    expect(runSql(`
      SELECT status, attempt_count, next_retry_at, last_error
      FROM ai_runs WHERE trigger_event_ref = 'run-exhaust';
    `)[0].results[0]).toEqual({
      status: 'RETRY_EXHAUSTED', attempt_count: 3,
      next_retry_at: null, last_error: 'AI_RETRY_EXHAUSTED'
    });
  }, 120_000);

  it('allows one concurrent conversation lease and one same-trigger durable owner', async () => {
    const now = Math.floor(Date.now() / 1000);
    const threshold = now - 60;
    const claimant = (name: string) => `
      UPDATE conversations
      SET ai_generation_id = '${name}', ai_generation_started_at = ${now},
          ai_generation_message_id = 'message-race'
      WHERE id = 'conv-race' AND ai_mode = 'ENABLED' AND ai_handoff_epoch = 0
        AND (ai_generation_id IS NULL OR ai_generation_started_at < ${threshold});
      INSERT INTO ai_runs
      (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
       status, attempt_count, created_at, updated_at)
      SELECT 'run-race', 'conv-race', 'message-race', '${name}', 0, 'PENDING', 0, ${now}, ${now}
      WHERE changes() = 1
      ON CONFLICT (trigger_event_ref) DO UPDATE
      SET generation_id = excluded.generation_id, updated_at = excluded.updated_at
      WHERE ai_runs.status = 'PENDING' AND ai_runs.attempt_count < 3;
    `;
    const files = ['generation-race-a', 'generation-race-b'].map(name => {
      const file = join(persistDir, `${name}.sql`);
      writeFileSync(file, claimant(name));
      return file;
    });
    const results = await Promise.allSettled(files.map(file =>
      execFileAsync('npx', args(file), { encoding: 'utf8' })
    ));
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const row = runSql(`
      SELECT c.ai_generation_id, r.generation_id, r.status,
        (SELECT COUNT(*) FROM ai_runs WHERE trigger_event_ref = 'run-race') AS run_count
      FROM conversations c JOIN ai_runs r ON r.conversation_id = c.id
      WHERE c.id = 'conv-race';
    `)[0].results[0];
    expect(row.run_count).toBe(1);
    expect(row.status).toBe('PENDING');
    expect(row.generation_id).toBe(row.ai_generation_id);
  }, 120_000);

  it('lazily normalizes legacy FAILED with CAS and minimum attempt accounting', async () => {
    runSql(`
      INSERT INTO ai_runs
      (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
       status, attempt_count, next_retry_at, last_error, created_at, updated_at)
      VALUES ('run-legacy', 'conv-legacy', 'message-legacy', 'generation-legacy', 0,
              'FAILED', 0, NULL, 'AI_RATE_LIMITED', 1, 1);
    `);
    const before = await getDurableAiRun(env, 'run-legacy');
    if (!before) throw new Error('missing legacy run');
    const first = await normalizeLegacyAiRun(env, before);
    const second = await normalizeLegacyAiRun(env, before);
    expect(first).toMatchObject({ status: 'FAILED_RETRYABLE', attempt_count: 1, last_error: 'AI_RATE_LIMITED' });
    expect(second).toMatchObject({ status: 'FAILED_RETRYABLE', attempt_count: 1, last_error: 'AI_RATE_LIMITED' });
    expect(Number(first.next_retry_at) - Number(first.updated_at)).toBe(5);
  }, 60_000);

  it('prevents stale generation result mutations after a newer owner is bound', async () => {
    const now = Math.floor(Date.now() / 1000);
    runSql(`
      UPDATE conversations
      SET ai_generation_id = 'generation-new', ai_generation_started_at = ${now},
          ai_generation_message_id = 'message-stale'
      WHERE id = 'conv-stale';
      INSERT INTO ai_runs
      (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
       status, attempt_count, created_at, updated_at)
      VALUES ('run-stale', 'conv-stale', 'message-stale', 'generation-new', 0,
              'PENDING', 2, 1, 1);
    `);
    expect(await claimDurableAiRun(
      env, 'run-stale', 'conv-stale', 'message-stale', 'generation-old', 0
    )).toBe(false);
    expect(await saveGeneratedAiResult(
      env, 'run-stale', 'conv-stale', 'generation-old', 0, 'old-response', 'old text'
    )).toBe(false);
    expect(await discardOwnedStaleAiRun(env, 'run-stale', 'generation-old')).toBe(false);
    expect(runSql(`
      SELECT status, generation_id, attempt_count, provider_response_ref, response_text
      FROM ai_runs WHERE trigger_event_ref = 'run-stale';
    `)[0].results[0]).toEqual({
      status: 'PENDING', generation_id: 'generation-new', attempt_count: 2,
      provider_response_ref: null, response_text: null
    });
  }, 60_000);

  it('terminalizes a retryable run and releases its generation lease when scope denies it', async () => {
    const now = Math.floor(Date.now() / 1000);
    runSql(`
      UPDATE conversations
      SET ai_generation_id = 'generation-scope', ai_generation_started_at = ${now},
          ai_generation_message_id = 'message-scope'
      WHERE id = 'conv-scope';
    `);
    expect(await claimDurableAiRun(
      env, 'run-scope', 'conv-scope', 'message-scope', 'generation-scope', 0
    )).toBe(true);
    expect(await startAiGenerationAttempt(
      env, 'run-scope', 'conv-scope', 'generation-scope', 0
    )).toBe(1);
    expect((await saveAiGenerationFailure(
      env, 'run-scope', 'conv-scope', 'generation-scope', 0, 'AI_PROVIDER_5XX', true, 5
    ))?.status).toBe('FAILED_RETRYABLE');

    expect(await cancelDurableAiRunForScope(
      env, 'run-scope', 'conv-scope', 'message-scope'
    )).toBe(true);
    expect(await cancelDurableAiRunForScope(
      env, 'run-scope', 'conv-scope', 'message-scope'
    )).toBe(false);
    expect(runSql(`
      SELECT status, attempt_count, next_retry_at, last_error
      FROM ai_runs WHERE trigger_event_ref = 'run-scope';
    `)[0].results[0]).toEqual({
      status: 'FAILED_FINAL', attempt_count: 1,
      next_retry_at: null, last_error: 'AI_SCOPE_DENIED'
    });
    expect(runSql(`
      SELECT ai_generation_id, ai_generation_started_at, ai_generation_message_id
      FROM conversations WHERE id = 'conv-scope';
    `)[0].results[0]).toEqual({
      ai_generation_id: null,
      ai_generation_started_at: null,
      ai_generation_message_id: null
    });
  }, 60_000);
});
