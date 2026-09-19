import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import {
  acquireGenerationLease,
  claimDurableAiRun,
  discardOwnedStaleAiRun,
  getDurableAiRun,
  normalizeLegacyAiRun,
  pauseOperator,
  saveGeneratedAiResult,
  startAiGenerationAttempt
} from '../src/core/ai-state';
import { RetryableProcessingError } from '../src/core/errors';
import { processAiTrigger } from '../src/queue/ai-handler';
import { SqliteD1 } from './helpers/sqlite-d1';

const NOW = Date.parse('2026-09-14T00:00:00Z');

function makeEnv(db: SqliteD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CHATWOOT_WEBHOOK_SECRET: 'webhook-secret',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    CHATWOOT_API_URL: 'https://chat.example',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    AI_BASE_URL: 'https://ai.example/v1',
    AI_API_KEY: 'ai-key',
    AI_MODEL: 'model',
    AI_SYSTEM_PROMPT: 'System policy',
    AI_GENERATION_LEASE_SECONDS: '60',
    ...overrides
  } as Env;
}

async function seedConversation(db: SqliteD1, id = 'conv', thread: string | null = null): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, created_at, updated_at, version)
     VALUES (?, 'chatwoot', 'account-1', ?, 'customer-1', 'telegram', ?, 1, 1, 1)`
  ).bind(id, `conversation-${id}`, thread).run();
}

function event(id = 'ai-trigger', convId = 'conv') {
  return {
    version: 1 as const,
    source: 'internal' as const,
    type: 'ai_trigger' as const,
    eventId: id,
    payload: { convId, messageId: `message-${id}` }
  };
}

async function loadRun(db: SqliteD1, id = 'ai-trigger') {
  return db.prepare('SELECT * FROM ai_runs WHERE trigger_event_ref = ?').bind(id).first<any>();
}

describe('durable AI retry state machine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['408 timeout', new Response('', { status: 408 }), 'AI_TIMEOUT', 'FAILED_RETRYABLE'],
    ['5xx', new Response('', { status: 503 }), 'AI_PROVIDER_5XX', 'FAILED_RETRYABLE'],
    ['ordinary 4xx', new Response('', { status: 400 }), 'AI_PROVIDER_4XX', 'FAILED_FINAL'],
    ['invalid JSON', new Response('{', { status: 200 }), 'AI_INVALID_RESPONSE', 'FAILED_RETRYABLE'],
    ['invalid success', new Response(JSON.stringify({ choices: [] }), { status: 200 }), 'AI_INVALID_RESPONSE', 'FAILED_RETRYABLE']
  ] as const)('classifies %s into the durable state machine', async (_label, response, error, status) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    const processing = processAiTrigger(event(), makeEnv(db));
    if (status === 'FAILED_RETRYABLE') {
      await expect(processing).rejects.toBeInstanceOf(RetryableProcessingError);
    } else {
      await processing;
    }
    expect(await loadRun(db)).toMatchObject({ status, last_error: error, attempt_count: 1 });
    expect((await loadRun(db)).status).not.toBe('FAILED');
    db.close();
  });

  it('persists bounded Retry-After for AI 429', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 429, headers: { 'Retry-After': '30' } })
    );

    await expect(processAiTrigger(event(), makeEnv(db))).rejects.toMatchObject({
      code: 'AI_RATE_LIMITED', retryAfterSeconds: 30
    });
    expect(await loadRun(db)).toMatchObject({
      status: 'FAILED_RETRYABLE', attempt_count: 1,
      next_retry_at: Math.floor(NOW / 1000) + 30, last_error: 'AI_RATE_LIMITED'
    });
    db.close();
  });

  it('persists invalid AI context as FAILED_FINAL without a provider fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await processAiTrigger(event(), makeEnv(db, { AI_SYSTEM_PROMPT: '   ' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRun(db)).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'AI_CONTEXT_INVALID', attempt_count: 1
    });
    db.close();
  });

  it('uses exactly three provider attempts and never permits a fourth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const env = makeEnv(db);

    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({ code: 'AI_PROVIDER_5XX' });
    expect(await loadRun(db)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt_count: 1 });
    vi.advanceTimersByTime(5_000);
    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({ code: 'AI_PROVIDER_5XX' });
    expect(await loadRun(db)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt_count: 2 });
    vi.advanceTimersByTime(5_000);
    await processAiTrigger(event(), env);
    expect(await loadRun(db)).toMatchObject({
      status: 'RETRY_EXHAUSTED', attempt_count: 3, next_retry_at: null,
      last_error: 'AI_RETRY_EXHAUSTED'
    });
    await processAiTrigger(event(), env);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('blocks before next_retry_at without changing attempts and resumes the same run after it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'response-2', choices: [{ message: { content: 'Recovered' } }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 99 }), { status: 200 }));
    const env = makeEnv(db);

    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({ code: 'AI_PROVIDER_5XX' });
    const firstGeneration = (await loadRun(db)).generation_id;
    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({ code: 'AI_PROVIDER_5XX' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await loadRun(db)).attempt_count).toBe(1);

    vi.advanceTimersByTime(5_000);
    await processAiTrigger(event(), env);
    const run = await loadRun(db);
    expect(run).toMatchObject({ status: 'SUCCESS', attempt_count: 2, response_text: 'Recovered' });
    expect(run.generation_id).not.toBe(firstGeneration);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('allows one provider generation call for concurrent same-trigger workers', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let aiCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        aiCalls += 1;
        await gate;
        return new Response(JSON.stringify({
          id: 'response-race', choices: [{ message: { content: 'One answer' } }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 100 }), { status: 200 });
    });
    const env = makeEnv(db);
    const first = processAiTrigger(event(), env);
    while (aiCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));

    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({
      code: 'CONCURRENCY_LEASE_HELD'
    });
    release();
    await first;

    expect(aiCalls).toBe(1);
    expect(await loadRun(db)).toMatchObject({ status: 'SUCCESS', attempt_count: 1 });
    db.close();
  });

  it('keeps the normal fresh AI path able to create first Chatwoot and Telegram operations', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'conv', '77');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let aiCalls = 0;
    let chatwootCalls = 0;
    let telegramCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        aiCalls += 1;
        await gate;
        return new Response(JSON.stringify({
          id: 'fresh-response', choices: [{ message: { content: 'Fresh response' } }]
        }), { status: 200 });
      }
      if (String(url).includes('chat.example')) {
        chatwootCalls += 1;
        return new Response(JSON.stringify({ id: 1001 }), { status: 200 });
      }
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1002 } }), { status: 200 });
    });
    const env = makeEnv(db);
    const processing = processAiTrigger(event('fresh-normal'), env);
    while (aiCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));

    expect((await db.prepare('SELECT status, target_evidence_json FROM outbound_operations WHERE id = ?')
      .bind('ai_reply:fresh-normal').first<any>())).toMatchObject({ status: 'PENDING' });
    release();
    await processing;

    expect(aiCalls).toBe(1);
    expect(chatwootCalls).toBe(1);
    expect(telegramCalls).toBe(1);
    expect((await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
      .bind('ai_reply:fresh-normal').first<any>()).status).toBe('SENT');
    expect((await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
      .bind('ai_tg_mirror:fresh-normal').first<any>()).status).toBe('SENT');
    db.close();
  });

  it('prevents generation A from overwriting or marking generation B stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db, { AI_GENERATION_LEASE_SECONDS: '10', AI_REQUEST_TIMEOUT_MS: '5000' });
    const first = await acquireGenerationLease(env, 'conv', 'message-race');
    if (!first.success) throw new Error('first lease failed');
    expect(await claimDurableAiRun(env, 'race-run', 'conv', 'message-race', first.generationId, first.handoffEpoch)).toBe(true);
    expect(await startAiGenerationAttempt(env, 'race-run', 'conv', first.generationId, first.handoffEpoch)).toBe(1);

    vi.advanceTimersByTime(16_000);
    const second = await acquireGenerationLease(env, 'conv', 'message-race');
    if (!second.success) throw new Error('second lease failed');
    expect(await claimDurableAiRun(env, 'race-run', 'conv', 'message-race', second.generationId, second.handoffEpoch)).toBe(true);
    expect(await startAiGenerationAttempt(env, 'race-run', 'conv', second.generationId, second.handoffEpoch)).toBe(2);

    expect(await claimDurableAiRun(
      env, 'race-run', 'conv', 'message-race', first.generationId, first.handoffEpoch
    )).toBe(false);

    expect(await saveGeneratedAiResult(
      env, 'race-run', 'conv', first.generationId, first.handoffEpoch, 'old-response', 'old text'
    )).toBe(false);
    expect(await discardOwnedStaleAiRun(env, 'race-run', first.generationId)).toBe(false);
    expect(await getDurableAiRun(env, 'race-run')).toMatchObject({
      status: 'PENDING', generation_id: second.generationId, attempt_count: 2
    });
    db.close();
  });

  it('persists transport failures as FAILED_RETRYABLE', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private transport detail'));

    await expect(processAiTrigger(event(), makeEnv(db))).rejects.toMatchObject({
      code: 'AI_TRANSPORT_ERROR'
    });
    expect(await loadRun(db)).toMatchObject({
      status: 'FAILED_RETRYABLE', last_error: 'AI_TRANSPORT_ERROR', attempt_count: 1
    });
    db.close();
  });

  it('marks an expired late result as DISCARDED_STALE only while it still owns the run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const lease = await acquireGenerationLease(env, 'conv', 'message-stale');
    if (!lease.success) throw new Error('lease failed');
    expect(await claimDurableAiRun(
      env, 'stale-owned', 'conv', 'message-stale', lease.generationId, lease.handoffEpoch
    )).toBe(true);
    expect(await startAiGenerationAttempt(
      env, 'stale-owned', 'conv', lease.generationId, lease.handoffEpoch
    )).toBe(1);
    vi.advanceTimersByTime(61_000);

    expect(await saveGeneratedAiResult(
      env, 'stale-owned', 'conv', lease.generationId, lease.handoffEpoch, 'late-response', 'late text'
    )).toBe(false);
    expect(await discardOwnedStaleAiRun(env, 'stale-owned', lease.generationId)).toBe(true);
    expect(await getDurableAiRun(env, 'stale-owned')).toMatchObject({
      status: 'DISCARDED_STALE', attempt_count: 1
    });
    db.close();
  });

  it('operator before generation cancels the run and performs no provider call', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv(db, {
      hooks: { beforeGenerationLeaseClaim: async innerEnv => pauseOperator(innerEnv, 'conv') }
    } as Partial<Env>);

    await processAiTrigger(event(), env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRun(db)).toMatchObject({ status: 'CANCELLED_BY_HANDOFF', attempt_count: 0 });
    db.close();
  });

  it('operator after durable claim but before attempt-start CAS cancels with zero provider calls', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv(db, {
      hooks: { beforeAiContextBuild: async innerEnv => pauseOperator(innerEnv, 'conv') }
    } as Partial<Env>);

    await processAiTrigger(event(), env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRun(db)).toMatchObject({ status: 'CANCELLED_BY_HANDOFF', attempt_count: 0 });
    db.close();
  });

  it('keeps a pre-provider expired PENDING run reclaimable instead of discarding it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let expireOnce = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        return new Response(JSON.stringify({
          id: 'reclaimed-response', choices: [{ message: { content: 'Reclaimed' } }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 100 }), { status: 200 });
    });
    const env = makeEnv(db, {
      hooks: {
        beforeAiContextBuild: async () => {
          if (expireOnce) {
            expireOnce = false;
            vi.advanceTimersByTime(61_000);
          }
        }
      }
    } as Partial<Env>);

    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({
      code: 'CONCURRENCY_CAS_CONFLICT'
    });
    expect(await loadRun(db)).toMatchObject({ status: 'PENDING', attempt_count: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    await processAiTrigger(event(), env);
    expect(await loadRun(db)).toMatchObject({ status: 'SUCCESS', attempt_count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    db.close();
  });

  it('operator during generation cancels the owned run and prevents delivery', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let aiStarted = false;
    let chatwootCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        aiStarted = true;
        await gate;
        return new Response(JSON.stringify({
          id: 'late-response', choices: [{ message: { content: 'Late' } }]
        }), { status: 200 });
      }
      chatwootCalls += 1;
      return new Response(JSON.stringify({ id: 100 }), { status: 200 });
    });
    const env = makeEnv(db);
    const processing = processAiTrigger(event(), env);
    while (!aiStarted) await new Promise(resolve => setTimeout(resolve, 1));
    await pauseOperator(env, 'conv');
    release();
    await processing;

    expect(await loadRun(db)).toMatchObject({ status: 'CANCELLED_BY_HANDOFF', attempt_count: 1 });
    expect(chatwootCalls).toBe(0);
    db.close();
  });

  it('operator during a failing generation records cancellation instead of retryable failure', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let aiStarted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (!String(url).includes('ai.example')) throw new Error('unexpected visible send');
      aiStarted = true;
      await gate;
      return new Response('', { status: 503 });
    });
    const env = makeEnv(db);
    const processing = processAiTrigger(event(), env);
    while (!aiStarted) await new Promise(resolve => setTimeout(resolve, 1));
    await pauseOperator(env, 'conv');
    release();
    await processing;

    expect(await loadRun(db)).toMatchObject({ status: 'CANCELLED_BY_HANDOFF', attempt_count: 1 });
    db.close();
  });

  it('a provider failure returned after lease expiry is discarded as stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vi.advanceTimersByTime(61_000);
      return new Response('', { status: 503 });
    });

    await processAiTrigger(event(), makeEnv(db));

    expect(await loadRun(db)).toMatchObject({ status: 'DISCARDED_STALE', attempt_count: 1 });
    db.close();
  });

  it('does not corrupt a previously delivered SUCCESS after a later pause and duplicate trigger', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    let aiCalls = 0;
    let chatwootCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('ai.example')) {
        aiCalls += 1;
        return new Response(JSON.stringify({
          id: 'durable-response', choices: [{ message: { content: 'Delivered' } }]
        }), { status: 200 });
      }
      chatwootCalls += 1;
      return new Response(JSON.stringify({ id: 101 }), { status: 200 });
    });
    const env = makeEnv(db);

    await processAiTrigger(event(), env);
    await pauseOperator(env, 'conv');
    await processAiTrigger(event(), env);

    expect(await loadRun(db)).toMatchObject({ status: 'SUCCESS', response_text: 'Delivered' });
    expect(aiCalls).toBe(1);
    expect(chatwootCalls).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('cancels an old-epoch retryable run before lease acquisition after AI is turned off then on', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `INSERT INTO ai_runs
       (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
        status, attempt_count, next_retry_at, last_error, created_at, updated_at)
       VALUES ('old-epoch-retry', 'conv', 'message-old-epoch-retry', 'generation-old', 0,
               'FAILED_RETRYABLE', 1, 0, 'AI_PROVIDER_5XX', 1, 1)`
    ).run();
    await db.prepare(
      `UPDATE conversations
       SET ai_mode = 'PAUSED_MANUAL', ai_handoff_epoch = 1,
           ai_generation_id = NULL, ai_generation_started_at = NULL, ai_generation_message_id = NULL
       WHERE id = 'conv'`
    ).run();
    await db.prepare("UPDATE conversations SET ai_mode = 'ENABLED' WHERE id = 'conv'").run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await processAiTrigger(event('old-epoch-retry'), makeEnv(db));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRun(db, 'old-epoch-retry')).toMatchObject({
      status: 'CANCELLED_BY_HANDOFF',
      handoff_epoch: 0,
      attempt_count: 1
    });
    expect((await db.prepare('SELECT ai_generation_id FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).ai_generation_id).toBeNull();
    db.close();
  });

  it('atomically refuses to rebind a retryable run when handoff advances after the initial read', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `INSERT INTO ai_runs
       (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
        status, attempt_count, next_retry_at, last_error, created_at, updated_at)
       VALUES ('epoch-race', 'conv', 'message-epoch-race', 'generation-old', 0,
               'FAILED_RETRYABLE', 1, 0, 'AI_PROVIDER_5XX', 1, 1)`
    ).run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv(db, {
      hooks: {
        beforeAiLeaseAcquire: async innerEnv => {
          await innerEnv.DB.prepare(
            `UPDATE conversations
             SET ai_mode = 'ENABLED', ai_handoff_epoch = ai_handoff_epoch + 1,
                 ai_generation_id = NULL, ai_generation_started_at = NULL,
                 ai_generation_message_id = NULL
             WHERE id = 'conv'`
          ).run();
        }
      }
    });

    await processAiTrigger(event('epoch-race'), env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRun(db, 'epoch-race')).toMatchObject({
      status: 'CANCELLED_BY_HANDOFF', handoff_epoch: 0, attempt_count: 1
    });
    expect((await db.prepare('SELECT ai_handoff_epoch, ai_generation_id FROM conversations WHERE id = ?')
      .bind('conv').first<any>())).toMatchObject({ ai_handoff_epoch: 1, ai_generation_id: null });
    db.close();
  });

  it('preserves an old-epoch durable SUCCESS without regeneration or revived delivery', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `INSERT INTO ai_runs
       (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
        provider_response_ref, response_text, status, attempt_count, created_at, updated_at)
       VALUES ('old-epoch-success', 'conv', 'message-old-epoch-success', 'generation-old', 0,
               'response-old', 'Historical answer', 'SUCCESS', 1, 1, 1)`
    ).run();
    await db.prepare("UPDATE conversations SET ai_handoff_epoch = 1, ai_mode = 'ENABLED' WHERE id = 'conv'").run();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await processAiTrigger(event('old-epoch-success'), makeEnv(db));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadRun(db, 'old-epoch-success')).toMatchObject({
      status: 'SUCCESS',
      handoff_epoch: 0,
      response_text: 'Historical answer'
    });
    expect((await db.prepare('SELECT COUNT(*) AS c FROM outbound_operations').first<any>()).c).toBe(0);
    db.close();
  });
});

describe('legacy FAILED normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function normalize(error: string | null, attempts = 0) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `INSERT INTO ai_runs
       (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
        status, attempt_count, next_retry_at, last_error, created_at, updated_at)
       VALUES ('legacy', 'conv', 'message-legacy', 'generation-legacy', 0,
               'FAILED', ?, NULL, ?, 1, 1)`
    ).bind(attempts, error).run();
    const before = await getDurableAiRun(makeEnv(db), 'legacy');
    if (!before) throw new Error('missing legacy run');
    const result = await normalizeLegacyAiRun(makeEnv(db), before);
    return { db, result };
  }

  it('normalizes retryable legacy failures with at least one consumed attempt and fallback delay', async () => {
    const { db, result } = await normalize('AI_RATE_LIMITED');
    expect(result).toMatchObject({
      status: 'FAILED_RETRYABLE', attempt_count: 1,
      next_retry_at: Math.floor(NOW / 1000) + 5, last_error: 'AI_RATE_LIMITED'
    });
    db.close();
  });

  it('normalizes final and unknown legacy failures fail closed', async () => {
    const providerFinal = await normalize('AI_PROVIDER_4XX');
    expect(providerFinal.result).toMatchObject({ status: 'FAILED_FINAL', attempt_count: 1, last_error: 'AI_PROVIDER_4XX' });
    providerFinal.db.close();

    const unknown = await normalize('private legacy exception');
    expect(unknown.result).toMatchObject({
      status: 'FAILED_FINAL', attempt_count: 1, last_error: 'AI_LEGACY_FAILURE_UNCLASSIFIED'
    });
    unknown.db.close();
  });

  it('normalizes an exhausted retryable legacy failure without another attempt', async () => {
    const { db, result } = await normalize('AI_TIMEOUT', 3);
    expect(result).toMatchObject({
      status: 'RETRY_EXHAUSTED', attempt_count: 3,
      next_retry_at: null, last_error: 'AI_RETRY_EXHAUSTED'
    });
    db.close();
  });
});
