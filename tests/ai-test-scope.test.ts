import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAiTestScope, isAiConversationAllowed } from '../src/config/ai-test-scope';
import { Env } from '../src/config/env';
import { cancelDurableAiRunForScope } from '../src/core/ai-state';
import { getDlqAiRedriveEligibility, requestDlqAiRedrive } from '../src/core/dlq-ai-redrive';
import { buildChatwootTargetEvidence } from '../src/core/outbound-evidence';
import { prepareOutboundOperation } from '../src/core/outbound-operations';
import { processAiTrigger } from '../src/queue/ai-handler';
import { processChatwootEvent } from '../src/queue/chatwoot-handler';
import { handleQueueEvent } from '../src/queue/consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

const CONVERSATION_A = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_B = '22222222-2222-4222-8222-222222222222';

function makeEnv(db: SqliteD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CHATWOOT_WEBHOOK_SECRET: 'webhook-secret',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    CHATWOOT_API_URL: 'https://chat.example/api/v1',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    AI_BASE_URL: 'https://ai.example/v1',
    AI_API_KEY: 'ai-key',
    AI_MODEL: 'model',
    AI_SYSTEM_PROMPT: 'System policy',
    AI_GENERATION_LEASE_SECONDS: '60',
    AI_TEST_SCOPE_ENABLED: 'true',
    AI_TEST_ALLOWED_CONVERSATION_IDS: JSON.stringify([CONVERSATION_A]),
    ...overrides
  } as Env;
}

async function seedConversation(
  db: SqliteD1,
  id: string,
  options: { mode?: 'ENABLED' | 'PAUSED_OPERATOR'; lastOperatorReplyAt?: number | null } = {}
): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, ai_mode, last_operator_reply_at,
      created_at, updated_at, version)
     VALUES (?, 'chatwoot', 'account-1', ?, 'customer-1', 'telegram', '77', ?, ?, 1, 1, 1)`
  ).bind(
    id,
    `conversation-${id}`,
    options.mode || 'ENABLED',
    options.lastOperatorReplyAt ?? null
  ).run();
}

async function seedCustomerMessage(db: SqliteD1, conversationId: string, messageRef: string): Promise<void> {
  await db.prepare(
    `INSERT INTO messages
     (id, conversation_id, provider, provider_message_ref, direction, actor_role,
      message_type, text_content, created_at)
     VALUES (?, ?, 'chatwoot', ?, 'INBOUND', 'CUSTOMER', 'TEXT', 'Synthetic customer text', 100)`
  ).bind(`row-${messageRef}`, conversationId, messageRef).run();
}

function event(conversationId: string, messageRef = 'message-1') {
  return {
    version: 1 as const,
    source: 'internal' as const,
    type: 'ai_trigger' as const,
    eventId: `ai_trigger:${conversationId}:${messageRef}`,
    payload: { convId: conversationId, messageId: messageRef }
  };
}

function installProviderMocks() {
  const calls = { ai: 0, chatwoot: 0, telegram: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url.startsWith('https://ai.example/')) {
      calls.ai += 1;
      return new Response(JSON.stringify({
        id: `ai-response-${calls.ai}`,
        choices: [{ message: { content: 'Synthetic AI response' } }]
      }), { status: 200 });
    }
    if (url.startsWith('https://chat.example/')) {
      calls.chatwoot += 1;
      return new Response(JSON.stringify({ id: `chatwoot-${calls.chatwoot}` }), { status: 200 });
    }
    if (url.startsWith('https://api.telegram.org/')) {
      calls.telegram += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 100 + calls.telegram, message_thread_id: 77 }
      }), { status: 200 });
    }
    throw new Error(`Unexpected mock URL: ${url}`);
  });
  return calls;
}

async function seedAiRun(
  db: SqliteD1,
  conversationId: string,
  messageRef: string,
  status: 'FAILED_RETRYABLE' | 'SUCCESS'
): Promise<void> {
  const trigger = event(conversationId, messageRef).eventId;
  await db.prepare(
    `INSERT INTO ai_runs
     (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
      provider_response_ref, response_text, status, attempt_count, next_retry_at, last_error,
      created_at, updated_at)
     VALUES (?, ?, ?, 'generation-existing', 0, ?, ?, ?, 1, ?, ?, 1, 1)`
  ).bind(
    trigger,
    conversationId,
    messageRef,
    status === 'SUCCESS' ? 'provider-response' : null,
    status === 'SUCCESS' ? 'Durable synthetic AI response' : null,
    status,
    status === 'FAILED_RETRYABLE' ? 1 : null,
    status === 'FAILED_RETRYABLE' ? 'AI_PROVIDER_5XX' : null
  ).run();
}

async function prepareChatwootOperation(env: Env, conversationId: string, messageRef: string) {
  const eventId = event(conversationId, messageRef).eventId;
  const operationId = `ai_reply:${eventId}`;
  return prepareOutboundOperation(env, conversationId, 'chatwoot', 'SEND_MESSAGE', operationId, {
    subject: { type: 'AI_RUN', ref: eventId },
    targetEvidence: await buildChatwootTargetEvidence(
      env,
      'account-1',
      `conversation-${conversationId}`,
      operationId
    )
  });
}

describe('AI staging test scope parser', () => {
  it('preserves existing behavior only when the deployment switch is absent or explicitly false', () => {
    expect(getAiTestScope({}).mode).toBe('OFF');
    expect(getAiTestScope({ AI_TEST_SCOPE_ENABLED: 'false' }).mode).toBe('OFF');
    expect(isAiConversationAllowed({}, CONVERSATION_B)).toBe(true);
  });

  it.each([
    [{ AI_TEST_SCOPE_ENABLED: 'true' }, 'ALLOWLIST_MISSING_OR_TOO_LARGE'],
    [{ AI_TEST_SCOPE_ENABLED: 'true', AI_TEST_ALLOWED_CONVERSATION_IDS: '[]' }, 'ALLOWLIST_INVALID_SIZE'],
    [{ AI_TEST_SCOPE_ENABLED: 'true', AI_TEST_ALLOWED_CONVERSATION_IDS: 'not-json' }, 'ALLOWLIST_INVALID_JSON'],
    [{ AI_TEST_SCOPE_ENABLED: 'true', AI_TEST_ALLOWED_CONVERSATION_IDS: '["conversation-1"]' }, 'ALLOWLIST_INVALID_CONVERSATION_ID'],
    [{ AI_TEST_SCOPE_ENABLED: 'TRUE', AI_TEST_ALLOWED_CONVERSATION_IDS: JSON.stringify([CONVERSATION_A]) }, 'INVALID_ENABLE_FLAG'],
    [{ AI_TEST_SCOPE_ENABLED: ' true ', AI_TEST_ALLOWED_CONVERSATION_IDS: JSON.stringify([CONVERSATION_A]) }, 'INVALID_ENABLE_FLAG']
  ])('fails closed for invalid configuration %#', (configuration, reason) => {
    expect(getAiTestScope(configuration)).toMatchObject({ mode: 'INVALID', reason });
    expect(isAiConversationAllowed(configuration, CONVERSATION_A)).toBe(false);
  });

  it('uses exact internal conversation UUID membership', () => {
    const env = {
      AI_TEST_SCOPE_ENABLED: 'true',
      AI_TEST_ALLOWED_CONVERSATION_IDS: JSON.stringify([CONVERSATION_A])
    };
    expect(isAiConversationAllowed(env, CONVERSATION_A)).toBe(true);
    expect(isAiConversationAllowed(env, CONVERSATION_B)).toBe(false);
  });
});

describe('AI staging test scope execution gates', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows the exact allowlisted conversation through generation and both visible sends', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_A);
    await seedCustomerMessage(db, CONVERSATION_A, 'message-a');
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_A, 'message-a'), makeEnv(db));

    expect(calls).toEqual({ ai: 1, chatwoot: 1, telegram: 1 });
    expect(await db.prepare('SELECT status FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_A).first<any>()).toMatchObject({ status: 'SUCCESS' });
    db.close();
  });

  it('suppresses ingress and all AI side effects for an enabled conversation outside the allowlist', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    await seedCustomerMessage(db, CONVERSATION_B, 'message-b');
    const env = makeEnv(db);
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_B, 'message-b'), env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT * FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_B).first()).toBeNull();
    expect(await db.prepare("SELECT * FROM outbound_operations WHERE subject_type = 'AI_RUN' AND conversation_id = ?")
      .bind(CONVERSATION_B).first()).toBeNull();
    db.close();
  });

  it('fails closed at execution time when enabled scope has no allowlist', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_A);
    await seedCustomerMessage(db, CONVERSATION_A, 'message-invalid-scope');
    const calls = installProviderMocks();
    const env = makeEnv(db, { AI_TEST_ALLOWED_CONVERSATION_IDS: undefined });

    await processAiTrigger(event(CONVERSATION_A, 'message-invalid-scope'), env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT * FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_A).first()).toBeNull();
    db.close();
  });

  it('does not let duplicate Queue delivery bypass the scope gate', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    await seedCustomerMessage(db, CONVERSATION_B, 'message-queue-retry');
    const calls = installProviderMocks();
    const env = makeEnv(db);
    const queuedEvent = event(CONVERSATION_B, 'message-queue-retry');

    await handleQueueEvent(queuedEvent, env);
    await handleQueueEvent(queuedEvent, env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare(
      'SELECT status, attempt_count FROM event_receipts WHERE source = ? AND source_event_ref = ?'
    ).bind('internal', queuedEvent.eventId).first<any>()).toMatchObject({
      status: 'PROCESSED', attempt_count: 1
    });
    db.close();
  });

  it('does not let PAUSED_OPERATOR auto-resume bypass the allowlist', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B, { mode: 'PAUSED_OPERATOR', lastOperatorReplyAt: 1 });
    await seedCustomerMessage(db, CONVERSATION_B, 'message-paused');
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_B, 'message-paused'), makeEnv(db));

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT ai_mode FROM conversations WHERE id = ?')
      .bind(CONVERSATION_B).first<any>()).toMatchObject({ ai_mode: 'PAUSED_OPERATOR' });
    db.close();
  });

  it('keeps an allowlisted conversation provider-free when AI configuration is incomplete', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_A);
    await seedCustomerMessage(db, CONVERSATION_A, 'message-unconfigured');
    const calls = installProviderMocks();
    const env = makeEnv(db, { AI_BASE_URL: undefined, AI_API_KEY: undefined, AI_MODEL: undefined });

    await processAiTrigger(event(CONVERSATION_A, 'message-unconfigured'), env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT * FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_A).first()).toBeNull();
    db.close();
  });

  it('suppresses Chatwoot-created AI trigger enqueue outside the allowlist', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    const env = makeEnv(db);
    const calls = installProviderMocks();

    await processChatwootEvent({
      version: 1,
      source: 'chatwoot',
      type: 'message_created',
      eventId: 'chatwoot-customer-b',
      payload: {
        accountRef: 'account-1',
        conversationRef: `conversation-${CONVERSATION_B}`,
        customerRef: 'customer-1',
        customerName: 'Synthetic',
        messageRef: 'message-chatwoot-b',
        content: 'Synthetic customer text',
        actorRole: 'CUSTOMER'
      }
    }, env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 1 });
    expect(env.QUEUE.send).not.toHaveBeenCalled();
    db.close();
  });

  it('terminalizes a historical retry and its unstarted outbound without provider calls', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    await seedCustomerMessage(db, CONVERSATION_B, 'message-retry');
    await seedAiRun(db, CONVERSATION_B, 'message-retry', 'FAILED_RETRYABLE');
    const env = makeEnv(db);
    await prepareChatwootOperation(env, CONVERSATION_B, 'message-retry');
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_B, 'message-retry'), env);
    await processAiTrigger(event(CONVERSATION_B, 'message-retry'), env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT status, last_error, attempt_count FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_B).first<any>()).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'AI_SCOPE_DENIED', attempt_count: 1
    });
    expect(await db.prepare('SELECT status, last_error, attempt_count FROM outbound_operations WHERE conversation_id = ?')
      .bind(CONVERSATION_B).first<any>()).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'AI_SCOPE_DENIED', attempt_count: 0
    });
    db.close();
  });

  it('does not cancel a durable run after a newer generation owner wins the CAS race', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    await seedAiRun(db, CONVERSATION_B, 'message-owner-race', 'FAILED_RETRYABLE');
    let replaced = false;
    const racedDb = {
      prepare(query: string) {
        if (!replaced && query.includes("last_error = 'AI_SCOPE_DENIED'")) {
          replaced = true;
          db.database.prepare(
            `UPDATE ai_runs
             SET generation_id = 'generation-new-owner', status = 'PENDING', updated_at = 2
             WHERE trigger_event_ref = ?`
          ).run(event(CONVERSATION_B, 'message-owner-race').eventId);
        }
        return db.prepare(query);
      },
      batch: db.batch.bind(db)
    };

    expect(await cancelDurableAiRunForScope(
      { DB: racedDb } as unknown as Env,
      event(CONVERSATION_B, 'message-owner-race').eventId,
      CONVERSATION_B,
      'message-owner-race'
    )).toBe(false);
    expect(await db.prepare('SELECT generation_id, status, last_error FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_B).first<any>()).toMatchObject({
      generation_id: 'generation-new-owner',
      status: 'PENDING',
      last_error: 'AI_PROVIDER_5XX'
    });
    db.close();
  });

  it('blocks DLQ eligibility and enqueue outside the allowlist', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    const env = makeEnv(db);
    const eventId = event(CONVERSATION_B, 'message-dlq').eventId;
    await db.prepare(
      `INSERT INTO dlq_receipts
       (id, queue_name, event_source, source_event_ref, event_type, conversation_id,
        safe_error_code, status, delivery_count, first_seen_at, last_seen_at)
       VALUES ('scope-dlq', 'cz2128-dlq', 'internal', ?, 'ai_trigger', ?,
        'AI_PROVIDER_5XX', 'OPEN', 1, 1, 1)`
    ).bind(eventId, CONVERSATION_B).run();

    expect(await getDlqAiRedriveEligibility(env, 'scope-dlq')).toMatchObject({
      eligible: false, reason: 'AI_SCOPE_DENIED'
    });
    expect(await requestDlqAiRedrive(env, 'scope-dlq', '8236479240', '1')).toMatchObject({
      status: 'NOT_ELIGIBLE', eligibility: { reason: 'AI_SCOPE_DENIED' }
    });
    expect(env.QUEUE.send).not.toHaveBeenCalled();
    db.close();
  });

  it('preserves durable SUCCESS but cancels an unstarted Chatwoot visible operation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    await seedCustomerMessage(db, CONVERSATION_B, 'message-success-pending');
    await seedAiRun(db, CONVERSATION_B, 'message-success-pending', 'SUCCESS');
    const env = makeEnv(db);
    await prepareChatwootOperation(env, CONVERSATION_B, 'message-success-pending');
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_B, 'message-success-pending'), env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT status FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_B).first<any>()).toMatchObject({ status: 'SUCCESS' });
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE conversation_id = ?')
      .bind(CONVERSATION_B).first<any>()).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'AI_SCOPE_DENIED'
    });
    db.close();
  });

  it('cancels after generation but before Chatwoot send when scope is tightened', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_A);
    await seedCustomerMessage(db, CONVERSATION_A, 'message-scope-race');
    const env = makeEnv(db);
    env.hooks = {
      beforeAiDispatchPreflight: async innerEnv => {
        innerEnv.AI_TEST_ALLOWED_CONVERSATION_IDS = JSON.stringify([CONVERSATION_B]);
      }
    };
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_A, 'message-scope-race'), env);

    expect(calls).toEqual({ ai: 1, chatwoot: 0, telegram: 0 });
    expect(await db.prepare('SELECT status FROM ai_runs WHERE conversation_id = ?')
      .bind(CONVERSATION_A).first<any>()).toMatchObject({ status: 'SUCCESS' });
    expect(await db.prepare('SELECT status, last_error FROM outbound_operations WHERE conversation_id = ?')
      .bind(CONVERSATION_A).first<any>()).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'AI_SCOPE_DENIED'
    });
    db.close();
  });

  it('finishes only the deterministic Telegram mirror after Chatwoot is already SENT', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_A);
    await seedCustomerMessage(db, CONVERSATION_A, 'message-mirror-convergence');
    const env = makeEnv(db);
    env.hooks = {
      beforeAiTelegramDispatchPreflight: async innerEnv => {
        innerEnv.AI_TEST_ALLOWED_CONVERSATION_IDS = JSON.stringify([CONVERSATION_B]);
      }
    };
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_A, 'message-mirror-convergence'), env);

    expect(calls).toEqual({ ai: 1, chatwoot: 1, telegram: 1 });
    const operations = await db.prepare(
      "SELECT destination_provider, status FROM outbound_operations WHERE conversation_id = ? ORDER BY destination_provider"
    ).bind(CONVERSATION_A).all<any>();
    expect(operations.results).toEqual([
      { destination_provider: 'chatwoot', status: 'SENT' },
      { destination_provider: 'telegram', status: 'SENT' }
    ]);
    db.close();
  });

  it('resumes a pre-existing SENT Chatwoot result only to complete its Telegram mirror', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, CONVERSATION_B);
    await seedCustomerMessage(db, CONVERSATION_B, 'message-existing-sent');
    await seedAiRun(db, CONVERSATION_B, 'message-existing-sent', 'SUCCESS');
    const env = makeEnv(db);
    const operation = await prepareChatwootOperation(env, CONVERSATION_B, 'message-existing-sent');
    await db.prepare(
      `UPDATE outbound_operations
       SET status = 'SENT', provider_message_ref = 'chatwoot-existing', attempt_count = 1,
           request_started_at = 1, response_observed_at = 1, response_http_status = 200
       WHERE id = ?`
    ).bind(operation!.id).run();
    const calls = installProviderMocks();

    await processAiTrigger(event(CONVERSATION_B, 'message-existing-sent'), env);

    expect(calls).toEqual({ ai: 0, chatwoot: 0, telegram: 1 });
    expect(await db.prepare("SELECT status FROM outbound_operations WHERE destination_provider = 'telegram' AND conversation_id = ?")
      .bind(CONVERSATION_B).first<any>()).toMatchObject({ status: 'SENT' });
    db.close();
  });
});
