import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import {
  buildChatwootTargetEvidence,
  buildCrispTargetEvidence,
  buildTelegramTargetEvidence
} from '../src/core/outbound-evidence';
import { resolveOutboundDomainState } from '../src/core/outbound-domain-resolution';
import { manualCancel, manualMarkDelivered, reconcileOutboundOperation } from '../src/core/outbound-reconciliation';
import { manualRetryOutboundOperation } from '../src/core/outbound-manual-retry';
import { migrateTelegramGroup } from '../src/runtime-config/service';
import { SqliteD1 } from './helpers/sqlite-d1';

function makeEnv(db: SqliteD1, bucketGet = vi.fn()): Env {
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
    ATTACHMENTS_BUCKET: { get: bucketGet } as any,
    DLQ_QUARANTINE: {} as any
  };
}

async function seedConversation(
  db: SqliteD1,
  thread: string | null = '77',
  status: 'OPEN' | 'CLOSED' = 'OPEN'
): Promise<void> {
  await db.prepare(
    `INSERT INTO conversations
     (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
      operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
     VALUES ('conv', 'chatwoot', 'account-1', 'conversation-2', 'customer-3',
             'telegram', ?, ?, 1, 1, 1)`
  ).bind(thread, status).run();
}

async function seedAttachment(
  db: SqliteD1,
  overrides: Partial<{
    status: string;
    error: string | null;
    expiresAt: number;
    destinationRef: string | null;
    destination: 'telegram' | 'chatwoot';
  }> = {}
): Promise<void> {
  await db.prepare(
    `INSERT INTO attachments
     (id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
      attachment_type, original_filename, safe_filename, mime_type, size_bytes,
      storage_key, access_token_hash, status, destination_provider, destination_message_ref,
      attempt_count, expires_at, last_error, created_at, updated_at)
     VALUES ('att-1', 'conv', ?, 'source-message', 'source-attachment',
             'document', 'private.txt', 'private.txt', 'text/plain', 4,
             'attachments/att-1', 'token-hash', ?, ?, ?, 2, ?, ?, 1, 1)`
  ).bind(
    (overrides.destination || 'telegram') === 'telegram' ? 'chatwoot' : 'telegram',
    overrides.status || 'FAILED_FINAL',
    overrides.destination || 'telegram',
    overrides.destinationRef ?? null,
    overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    overrides.error === undefined ? 'ATTACHMENT_DELIVERY_AMBIGUOUS' : overrides.error
  ).run();
}

async function seedOperation(
  db: SqliteD1,
  evidence: object,
  overrides: Partial<{
    id: string;
    provider: string;
    operationType: string;
    status: string;
    providerRef: string | null;
    reconciliation: string;
    subjectType: string;
    subjectRef: string;
  }> = {}
): Promise<void> {
  await db.prepare(
    `INSERT INTO outbound_operations
     (id, conversation_id, destination_provider, operation_type, status, provider_message_ref,
      attempt_count, request_started_at, reconciliation_status, subject_type, subject_ref,
      target_evidence_json, created_at, updated_at)
     VALUES (?, 'conv', ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 1, 1)`
  ).bind(
    overrides.id || 'op-1',
    overrides.provider || 'telegram',
    overrides.operationType || 'SEND_ATTACHMENT',
    overrides.status || 'AMBIGUOUS',
    overrides.providerRef ?? null,
    overrides.reconciliation || 'PENDING',
    overrides.subjectType || 'ATTACHMENT',
    overrides.subjectRef || 'att-1',
    JSON.stringify(evidence)
  ).run();
}

async function seedAiRun(db: SqliteD1, text = 'Durable AI answer'): Promise<void> {
  await db.prepare(
    `INSERT INTO ai_runs
     (trigger_event_ref, conversation_id, trigger_message_ref, generation_id, handoff_epoch,
      provider_response_ref, response_text, status, attempt_count, created_at, updated_at)
     VALUES ('ai-run-1', 'conv', 'customer-message-1', 'generation-1', 0,
             'provider-response-1', ?, 'SUCCESS', 1, 1, 1)`
  ).bind(text).run();
}

function r2Object(bytes = new TextEncoder().encode('data')) {
  return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
}

describe('resolved outbound domain state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries an unexpired ambiguous stored attachment and resolves child SENT to DELIVERED', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db);
    const bucketGet = vi.fn().mockResolvedValue(r2Object());
    const env = makeEnv(db, bucketGet);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 601 } }), { status: 200 })
    );

    const result = await manualRetryOutboundOperation(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const attachment = await db.prepare('SELECT * FROM attachments WHERE id = ?').bind('att-1').first<any>();

    expect(result.childStatus).toBe('SENT');
    expect(attachment).toMatchObject({
      status: 'DELIVERED', destination_message_ref: '601', last_error: null, attempt_count: 2
    });
    expect(bucketGet).toHaveBeenCalledWith('attachments/att-1');
    db.close();
  });

  it('does not resend or consume an expired attachment decision', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db, { expiresAt: Math.floor(Date.now() / 1000) });
    const bucketGet = vi.fn();
    const env = makeEnv(db, bucketGet);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' });
    expect(bucketGet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id = ?')
      .bind('op-1').first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it('does not create a child when the durable R2 object is missing', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db);
    const env = makeEnv(db, vi.fn().mockResolvedValue(null));
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'R2_OBJECT_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT reconciliation_status FROM outbound_operations WHERE id = ?')
      .bind('op-1').first<any>()).reconciliation_status).toBe('PENDING');
    db.close();
  });

  it.each([
    ['ATTACHMENT_SOURCE_INVALID'],
    ['ATTACHMENT_DELIVERY_FINAL'],
    ['ATTACHMENT_RETRY_EXHAUSTED']
  ] as const)('rejects attachment state %s without R2 or provider access', async errorCode => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db, { error: errorCode });
    const bucketGet = vi.fn();
    const env = makeEnv(db, bucketGet);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualRetryOutboundOperation(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    )).rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE' });
    expect(bucketGet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('manual mark delivered repairs an ambiguous attachment after TTL expiry without resending', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db, { expiresAt: 1 });
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await manualMarkDelivered(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', '602'
    );
    const attachment = await db.prepare('SELECT * FROM attachments WHERE id = ?').bind('att-1').first<any>();

    expect(attachment).toMatchObject({ status: 'DELIVERED', destination_message_ref: '602', last_error: null });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('re-enters manual mark delivered after a transiently unfinished domain repair without a second transition audit', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db, { error: 'ATTACHMENT_DELIVERY_FINAL' });
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualMarkDelivered(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', '605'
    )).rejects.toMatchObject({ code: 'OUTBOUND_DOMAIN_STATE_CONFLICT' });
    await db.prepare(
      "UPDATE attachments SET last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS' WHERE id = 'att-1'"
    ).run();
    await manualMarkDelivered(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', '605'
    );

    expect((await db.prepare('SELECT status FROM attachments WHERE id = ?')
      .bind('att-1').first<any>()).status).toBe('DELIVERED');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'MANUAL_MARK_DELIVERED'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('CONFIRMED_SENT reconciliation repairs an attachment and remains re-entrant', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db);
    const env = makeEnv(db);
    const evidence = await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'op-1');
    await db.prepare("UPDATE attachments SET destination_provider = 'chatwoot', source_provider = 'telegram' WHERE id = 'att-1'").run();
    await seedOperation(db, evidence, { provider: 'chatwoot' });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ payload: [
        { id: 603, source_id: 'cz2128:op-1' }
      ] }), { status: 200 }));

    await reconcileOutboundOperation(env, 'op-1');
    await reconcileOutboundOperation(env, 'op-1');
    const attachment = await db.prepare('SELECT * FROM attachments WHERE id = ?').bind('att-1').first<any>();

    expect(attachment).toMatchObject({ status: 'DELIVERED', destination_message_ref: '603' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'DOMAIN_STATE_RESOLVED'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('treats an already delivered compatible attachment as idempotent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db, { status: 'DELIVERED', error: null, destinationRef: '604' });
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'), {
      status: 'SENT', reconciliation: 'NOT_REQUIRED', providerRef: '604'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: false, domain: 'ATTACHMENT'
    });
    db.close();
  });

  it('fails closed on a conflicting delivered attachment provider reference', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db, { status: 'DELIVERED', error: null, destinationRef: 'old-ref' });
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'), {
      status: 'SENT', reconciliation: 'NOT_REQUIRED', providerRef: 'new-ref'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT destination_message_ref FROM attachments WHERE id = ?')
      .bind('att-1').first<any>()).destination_message_ref).toBe('old-ref');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'DOMAIN_STATE_CONFLICT'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('manual cancel does not mutate attachment delivery state', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAttachment(db);
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendDocument'));

    await manualCancel(env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CANCELLED');
    const attachment = await db.prepare('SELECT status, last_error FROM attachments WHERE id = ?')
      .bind('att-1').first<any>();

    expect(attachment).toEqual({ status: 'FAILED_FINAL', last_error: 'ATTACHMENT_DELIVERY_AMBIGUOUS' });
    db.close();
  });

  it('repairs one durable AI message after primary Chatwoot SENT and remains idempotent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAiRun(db);
    const env = makeEnv(db);
    await seedOperation(
      db,
      await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'op-1'),
      {
        provider: 'chatwoot', operationType: 'SEND_MESSAGE', status: 'SENT',
        providerRef: 'chatwoot-message-1', reconciliation: 'NOT_REQUIRED',
        subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
      }
    );

    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: true, domain: 'MESSAGE'
    });
    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: false, domain: 'MESSAGE'
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('repairs a confirmed Crisp AI message provider-free even after the current session mapping drifts', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await db.prepare(
      "UPDATE conversations SET helpdesk_provider = 'crisp', helpdesk_account_ref = 'website-current', helpdesk_conversation_ref = 'session-current' WHERE id = 'conv'"
    ).run();
    await seedAiRun(db);
    const env = makeEnv(db);
    await seedOperation(
      db,
      buildCrispTargetEvidence('website-historical', 'session-historical'),
      {
        provider: 'crisp', operationType: 'SEND_MESSAGE', status: 'SENT',
        providerRef: '123456789', reconciliation: 'NOT_REQUIRED',
        subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
      }
    );

    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: true, domain: 'MESSAGE'
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('assigns a stable fallback response identity before repairing a legacy SUCCESS message', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAiRun(db);
    await db.prepare("UPDATE ai_runs SET provider_response_ref = NULL WHERE trigger_event_ref = 'ai-run-1'").run();
    const env = makeEnv(db);
    await seedOperation(
      db,
      await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'op-1'),
      {
        provider: 'chatwoot', operationType: 'SEND_MESSAGE', status: 'SENT',
        reconciliation: 'NOT_REQUIRED', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
      }
    );

    await resolveOutboundDomainState(env, 'op-1');

    expect((await db.prepare('SELECT provider_response_ref FROM ai_runs WHERE trigger_event_ref = ?')
      .bind('ai-run-1').first<any>()).provider_response_ref).toBe('ai_res_ai-run-1');
    expect((await db.prepare("SELECT provider_message_ref FROM messages WHERE provider = 'ai'")
      .first<any>()).provider_message_ref).toBe('ai_res_ai-run-1');
    db.close();
  });

  it('repairs one durable AI message after CONFIRMED_SENT reconciliation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAiRun(db);
    const env = makeEnv(db);
    await seedOperation(
      db,
      await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'op-1'),
      {
        provider: 'chatwoot', operationType: 'SEND_MESSAGE', subjectType: 'AI_RUN',
        subjectRef: 'ai-run-1'
      }
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      payload: [{ id: 801, source_id: 'cz2128:op-1' }]
    }), { status: 200 }));

    await reconcileOutboundOperation(env, 'op-1');

    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    expect((await db.prepare('SELECT reconciliation_status FROM outbound_operations WHERE id = ?')
      .bind('op-1').first<any>()).reconciliation_status).toBe('CONFIRMED_SENT');
    db.close();
  });

  it('repairs one durable AI message after MANUAL_MARK_DELIVERED', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAiRun(db);
    const env = makeEnv(db);
    await seedOperation(
      db,
      await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'op-1'),
      {
        provider: 'chatwoot', operationType: 'SEND_MESSAGE', subjectType: 'AI_RUN',
        subjectRef: 'ai-run-1'
      }
    );

    await manualMarkDelivered(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', 'chatwoot-message-2'
    );

    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('fails closed when an AI provider response identity has conflicting message content', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAiRun(db, 'Canonical answer');
    const env = makeEnv(db);
    await seedOperation(
      db,
      await buildChatwootTargetEvidence(env, 'account-1', 'conversation-2', 'op-1'),
      {
        provider: 'chatwoot', operationType: 'SEND_MESSAGE', status: 'SENT',
        reconciliation: 'NOT_REQUIRED', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
      }
    );
    await db.prepare(
      `INSERT INTO messages
       (id, conversation_id, provider, provider_message_ref, direction, actor_role,
        message_type, text_content, created_at)
       VALUES ('conflict', 'conv', 'ai', 'provider-response-1', 'OUTBOUND', 'AI',
               'TEXT', 'Conflicting answer', 1)`
    ).run();

    await expect(resolveOutboundDomainState(env, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE provider = 'ai'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    db.close();
  });

  it('does not create an AI context message for Telegram mirror delivery alone', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db);
    await seedAiRun(db);
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'sendMessage'), {
      provider: 'telegram', operationType: 'SEND_MESSAGE', status: 'SENT',
      reconciliation: 'NOT_REQUIRED', subjectType: 'AI_RUN', subjectRef: 'ai-run-1'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: false, domain: 'NONE'
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages WHERE actor_role = 'AI'")
      .first<{ count: number }>()).toEqual({ count: 0 });
    db.close();
  });

  it('CREATE_TOPIC child uses the durable canonical title and populates thread mapping', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, null);
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', null, 'createForumTopic'), {
      operationType: 'CREATE_TOPIC', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_thread_id: 701 } }), { status: 200 })
    );

    await manualRetryOutboundOperation(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind('conv').first<any>();

    expect(body.name).toBe('Customer customer-3 | Chatwoot #conversation-2');
    expect(conversation.operator_thread_ref).toBe('701');
    db.close();
  });

  it('manual mark delivered populates a missing CREATE_TOPIC thread reference', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, null);
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', null, 'createForumTopic'), {
      operationType: 'CREATE_TOPIC', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await manualMarkDelivered(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', '702'
    );
    expect((await db.prepare('SELECT operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_ref).toBe('702');
    db.close();
  });

  it('blocks old-group CREATE_TOPIC repair after the actual support-group migration flow', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'old-topic');
    const oldEnv = { ...makeEnv(db), BOT_GROUP_ID: '-100111' };
    await seedOperation(db, buildTelegramTargetEvidence(
      oldEnv, '-100111', null, 'createForumTopic'
    ), {
      operationType: 'CREATE_TOPIC', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    await migrateTelegramGroup(oldEnv, '-100222', 0, '42', 'migration-update');
    const currentEnv = { ...oldEnv, BOT_GROUP_ID: '-100222' };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(manualMarkDelivered(
      currentEnv, 'op-1', { type: 'ADMIN', ref: '42' },
      'OPERATOR_CONFIRMED_DELIVERY', 'old-topic-702'
    )).rejects.toMatchObject({ code: 'OUTBOUND_DOMAIN_STATE_CONFLICT' });
    await expect(manualMarkDelivered(
      currentEnv, 'op-1', { type: 'ADMIN', ref: '42' },
      'OPERATOR_CONFIRMED_DELIVERY', 'old-topic-702'
    )).rejects.toMatchObject({ code: 'OUTBOUND_DOMAIN_STATE_CONFLICT' });

    const conversation = await db.prepare(
      'SELECT operator_thread_ref, operator_thread_status FROM conversations WHERE id = ?'
    ).bind('conv').first<any>();
    const operation = await db.prepare(
      'SELECT status, reconciliation_status FROM outbound_operations WHERE id = ?'
    ).bind('op-1').first<any>();
    expect(conversation).toEqual({ operator_thread_ref: null, operator_thread_status: 'OPEN' });
    expect(operation).toEqual({ status: 'AMBIGUOUS', reconciliation_status: 'MANUAL_MARK_DELIVERED' });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'MANUAL_MARK_DELIVERED'"
    ).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'DOMAIN_STATE_CONFLICT'"
    ).first<{ count: number }>()).toEqual({ count: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('blocks old-group CREATE_TOPIC domain repair even when the mapping is empty', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, null);
    const currentEnv = makeEnv(db);
    const oldEnv = { ...currentEnv, BOT_GROUP_ID: '-100222' };
    await seedOperation(db, buildTelegramTargetEvidence(
      oldEnv, '-100222', null, 'createForumTopic'
    ), {
      operationType: 'CREATE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      providerRef: '702', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(resolveOutboundDomainState(currentEnv, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_ref).toBeNull();
    expect(await db.prepare(
      "SELECT action, reason_code FROM reliability_audit WHERE action = 'DOMAIN_STATE_CONFLICT'"
    ).first()).toEqual({
      action: 'DOMAIN_STATE_CONFLICT', reason_code: 'CONVERSATION_GROUP_TARGET_CONFLICT'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('allows same-group CREATE_TOPIC repair after a normal support bot rotation', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, null);
    const storedEnv = {
      ...makeEnv(db),
      runtimeConfigSnapshot: {
        sources: { TELEGRAM_SUPPORT_PROFILE: 'D1', BOT_GROUP_ID: 'D1' },
        versions: { TELEGRAM_SUPPORT_PROFILE: 7, BOT_GROUP_ID: 4 },
        errors: {}
      }
    } as Env;
    await seedOperation(db, buildTelegramTargetEvidence(
      storedEnv, '-1001', null, 'createForumTopic'
    ), {
      operationType: 'CREATE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      providerRef: '704', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    const rotatedEnv = {
      ...storedEnv,
      runtimeConfigSnapshot: {
        ...storedEnv.runtimeConfigSnapshot!,
        versions: { TELEGRAM_SUPPORT_PROFILE: 8, BOT_GROUP_ID: 4 }
      }
    } as Env;

    await expect(resolveOutboundDomainState(rotatedEnv, 'op-1')).resolves.toEqual({
      changed: true, domain: 'CONVERSATION'
    });
    expect((await db.prepare('SELECT operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_ref).toBe('704');
    db.close();
  });

  it('does not overwrite a conflicting CREATE_TOPIC thread reference', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'newer-thread');
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', null, 'createForumTopic'), {
      operationType: 'CREATE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      providerRef: 'older-thread', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_ref).toBe('newer-thread');
    db.close();
  });

  it('rejects CREATE_TOPIC domain resolution without a provider topic reference', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, null);
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', null, 'createForumTopic'), {
      operationType: 'CREATE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      providerRef: null, subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_ref).toBeNull();
    db.close();
  });

  it.each([
    ['CLOSE_TOPIC', 'OPEN', 'CLOSED', 'closeForumTopic'],
    ['REOPEN_TOPIC', 'CLOSED', 'OPEN', 'reopenForumTopic']
  ] as const)('%s child SENT applies the expected conversation status CAS', async (operationType, initial, expected, method) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, '77', initial);
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', method), {
      operationType, subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
    );

    await manualRetryOutboundOperation(
      env, 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'
    );
    expect((await db.prepare('SELECT operator_thread_status FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_status).toBe(expected);
    db.close();
  });

  it.each([
    ['CLOSE_TOPIC', 'CLOSED', 'closeForumTopic'],
    ['REOPEN_TOPIC', 'OPEN', 'reopenForumTopic']
  ] as const)('does not treat stale-group %s as idempotent success', async (operationType, status, method) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, '77', status);
    const currentEnv = makeEnv(db);
    const oldEnv = { ...currentEnv, BOT_GROUP_ID: '-100222' };
    await seedOperation(db, buildTelegramTargetEvidence(oldEnv, '-100222', '77', method), {
      operationType, status: 'SENT', reconciliation: 'NOT_REQUIRED',
      subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await expect(resolveOutboundDomainState(currentEnv, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_status FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_status).toBe(status);
    db.close();
  });

  it.each([
    ['CLOSE_TOPIC', 'OPEN', 'closeForumTopic'],
    ['REOPEN_TOPIC', 'CLOSED', 'reopenForumTopic']
  ] as const)('blocks old-group %s with the same thread reference', async (operationType, status, method) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, '77', status);
    const currentEnv = makeEnv(db);
    const oldEnv = { ...currentEnv, BOT_GROUP_ID: '-100222' };
    await seedOperation(db, buildTelegramTargetEvidence(oldEnv, '-100222', '77', method), {
      operationType, status: 'SENT', reconciliation: 'NOT_REQUIRED',
      subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(resolveOutboundDomainState(currentEnv, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_status FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ['missing', '', undefined],
    ['invalid', '-99', undefined],
    ['runtime-config unavailable', '-1001', {
      errors: { BOT_GROUP_ID: 'RUNTIME_CONFIG_VALUE_INVALID' }
    }]
  ] as const)('fails closed when the current effective Telegram group is %s', async (_label, groupId, snapshot) => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, null);
    const storedEnv = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(
      storedEnv, '-1001', null, 'createForumTopic'
    ), {
      operationType: 'CREATE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      providerRef: '703', subjectType: 'CONVERSATION', subjectRef: 'conv'
    });
    const unavailableEnv = {
      ...storedEnv,
      BOT_GROUP_ID: groupId,
      ...(snapshot ? { runtimeConfigSnapshot: snapshot as any } : {})
    };

    await expect(resolveOutboundDomainState(unavailableEnv, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_ref).toBeNull();
    db.close();
  });

  it('keeps an already applied topic status idempotent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, '77', 'CLOSED');
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'closeForumTopic'), {
      operationType: 'CLOSE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: false, domain: 'CONVERSATION'
    });
    db.close();
  });

  it('keeps an already reopened topic status idempotent', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, '77', 'OPEN');
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', '77', 'reopenForumTopic'), {
      operationType: 'REOPEN_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).resolves.toEqual({
      changed: false, domain: 'CONVERSATION'
    });
    db.close();
  });

  it('does not mutate topic status when the current thread mapping differs', async () => {
    const db = new SqliteD1();
    db.migrate();
    await seedConversation(db, 'new-thread', 'OPEN');
    const env = makeEnv(db);
    await seedOperation(db, buildTelegramTargetEvidence(env, '-1001', 'old-thread', 'closeForumTopic'), {
      operationType: 'CLOSE_TOPIC', status: 'SENT', reconciliation: 'NOT_REQUIRED',
      subjectType: 'CONVERSATION', subjectRef: 'conv'
    });

    await expect(resolveOutboundDomainState(env, 'op-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DOMAIN_STATE_CONFLICT'
    });
    expect((await db.prepare('SELECT operator_thread_status FROM conversations WHERE id = ?')
      .bind('conv').first<any>()).operator_thread_status).toBe('OPEN');
    db.close();
  });
});
