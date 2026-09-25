import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import { OutboundOperation } from '../src/core/domain';
import { buildChatwootTargetEvidence, buildCrispTargetEvidence, buildTelegramTargetEvidence } from '../src/core/outbound-evidence';
import { executeOutboundOperation } from '../src/core/outbound-operations';
import {
  manualRetryChildId,
  manualRetryOutboundOperation
} from '../src/core/outbound-manual-retry';
import { SqliteD1 } from './helpers/sqlite-d1';

function makeEnv(db: SqliteD1, bucketGet = vi.fn()): Env {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CHATWOOT_WEBHOOK_SECRET: 'webhook-secret',
    CHATWOOT_API_TOKEN: 'chatwoot-token',
    CHATWOOT_API_URL: 'https://chat.example/tenant-a',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    ATTACHMENTS_BUCKET: { get: bucketGet } as any,
    DLQ_QUARANTINE: {} as any
  };
}

async function seedConversation(
  db: SqliteD1,
  overrides: Partial<{ thread: string | null; status: 'OPEN' | 'CLOSED'; version: number }> = {}
): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
     VALUES ('conv', 'chatwoot', 'account-1', 'conversation-2', 'customer-3',
             'telegram', ?, ?, 1, 1, ?)`
  ).bind(overrides.thread === undefined ? '77' : overrides.thread, overrides.status || 'OPEN', overrides.version || 1).run();
}

async function seedParent(
  db: SqliteD1,
  evidence: object,
  overrides: Partial<{
    id: string;
    provider: string;
    operationType: string;
    subjectType: string;
    subjectRef: string;
    reconciliationStatus: string;
  }> = {}
): Promise<string> {
  const id = overrides.id || 'parent-op';
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, conversation_id, destination_provider, operation_type, status, attempt_count,
      request_started_at, reconciliation_status, subject_type, subject_ref, target_evidence_json,
      created_at, updated_at)
     VALUES (?, 'conv', ?, ?, 'AMBIGUOUS', 1, 1, ?, ?, ?, ?, 1, 1)`
  ).bind(
    id,
    overrides.provider || 'telegram',
    overrides.operationType || 'SEND_MESSAGE',
    overrides.reconciliationStatus || 'PENDING',
    overrides.subjectType || 'MESSAGE',
    overrides.subjectRef || 'chatwoot:cw-message-1',
    JSON.stringify(evidence)
  ).run();
  return id;
}

async function seedMessage(
  db: SqliteD1,
  provider: 'chatwoot' | 'telegram',
  providerRef: string,
  text: string,
  conversationId = 'conv'
): Promise<void> {
  await db.prepare(
    `INSERT INTO messages
     (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
     VALUES (?, ?, ?, ?, 'INBOUND', 'OPERATOR', 'TEXT', ?, 1)`
  ).bind(`message-${provider}-${providerRef}`, conversationId, provider, providerRef, text).run();
}

async function seedAiRun(
  db: SqliteD1,
  status: string = 'SUCCESS',
  responseText: string | null = 'AI answer',
  conversationId = 'conv'
): Promise<void> {
  await db.prepare(
    `INSERT INTO ai_runs
     (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
      provider_response_ref, response_text, status, attempt_count, created_at, updated_at)
     VALUES ('ai-run-1', ?, 'customer-message-1', 'generation-1', 0,
             'provider-response-1', ?, ?, 1, 1, 1)`
  ).bind(conversationId, responseText, status).run();
}

async function loadOperation(db: SqliteD1, id: string): Promise<OutboundOperation> {
  return (await db.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(id).first()) as OutboundOperation;
}

describe('manual retry child operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reconstructs exact Chatwoot text to Telegram and creates one deterministic child', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const parentEvidence = buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage');
    await seedParent(db, parentEvidence);
    const exactText = '  exact text\nwith spacing  ';
    await seedMessage(db, 'chatwoot', 'cw-message-1', exactText);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), { status: 200 })
    );

    const result = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const childId = await manualRetryChildId('parent-op');
    const parent = await loadOperation(db, 'parent-op');
    const child = await loadOperation(db, childId);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(result).toMatchObject({ childOperationId: childId, childStatus: 'SENT', created: true });
    expect(requestBody.text).toBe(exactText);
    expect(parent).toMatchObject({ status: 'AMBIGUOUS', reconciliation_status: 'MANUAL_RETRY_CREATED' });
    expect(child).toMatchObject({ parent_operation_id: 'parent-op', status: 'SENT', attempt_count: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'MANUAL_RETRY_CHILD_CREATED'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('reconstructs exact Telegram text to Chatwoot with the child source_id', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const parentEvidence = await buildChatwootTargetEvidence(
      env, 'account-1', 'conversation-2', 'parent-op'
    );
    await seedParent(db, parentEvidence, {
      provider: 'chatwoot', subjectRef: 'telegram:9:tg-message-4'
    });
    const exactText = '\noperator reply\n';
    await seedMessage(db, 'telegram', '9:tg-message-4', exactText);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 902 }), { status: 200 })
    );

    const result = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const childId = await manualRetryChildId('parent-op');
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(requestBody.content).toBe(exactText);
    expect(requestBody.source_id).toBe(`cz2128:${childId}`);
    expect(requestBody.source_id).not.toBe('cz2128:parent-op');
    expect(result.childOperationId).toBe(childId);
    db.close();
  });

  it('keeps a Telegram human identity non-automated when manually retrying to Crisp', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `UPDATE conversations
       SET helpdesk_provider = 'crisp', helpdesk_account_ref = 'website-1',
           helpdesk_conversation_ref = 'session-1'
       WHERE id = 'conv'`
    ).run();
    const env = {
      ...makeEnv(db),
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as Env;
    await seedParent(db, buildCrispTargetEvidence('website-1', 'session-1'), {
      provider: 'crisp',
      subjectRef: 'telegram:9:tg-message-5'
    });
    const frozenIdentity = JSON.stringify({
      version: 1,
      crispIdentity: {
        nickname: '人工客服',
        avatar: 'https://cdn.example/operator.png'
      }
    });
    await db.prepare(
      'UPDATE outbound_operations SET request_options_json = ? WHERE id = ?'
    ).bind(frozenIdentity, 'parent-op').run();
    await seedMessage(db, 'telegram', '9:tg-message-5', 'human retry');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { fingerprint: 903 } }), { status: 200 })
    );

    const result = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const childId = await manualRetryChildId('parent-op');
    const child = await loadOperation(db, childId);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(requestBody).toMatchObject({
      type: 'text',
      from: 'operator',
      content: 'human retry',
      automated: false,
      user: {
        nickname: '人工客服',
        avatar: 'https://cdn.example/operator.png'
      }
    });
    expect(child.request_options_json).toBe(frozenIdentity);
    expect(result).toMatchObject({ childOperationId: childId, childStatus: 'SENT' });
    db.close();
  });

  it.each([
    ['website', 'website-2', 'session-1'],
    ['session', 'website-1', 'session-2']
  ] as const)('blocks changed Crisp %s before manual-retry child creation', async (_label, website, session) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `UPDATE conversations
       SET helpdesk_provider = 'crisp', helpdesk_account_ref = ?,
           helpdesk_conversation_ref = ?
       WHERE id = 'conv'`
    ).bind(website, session).run();
    const env = {
      ...makeEnv(db),
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    } as Env;
    await seedParent(db, buildCrispTargetEvidence('website-1', 'session-1'), {
      provider: 'crisp',
      subjectRef: 'telegram:9:tg-message-6'
    });
    await seedMessage(db, 'telegram', '9:tg-message-6', 'human retry');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_TARGET_CHANGED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it.each([
    ['missing message', false, 'conv', 'telegram'],
    ['wrong conversation', true, 'other-conv', 'telegram'],
    ['wrong provider mapping', true, 'conv', 'chatwoot']
  ] as const)('%s creates no child and performs no provider action', async (_label, addMessage, conversationId, destination) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    if (conversationId === 'other-conv') {
      await db.prepare(
        `INSERT INTO conversations
         (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
          operator_channel, created_at, updated_at, version)
         VALUES ('other-conv', 'chatwoot', 'other', 'other', 'other', 'telegram', 1, 1, 1)`
      ).run();
    }
    const env = makeEnv(db);
    const evidence = buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage');
    await seedParent(db, evidence, { provider: destination });
    if (addMessage) await seedMessage(db, 'chatwoot', 'cw-message-1', 'private text', conversationId);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it.each([
    ['Chatwoot base path', 'https://chat.example/tenant-b', 'account-1', 'conversation-2'],
    ['Chatwoot account', 'https://chat.example/tenant-a', 'account-9', 'conversation-2'],
    ['Chatwoot conversation', 'https://chat.example/tenant-a', 'account-1', 'conversation-9']
  ] as const)('blocks changed %s before child creation', async (_label, apiUrl, account, conversation) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const evidence = await buildChatwootTargetEvidence(env, account, conversation, 'parent-op');
    await seedParent(db, evidence, { provider: 'chatwoot', subjectRef: 'telegram:1:2' });
    await seedMessage(db, 'telegram', '1:2', 'text');
    const changedEnv = { ...env, CHATWOOT_API_URL: apiUrl };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      changedEnv, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_TARGET_CHANGED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it.each([
    ['group', '-1002', '77', undefined],
    ['thread', '-1001', '78', undefined],
    ['profile generation', '-1001', '77', 8]
  ] as const)('blocks Telegram %s drift before child creation', async (_label, group, thread, profileVersion) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const storedEnv = profileVersion === undefined ? env : {
      ...env,
      runtimeConfigSnapshot: {
        sources: { TELEGRAM_SUPPORT_PROFILE: 'D1' },
        versions: { TELEGRAM_SUPPORT_PROFILE: 7 },
        errors: {}
      }
    } as Env;
    const evidence = buildTelegramTargetEvidence(storedEnv, '-1001', '77', 'sendMessage');
    await seedParent(db, evidence);
    await seedMessage(db, 'chatwoot', 'cw-message-1', 'text');
    const currentEnv = {
      ...env,
      BOT_GROUP_ID: group,
      runtimeConfigSnapshot: profileVersion === undefined ? undefined : {
        sources: { TELEGRAM_SUPPORT_PROFILE: 'D1' },
        versions: { TELEGRAM_SUPPORT_PROFILE: profileVersion },
        errors: {}
      }
    } as Env;
    if (thread !== '77') {
      await db.prepare("UPDATE conversations SET operator_thread_ref = ? WHERE id = 'conv'").bind(thread).run();
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      currentEnv, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_TARGET_CHANGED' });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('keeps an ambiguous Crisp attachment parent unchanged because its plaintext capability cannot be reconstructed', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      `UPDATE conversations
       SET helpdesk_provider = 'crisp', helpdesk_account_ref = 'website-1',
           helpdesk_conversation_ref = 'session-1'
       WHERE id = 'conv'`
    ).run();
    const env = makeEnv(db);
    const evidence = buildCrispTargetEvidence('website-1', 'session-1');
    await db.prepare(
      `INSERT INTO attachments
       (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
        attachment_type, original_filename, safe_filename, mime_type, size_bytes,
        storage_key, access_token_hash, status, destination_provider, attempt_count,
        expires_at, last_error, created_at, updated_at)
       VALUES ('att-crisp', 'conv', 'telegram', 'tg-msg', 'tg-att',
               'document', 'report.pdf', 'report.pdf', 'application/pdf', 10,
               'attachments/att-crisp', 'token-hash-only', 'FAILED_FINAL', 'crisp', 1,
               9999999999, 'ATTACHMENT_DELIVERY_AMBIGUOUS', 1, 1)`
    ).run();
    await seedParent(db, evidence, {
      provider: 'crisp', operationType: 'SEND_ATTACHMENT',
      subjectType: 'ATTACHMENT', subjectRef: 'att-crisp'
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 0 });
    expect((await loadOperation(db, 'parent-op'))).toMatchObject({
      status: 'AMBIGUOUS', reconciliation_status: 'PENDING'
    });
    db.close();
  });

  it('rejects CONTROL_ACK without consuming the parent decision', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'), {
      subjectType: 'CONTROL_ACK', subjectRef: 'CONTROL_ACK:1'
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await loadOperation(db, 'parent-op')).reconciliation_status).toBe('PENDING');
    db.close();
  });

  it('retries a successful AI_RUN to Chatwoot from exact durable text with child source_id', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const evidence = await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'parent-op');
    await seedParent(db, evidence, {
      provider: 'chatwoot', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
    });
    const exactText = '  durable AI\nanswer  ';
    await seedAiRun(db, 'SUCCESS', exactText);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 910 }), { status: 200 })
    );

    const result = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const childId = await manualRetryChildId('parent-op');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(result).toMatchObject({ childOperationId: childId, childStatus: 'SENT' });
    expect(body.content).toBe(exactText);
    expect(body.source_id).toBe(`cz2128:${childId}`);
    expect(body.source_id).not.toBe('cz2128:parent-op');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('retries a successful AI_RUN Telegram mirror with the frozen exact format', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'), {
      provider: 'telegram', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
    });
    await seedAiRun(db, 'SUCCESS', 'Exact durable answer');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 911 } }), { status: 200 })
    );

    const result = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(result.childStatus).toBe('SENT');
    expect(body.text).toBe('🤖 AI\n\nExact durable answer');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it.each([
    ['FAILED_RETRYABLE', 'text'],
    ['FAILED_FINAL', 'text'],
    ['SUCCESS', null]
  ] as const)('rejects %s AI_RUN state without child or provider action', async (status, text) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'), {
      provider: 'telegram', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
    });
    await seedAiRun(db, status, text);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it('keeps the same AI_RUN child across 429 and resumes only after its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'), {
      provider: 'telegram', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
    });
    await seedAiRun(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false, error_code: 429, parameters: { retry_after: 1 }
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, result: { message_id: 912 }
      }), { status: 200 }));

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).resolves.toMatchObject({ childStatus: 'SENT', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    db.close();
  });

  it('does not automatically resend an ambiguous AI_RUN child', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'), {
      provider: 'telegram', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
    });
    await seedAiRun(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('transport lost'));

    const first = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const second = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );

    expect(first.childStatus).toBe('AMBIGUOUS');
    expect(second).toMatchObject({ childStatus: 'AMBIGUOUS', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('reuses the same child across 429 and never creates a second direct child', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'));
    await seedMessage(db, 'chatwoot', 'cw-message-1', 'retry text');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false, error_code: 429, parameters: { retry_after: 1 }
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, result: { message_id: 903 }
      }), { status: 200 }));

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_RATE_LIMITED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    const resumed = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    expect(resumed.childStatus).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('does not automatically resend an ambiguous child', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'));
    await seedMessage(db, 'chatwoot', 'cw-message-1', 'uncertain text');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('transport lost'));

    const first = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const second = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );

    expect(first.childStatus).toBe('AMBIGUOUS');
    expect(second).toMatchObject({ childStatus: 'AMBIGUOUS', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('does not automatically resend a FAILED_FINAL child', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'));
    await seedMessage(db, 'chatwoot', 'cw-message-1', 'final failure text');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 400 })
    );

    const first = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const second = await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );

    expect(first.childStatus).toBe('FAILED_FINAL');
    expect(second).toMatchObject({ childStatus: 'FAILED_FINAL', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('fails closed when more than one direct child exists', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const evidence = buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage');
    await seedParent(db, evidence, { reconciliationStatus: 'MANUAL_RETRY_CREATED' });
    for (const id of ['child-a', 'child-b']) {
      await db.prepare(
        `INSERT INTO outbound_operations
         (id, conversation_id, destination_provider, operation_type, status, reconciliation_status,
          parent_operation_id, subject_type, subject_ref, target_evidence_json, created_at, updated_at)
         VALUES (?, 'conv', 'telegram', 'SEND_MESSAGE', 'FAILED_FINAL', 'NOT_REQUIRED',
                 'parent-op', 'MESSAGE', 'chatwoot:cw-message-1', ?, 1, 1)`
      ).bind(id, JSON.stringify(evidence)).run();
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'INTERNAL_INVARIANT_VIOLATION' });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('concurrent operator calls create one child and one visible provider effect', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    await seedParent(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'));
    await seedMessage(db, 'chatwoot', 'cw-message-1', 'one visible send');
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      markFetchStarted();
      await fetchGate;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 905 } }), { status: 200 });
    });

    const first = manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    await fetchStarted;
    const second = manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '43' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );

    await expect(second).rejects.toMatchObject({ code: 'CONCURRENCY_LEASE_HELD' });
    releaseFetch();
    await expect(first).resolves.toMatchObject({ childStatus: 'SENT', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('parent-op').first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'MANUAL_RETRY_CHILD_CREATED'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('never resends the original parent after MANUAL_RETRY_CREATED', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const evidence = buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage');
    await seedParent(db, evidence);
    await seedMessage(db, 'chatwoot', 'cw-message-1', 'child only');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 906 } }), { status: 200 })
    );
    await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const parentAction = vi.fn();

    const parentResult = await executeOutboundOperation(
      env,
      'conv',
      'telegram',
      'SEND_MESSAGE',
      parentAction,
      'parent-op',
      { subject: { type: 'MESSAGE', ref: 'chatwoot:cw-message-1' }, targetEvidence: evidence }
    );

    expect(parentResult.status).toBe('AMBIGUOUS');
    expect(parentAction).not.toHaveBeenCalled();
    db.close();
  });

  it('keeps child evidence and reliability audit free of reconstructed message content and secrets', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    const env = makeEnv(db);
    const evidence = await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'parent-op');
    await seedParent(db, evidence, { provider: 'chatwoot', subjectRef: 'telegram:1:2' });
    const privateText = 'PRIVATE-CONTENT-987';
    await seedMessage(db, 'telegram', '1:2', privateText);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 904 }), { status: 200 }));

    await manualRetryOutboundOperation(
      env, 'parent-op', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const childId = await manualRetryChildId('parent-op');
    const child = await loadOperation(db, childId);
    const audits = await db.prepare('SELECT * FROM reliability_audit').all<Record<string, unknown>>();
    const persisted = JSON.stringify({ child, audits: audits.results });

    expect(persisted).not.toContain(privateText);
    expect(persisted).not.toContain('chatwoot-token');
    expect(persisted).not.toContain('telegram-token');
    expect(persisted).not.toContain('https://chat.example');
    db.close();
  });
});
