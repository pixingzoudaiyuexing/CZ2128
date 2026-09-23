import { afterEach, describe, expect, it, vi } from 'vitest';
import { crispFingerprintForOperation } from '../src/adapters/crisp/fingerprint';
import { Env } from '../src/config/env';
import { pauseOperator } from '../src/core/ai-state';
import { getDlqAiRedriveEligibility } from '../src/core/dlq-ai-redrive';
import { buildCrispTargetEvidence, serializeTargetEvidence } from '../src/core/outbound-evidence';
import { processAiTrigger } from '../src/queue/ai-handler';
import { SqliteD1 } from './helpers/sqlite-d1';

const NOW = Date.parse('2026-09-23T03:00:00Z');
const CONVERSATION_ID = 'crisp-ai-conv';
const MESSAGE_REF = 'crisp-customer-1';
const EVENT_ID = `ai_trigger:${CONVERSATION_ID}:${MESSAGE_REF}`;

function event(messageRef = MESSAGE_REF) {
  return {
    version: 1 as const,
    source: 'internal' as const,
    type: 'ai_trigger' as const,
    eventId: `ai_trigger:${CONVERSATION_ID}:${messageRef}`,
    payload: { convId: CONVERSATION_ID, messageId: messageRef }
  };
}

function makeEnv(db: SqliteD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CHATWOOT_WEBHOOK_SECRET: 'chatwoot-webhook',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    CHATWOOT_API_URL: 'https://chat.example',
    CRISP_WEBHOOK_SECRET: 'crisp-webhook',
    CRISP_API_IDENTIFIER: 'crisp-identifier',
    CRISP_API_KEY: 'crisp-key',
    CRISP_WEBSITE_ID: 'website-1',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    ATTACHMENTS_BUCKET: {} as any,
    DLQ_QUARANTINE: {} as any,
    AI_BASE_URL: 'https://ai.example/v1',
    AI_API_KEY: 'ai-key',
    AI_MODEL: 'model',
    AI_SYSTEM_PROMPT: 'System policy',
    AI_GENERATION_LEASE_SECONDS: '60',
    ...overrides
  } as Env;
}

async function seedCrispConversation(
  db: SqliteD1,
  messageRef = MESSAGE_REF,
  text = 'Please help me'
): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, created_at, updated_at, version)
     VALUES (?, 'crisp', 'website-1', 'session-1', 'visitor-1', 'telegram', '77', 1, 1, 1)`
  ).bind(CONVERSATION_ID).run();
  await db.prepare(
    `INSERT INTO messages
     (id, conversation_id, provider, provider_message_ref, direction, actor_role,
      message_type, text_content, created_at)
     VALUES (?, ?, 'crisp', ?, 'INBOUND', 'CUSTOMER', 'TEXT', ?, 2)`
  ).bind(`message-${messageRef}`, CONVERSATION_ID, messageRef, text).run();
}

describe('Crisp AI durable delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends one durable AI reply to Crisp with numeric fingerprint and mirrors it to Telegram', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    const requests: Array<{ url: string; body: any }> = [];
    let aiCalls = 0;
    let crispCalls = 0;
    let telegramCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.startsWith('https://ai.example')) {
        aiCalls += 1;
        return new Response(JSON.stringify({
          id: 'ai-response-1',
          choices: [{ message: { content: 'AI answer' } }]
        }), { status: 200 });
      }
      if (url.startsWith('https://api.crisp.chat')) {
        crispCalls += 1;
        return new Response(JSON.stringify({ data: { fingerprint: body.fingerprint } }), { status: 202 });
      }
      if (url.includes('api.telegram.org')) {
        telegramCalls += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const env = makeEnv(db);
    await processAiTrigger(event(), env);
    await processAiTrigger(event(), env);

    expect(aiCalls).toBe(1);
    expect(crispCalls).toBe(1);
    expect(telegramCalls).toBe(1);

    const operationId = `ai_reply:${EVENT_ID}`;
    const expectedFingerprint = await crispFingerprintForOperation(operationId);
    const crispRequest = requests.find(request => request.url.startsWith('https://api.crisp.chat'));
    expect(crispRequest?.body).toMatchObject({
      type: 'text',
      from: 'operator',
      origin: 'chat',
      content: 'AI answer',
      automated: true,
      fingerprint: expectedFingerprint
    });
    expect(crispRequest?.body).not.toHaveProperty('properties');

    expect(await db.prepare('SELECT * FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).toMatchObject({
      status: 'SUCCESS',
      provider_response_ref: 'ai-response-1',
      response_text: 'AI answer',
      attempt_count: 1
    });
    expect(await db.prepare('SELECT * FROM outbound_operations WHERE id = ?')
      .bind(operationId).first<any>()).toMatchObject({
      destination_provider: 'crisp',
      status: 'SENT',
      provider_message_ref: String(expectedFingerprint),
      attempt_count: 1,
      subject_type: 'AI_RUN',
      subject_ref: EVENT_ID
    });
    const evidence = JSON.parse((await db.prepare('SELECT target_evidence_json FROM outbound_operations WHERE id = ?')
      .bind(operationId).first<any>()).target_evidence_json);
    expect(evidence).toEqual({
      version: 1,
      provider: 'crisp',
      websiteRef: 'website-1',
      sessionRef: 'session-1',
      apiBase: 'https://api.crisp.chat/v1'
    });
    expect(await db.prepare(
      "SELECT provider, provider_message_ref, actor_role, text_content FROM messages WHERE conversation_id = ? AND actor_role = 'AI'"
    ).bind(CONVERSATION_ID).first<any>()).toMatchObject({
      provider: 'ai',
      provider_message_ref: 'ai-response-1',
      actor_role: 'AI',
      text_content: 'AI answer'
    });
    expect(await db.prepare('SELECT status FROM outbound_operations WHERE id = ?')
      .bind(`ai_tg_mirror:${EVENT_ID}`).first<any>()).toMatchObject({ status: 'SENT' });
    db.close();
  });

  it('reuses durable SUCCESS after a retryable Crisp delivery failure without regenerating AI content', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    let aiCalls = 0;
    let crispCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://ai.example')) {
        aiCalls += 1;
        return new Response(JSON.stringify({
          id: 'ai-response-reuse',
          choices: [{ message: { content: 'Stable answer' } }]
        }), { status: 200 });
      }
      if (url.startsWith('https://api.crisp.chat')) {
        crispCalls += 1;
        if (crispCalls === 1) {
          return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
        }
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: { fingerprint: body.fingerprint } }), { status: 202 });
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9002 } }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const env = makeEnv(db);
    await expect(processAiTrigger(event(), env)).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    expect(aiCalls).toBe(1);
    expect(crispCalls).toBe(1);
    expect(await db.prepare('SELECT status, response_text FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).toMatchObject({ status: 'SUCCESS', response_text: 'Stable answer' });
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).toMatchObject({
      status: 'FAILED_RETRYABLE',
      last_error: 'OUTBOUND_RATE_LIMITED'
    });

    vi.advanceTimersByTime(5_000);
    await processAiTrigger(event(), env);

    expect(aiCalls).toBe(1);
    expect(crispCalls).toBe(2);
    expect(await db.prepare('SELECT status, attempt_count FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).toMatchObject({ status: 'SENT', attempt_count: 2 });
    db.close();
  });

  it('recognizes a durable Crisp AI SUCCESS with due outbound recovery evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    const nowSeconds = Math.floor(NOW / 1000);
    await db.prepare(
      `INSERT INTO event_receipts
       (source, source_event_ref, status, attempt_count, lease_until, claim_token,
        event_type, conversation_id, last_attempt_at, dead_lettered_at)
       VALUES ('internal', ?, 'FAILED', 3, NULL, NULL, 'ai_trigger', ?, ?, ?)`
    ).bind(EVENT_ID, CONVERSATION_ID, nowSeconds - 10, nowSeconds - 10).run();
    await db.prepare(
      `INSERT INTO ai_runs
       (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
        provider_response_ref, response_text, status, attempt_count, next_retry_at, last_error,
        created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, 'ai-response-recover', 'Reusable answer', 'SUCCESS', 1, NULL, NULL, ?, ?)`
    ).bind(EVENT_ID, CONVERSATION_ID, MESSAGE_REF, nowSeconds - 20, nowSeconds - 20).run();
    await db.prepare(
      `INSERT INTO dlq_receipts
       (id, queue_name, event_source, source_event_ref, event_type, conversation_id,
        safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
       VALUES ('dlq:crisp-ai-recovery', 'cz2128-dlq', 'internal', ?, 'ai_trigger', ?,
               'QUEUE_RETRY_EXHAUSTED', 'OPEN', 1, ?, ?)`
    ).bind(EVENT_ID, CONVERSATION_ID, nowSeconds - 10, nowSeconds - 10).run();
    const targetEvidence = serializeTargetEvidence(buildCrispTargetEvidence('website-1', 'session-1'));
    await db.prepare(
      `INSERT INTO outbound_operations
       (id, conversation_id, destination_provider, operation_type, status, provider_message_ref,
        attempt_count, lease_until, lease_token, last_error, created_at, updated_at,
        request_started_at, response_observed_at, response_http_status, retry_after_seconds,
        next_retry_at, reconciliation_status, subject_type, subject_ref, target_evidence_json)
       VALUES (?, ?, 'crisp', 'SEND_MESSAGE', 'FAILED_RETRYABLE', NULL, 1, NULL, NULL,
               'OUTBOUND_RATE_LIMITED', ?, ?, ?, ?, 429, 5, ?, 'NOT_REQUIRED', 'AI_RUN', ?, ?)`
    ).bind(
      `ai_reply:${EVENT_ID}`,
      CONVERSATION_ID,
      nowSeconds - 10,
      nowSeconds - 10,
      nowSeconds - 10,
      nowSeconds - 10,
      nowSeconds - 1,
      EVENT_ID,
      targetEvidence
    ).run();

    expect(await getDlqAiRedriveEligibility(
      makeEnv(db),
      'dlq:crisp-ai-recovery',
      nowSeconds
    )).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
      aiRunStatus: 'SUCCESS',
      event: event()
    });
    db.close();
  });

  it('preserves the Crisp customer bridge and AI state when the AI provider fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    let crispCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://ai.example')) {
        return new Response('upstream unavailable', { status: 503 });
      }
      if (url.startsWith('https://api.crisp.chat')) {
        crispCalls += 1;
        return new Response('{}', { status: 202 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(processAiTrigger(event(), makeEnv(db))).rejects.toMatchObject({ code: 'AI_PROVIDER_5XX' });

    expect(crispCalls).toBe(0);
    expect(await db.prepare('SELECT ai_mode, ai_handoff_epoch FROM conversations WHERE id = ?')
      .bind(CONVERSATION_ID).first<any>()).toMatchObject({
      ai_mode: 'ENABLED',
      ai_handoff_epoch: 0
    });
    expect(await db.prepare(
      "SELECT provider, direction, actor_role, text_content FROM messages WHERE conversation_id = ? AND provider_message_ref = ?"
    ).bind(CONVERSATION_ID, MESSAGE_REF).first<any>()).toMatchObject({
      provider: 'crisp',
      direction: 'INBOUND',
      actor_role: 'CUSTOMER',
      text_content: 'Please help me'
    });
    expect(await db.prepare('SELECT status, attempt_count, last_error FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).toMatchObject({
      status: 'FAILED_RETRYABLE',
      attempt_count: 1,
      last_error: 'AI_PROVIDER_5XX'
    });
    expect(await db.prepare('SELECT status, attempt_count FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).toMatchObject({
      status: 'PENDING',
      attempt_count: 0
    });
    db.close();
  });

  it('cancels a Crisp AI generation when a human takes over before the generated text can be sent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let aiStarted = false;
    let crispCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://ai.example')) {
        aiStarted = true;
        await gate;
        return new Response(JSON.stringify({
          id: 'ai-response-late',
          choices: [{ message: { content: 'Too late' } }]
        }), { status: 200 });
      }
      if (url.startsWith('https://api.crisp.chat')) {
        crispCalls += 1;
        return new Response('{}', { status: 202 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const env = makeEnv(db);
    const processing = processAiTrigger(event(), env);
    while (!aiStarted) await new Promise(resolve => setTimeout(resolve, 1));
    await pauseOperator(env, CONVERSATION_ID);
    release();
    await processing;

    expect(crispCalls).toBe(0);
    expect(await db.prepare('SELECT ai_mode, ai_handoff_epoch FROM conversations WHERE id = ?')
      .bind(CONVERSATION_ID).first<any>()).toMatchObject({
      ai_mode: 'PAUSED_OPERATOR',
      ai_handoff_epoch: 1
    });
    expect(await db.prepare('SELECT status FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).toMatchObject({ status: 'CANCELLED_BY_HANDOFF' });
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'CANCELLED_BY_HANDOFF'
    });
    db.close();
  });

  it('cancels a durable Crisp AI SUCCESS when handoff happens immediately before visible delivery', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    let crispCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://ai.example')) {
        return new Response(JSON.stringify({
          id: 'ai-response-preflight-handoff',
          choices: [{ message: { content: 'Generated but fenced' } }]
        }), { status: 200 });
      }
      if (url.startsWith('https://api.crisp.chat')) {
        crispCalls += 1;
        return new Response('{}', { status: 202 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const env = makeEnv(db, {
      hooks: {
        beforeAiDispatchPreflight: async innerEnv => {
          await pauseOperator(innerEnv, CONVERSATION_ID);
        }
      }
    } as Partial<Env>);

    await processAiTrigger(event(), env);

    expect(crispCalls).toBe(0);
    expect(await db.prepare('SELECT status, provider_response_ref, response_text FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).toMatchObject({
      status: 'CANCELLED_BY_HANDOFF',
      provider_response_ref: 'ai-response-preflight-handoff',
      response_text: 'Generated but fenced'
    });
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'CANCELLED_BY_HANDOFF'
    });
    db.close();
  });

  it('fails closed before a Crisp send if the durable conversation target changes after generation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedCrispConversation(db);
    let crispCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith('https://ai.example')) {
        return new Response(JSON.stringify({
          id: 'ai-response-drift',
          choices: [{ message: { content: 'Do not misroute' } }]
        }), { status: 200 });
      }
      if (url.startsWith('https://api.crisp.chat')) {
        crispCalls += 1;
        return new Response('{}', { status: 202 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const env = makeEnv(db, {
      hooks: {
        beforeAiDispatchPreflight: async innerEnv => {
          await innerEnv.DB.prepare(
            'UPDATE conversations SET helpdesk_conversation_ref = ? WHERE id = ?'
          ).bind('session-drifted', CONVERSATION_ID).run();
        }
      }
    } as Partial<Env>);

    await processAiTrigger(event(), env);

    expect(crispCalls).toBe(0);
    expect(await db.prepare('SELECT status FROM ai_runs WHERE trigger_event_ref = ?')
      .bind(EVENT_ID).first<any>()).toMatchObject({ status: 'SUCCESS' });
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE id = ?')
      .bind(`ai_reply:${EVENT_ID}`).first<any>()).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'TARGET_IDENTITY_CHANGED'
    });
    db.close();
  });
});
