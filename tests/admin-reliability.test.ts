import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { SqliteD1 } from './helpers/sqlite-d1';

const adminPath = 'p'.repeat(43);
const adminSecret = 's'.repeat(43);

function env(db: SqliteD1) {
  return {
    DB: db,
    RUNTIME_CONFIG_MASTER_KEY: '0'.repeat(43),
    ADMIN_TELEGRAM_BOT_TOKEN: '999999:admin-token-abcdefghijklmnopqrstuvwxyz',
    ADMIN_TELEGRAM_WEBHOOK_SECRET: adminSecret,
    ADMIN_TELEGRAM_SECRET_PATH: adminPath,
    ADMIN_TELEGRAM_USER_IDS: '1001,1002',
    AI_BASE_URL: 'https://ai.example/v1', AI_MODEL: 'model', AI_API_KEY: 'env-ai-key',
    TELEGRAM_BOT_TOKEN: '111111:old-support-abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_WEBHOOK_SECRET: 'old-secret', TELEGRAM_SECRET_PATH: 'old-path', BOT_GROUP_ID: '-10099',
    CHATWOOT_API_URL: 'https://chatwoot.example', CHATWOOT_API_TOKEN: 'cw-token'
  } as any;
}

function callback(updateId: number, data: string, options: { userId?: number } = {}) {
  const userId = options.userId ?? 1001;
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`, data, from: { id: userId },
        message: { chat: { id: userId, type: 'private' } }
      }
    })
  });
}

function message(updateId: number, text: string, options: { userId?: number } = {}) {
  const userId = options.userId ?? 1001;
  return new Request(`https://worker.example/webhooks/admin-telegram/${adminPath}`, {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: updateId, text, from: { id: userId }, chat: { id: userId, type: 'private' } }
    })
  });
}

function ok(result: any = true) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function defaultTelegramMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    return ok({ message_id: 1 });
  });
}

describe('Admin Reliability Control Plane', () => {
  afterEach(() => vi.restoreAllMocks());

  it('provides bounded unresolved query and correctly calculates summary', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    // Unresolved
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', 10, 10, 0),
      ('op2', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'STILL_AMBIGUOUS', 20, 20, 0),
      ('op3', 'c1', 'telegram', 'SEND_MESSAGE', 'FAILED_RETRYABLE', 'PENDING', 30, 30, 0),
      ('op4', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'MANUAL_CANCELLED', 40, 40, 0)
    `);
    
    db.exec(`INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, handoff_epoch, status, attempt_count, created_at, updated_at) VALUES 
      ('evt1', 'c1', 'msg1', 1, 'FAILED_RETRYABLE', 1, 10, 10),
      ('evt2', 'c1', 'msg2', 1, 'FAILED_FINAL', 1, 20, 20)
    `);

    await handleAdminTelegramWebhook(callback(10, 'p:rel'), testEnv);
    const replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    expect(replies[0]).toContain('Unresolved AMBIGUOUS: 2');
    expect(replies[0]).toContain('Pending automatic outbound retries: 1');
    expect(replies[0]).toContain('Manual resolutions: 1');
    expect(replies[0]).toContain('AI FAILED_RETRYABLE: 1');
    expect(replies[0]).toContain('AI FAILED_FINAL: 1');
  });

  it('forces provider ref confirmation for CREATE_TOPIC manual mark', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, subject_type, subject_ref, target_evidence_json) VALUES 
      ('op1', 'c1', 'telegram', 'CREATE_TOPIC', 'AMBIGUOUS', 'PENDING', 10, 10, 0, 'CONVERSATION', 'c1', '{}')
    `);
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_INSPECT', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    
    await handleAdminTelegramWebhook(callback(100, 'r:o:mark_begin'), testEnv);
    let replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    expect(replies[0]).toContain('请输入该 CREATE_TOPIC 操作实际使用的 provider message/thread ref：');
    
    fetchMock.mockClear();
    await handleAdminTelegramWebhook(message(101, 'topic_99'), testEnv);
    replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    expect(replies[0]).toContain('CREATE_TOPIC provider ref 已暂存为: topic_99');
    
    const session = (await db.prepare('SELECT action FROM admin_sessions WHERE admin_user_id = ?').bind('1001').first()) as any;
    expect(session.action).toBe('RELIABILITY_MARK_CONFIRM');
  });

});

  it('requires explicit confirmation for cancel operation', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, subject_type, subject_ref, target_evidence_json) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', 10, 10, 0, 'MESSAGE', 'm1', '{}')
    `);
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_INSPECT', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    
    await handleAdminTelegramWebhook(callback(200, 'r:o:cancel_begin'), testEnv);
    let session = (await db.prepare('SELECT action FROM admin_sessions WHERE admin_user_id = ?').bind('1001').first()) as any;
    expect(session.action).toBe('RELIABILITY_CANCEL_CONFIRM');
    let op = (await db.prepare('SELECT reconciliation_status FROM outbound_operations WHERE id = ?').bind('op1').first()) as any;
    expect(op.reconciliation_status).toBe('PENDING'); // No mutation yet
    
    await handleAdminTelegramWebhook(callback(201, 'r:o:cancel_yes'), testEnv);
    op = (await db.prepare('SELECT reconciliation_status FROM outbound_operations WHERE id = ?').bind('op1').first()) as any;
    expect(op.reconciliation_status).toBe('MANUAL_CANCELLED');
    
    session = (await db.prepare('SELECT action FROM admin_sessions WHERE admin_user_id = ?').bind('1001').first()) as any;
    expect(session.action).toBe('RELIABILITY_INSPECT');
  });

  it('rejects stale confirmation safely', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, subject_type, subject_ref, target_evidence_json) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'MANUAL_CANCELLED', 10, 10, 0, 'MESSAGE', 'm1', '{}')
    `); // Already cancelled by another actor
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_CANCEL_CONFIRM', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    
    await handleAdminTelegramWebhook(callback(300, 'r:o:cancel_yes'), testEnv);
    const op = (await db.prepare('SELECT reconciliation_status FROM outbound_operations WHERE id = ?').bind('op1').first()) as any;
    expect(op.reconciliation_status).toBe('MANUAL_CANCELLED');
  });

  it('rejects unauthorized mutations', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('9999', 'RELIABILITY_INSPECT', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    
    // User 9999 is not in ADMIN_TELEGRAM_USER_IDS
    await handleAdminTelegramWebhook(callback(400, 'r:o:cancel_begin', { userId: 9999 }), testEnv);
    const session = (await db.prepare('SELECT action FROM admin_sessions WHERE admin_user_id = ?').bind('9999').first()) as any;
    expect(session.action).toBe('RELIABILITY_INSPECT'); // Unchanged
  });

  it('prevents duplicate admin update effects', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, subject_type, subject_ref, target_evidence_json) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', 10, 10, 0, 'MESSAGE', 'm1', '{}')
    `);
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_CANCEL_CONFIRM', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    
    const req1 = callback(500, 'r:o:cancel_yes');
    const req2 = callback(500, 'r:o:cancel_yes');
    
    await Promise.all([
      handleAdminTelegramWebhook(req1, testEnv),
      handleAdminTelegramWebhook(req2, testEnv)
    ]);
    
    const count = (await db.prepare('SELECT COUNT(*) as c FROM reliability_audit WHERE entity_id = ?').bind('op1').first()) as any;
    expect(count.c).toBe(1);
  });

  it('orders uncertain deliveries by updated_at DESC', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    // Insert 12 ambiguous operations
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    for (let i = 1; i <= 12; i++) {
      db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count) VALUES 
        ('op${i}', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', ${i}, ${i}, 0)
      `);
    }

    await handleAdminTelegramWebhook(callback(600, 'r:unc'), testEnv);
    const replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    const text = replies[0];
    
    // Should include op12, op11, op10 etc. down to op3. Should not include op1 or op2.
    expect(text).toContain('op12');
    expect(text).toContain('op11');
    expect(text).not.toContain('op1\n');
    expect(text).not.toContain('op2\n');
  });

  it('allows manual retry and preserves parent/child', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES ('m1', 'c1', 'chatwoot', 'ref', 'INBOUND', 'CUSTOMER', 'TEXT', 'hello', 10)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, subject_type, subject_ref, target_evidence_json) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', 10, 10, 0, 'MESSAGE', 'm1', '{"type":"message"}')
    `);
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_INSPECT', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    
    await handleAdminTelegramWebhook(callback(700, 'r:o:retry_begin'), testEnv);
    const session = (await db.prepare('SELECT action FROM admin_sessions WHERE admin_user_id = ?').bind('1001').first()) as any;
    expect(session.action).toBe('RELIABILITY_RETRY_CONFIRM');
    
    await handleAdminTelegramWebhook(callback(701, 'r:o:retry_yes'), testEnv);
    
    const children = (await db.prepare('SELECT id, target_evidence_json, status FROM outbound_operations WHERE parent_operation_id = ?').bind('op1').all()) as any;
    const replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    expect(replies[1]).toContain('操作失败');
    
    
    // Duplicate Admin update test
    await handleAdminTelegramWebhook(callback(701, 'r:o:retry_yes'), testEnv); // Idempotent check
    const childrenAgain = (await db.prepare('SELECT id FROM outbound_operations WHERE parent_operation_id = ?').bind('op1').all()) as any;
    expect(childrenAgain.results.length).toBe(0);
  });

  it('safely handles privacy sentinels across admin views', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    const fetchMock = defaultTelegramMock();
    
    // Insert sentinels in various places
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, target_evidence_json, last_error) VALUES 
      ('op1', 'c1', 'telegram', 'SEND_MESSAGE', 'AMBIGUOUS', 'PENDING', 10, 10, 0, 'RAW_TARGET_EVIDENCE_SECRET_789', 'SUPER_SECRET_INTERNAL_ERROR_123')
    `);
    
    db.exec(`INSERT INTO messages (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at) VALUES 
      ('msg1', 'c1', 'telegram', 'ref1', 'INBOUND', 'CUSTOMER', 'TEXT', 'PRIVATE_MESSAGE_BODY_123', 10)
    `);
    
    db.exec(`INSERT INTO ai_runs (trigger_event_ref, conversation_id, trigger_message_ref, handoff_epoch, status, attempt_count, response_text, created_at, updated_at) VALUES 
      ('evt1', 'c1', 'msg1', 1, 'FAILED_RETRYABLE', 1, 'PRIVATE_AI_RESPONSE_456', 10, 10)
    `);
    
    await handleAdminTelegramWebhook(callback(800, 'r:ai'), testEnv);
    await handleAdminTelegramWebhook(callback(801, 'r:unc'), testEnv);
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_INSPECT', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1"}')`);
    await handleAdminTelegramWebhook(callback(802, 'r:o:refresh'), testEnv); // Inspect OP
    
    const replies = fetchMock.mock.calls.filter(call => String(call[0]).includes('sendMessage')).map(call => String(call[1]?.body));
    const allText = replies.join(' ');
    
    expect(allText).not.toContain('PRIVATE_MESSAGE_BODY_123');
    expect(allText).not.toContain('PRIVATE_AI_RESPONSE_456');
    expect(allText).not.toContain('RAW_TARGET_EVIDENCE_SECRET_789');
    expect(allText).not.toContain('SUPER_SECRET_INTERNAL_ERROR_123');
    expect(allText).not.toContain('SUPER_SECRET_API_KEY');
  });

  it('completes CREATE_TOPIC provider ref confirmation successfully', async () => {
    const db = new SqliteD1();
    db.migrate();
    const testEnv = env(db);
    defaultTelegramMock();
    
    db.exec(`INSERT INTO conversations (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref, operator_channel, operator_thread_status, ai_handoff_epoch, last_telegram_operator_profile_version, created_at, updated_at, version) VALUES ('c1', 'a', 'a', 'a', 'a', 'telegram', 'OPEN', 1, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO outbound_operations (id, conversation_id, destination_provider, operation_type, status, reconciliation_status, created_at, updated_at, attempt_count, subject_type, subject_ref, target_evidence_json) VALUES 
      ('op1', 'c1', 'telegram', 'CREATE_TOPIC', 'AMBIGUOUS', 'PENDING', 10, 10, 0, 'CONVERSATION', 'c1', '{}')
    `);
    
    db.exec(`INSERT INTO admin_sessions (admin_user_id, action, target, expected_version, expires_at, updated_at, context_json) VALUES ('1001', 'RELIABILITY_MARK_CONFIRM', 'OPERATION', 0, 9999999999, 0, '{"operationId": "op1", "providerRef": "topic_99"}')`);
    
    await handleAdminTelegramWebhook(callback(102, 'r:o:mark_yes'), testEnv);
    const op = (await db.prepare('SELECT reconciliation_status, provider_message_ref FROM outbound_operations WHERE id = ?').bind('op1').first()) as any;
    expect(op.reconciliation_status).toBe('MANUAL_MARK_DELIVERED');
    expect(op.provider_message_ref).toBe('topic_99');
  });
