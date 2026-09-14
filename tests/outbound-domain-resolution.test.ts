import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../src/config/env';
import { buildChatwootTargetEvidence, buildTelegramTargetEvidence } from '../src/core/outbound-evidence';
import { resolveOutboundDomainState } from '../src/core/outbound-domain-resolution';
import { manualCancel, manualMarkDelivered, reconcileOutboundOperation } from '../src/core/outbound-reconciliation';
import { manualRetryOutboundOperation } from '../src/core/outbound-manual-retry';
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
    ATTACHMENTS_BUCKET: { get: bucketGet } as any
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
