import { afterEach, describe, expect, it, vi } from 'vitest';
import { processLearningCallback } from '../src/admin/learning';
import { SqliteD1 } from './helpers/sqlite-d1';

function setupCandidates(count = 11) {
  const db = new SqliteD1();
  db.migrateThroughHumanLearning();
  db.exec(`
    INSERT INTO conversations
    (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
     operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
    VALUES ('conv-1', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1);
  `);
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(2, '0');
    db.exec(`
      INSERT INTO messages
      (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
      VALUES ('m-${suffix}', 'conv-1', 'crisp', 'ref-${suffix}', 'OUTBOUND', 'OPERATOR', 'TEXT',
              'Answer ${suffix}', ${10 + index});
      INSERT INTO learning_candidates
      (id, version, source_conversation_id, source_human_message_id, source_provider,
       review_status, sanitized_answer, risk_level, risk_flags_json, extraction_status,
       extraction_attempt_count, notion_sync_status, created_at, updated_at)
      VALUES ('lrn_admin_${suffix}', 1, 'conv-1', 'm-${suffix}', 'crisp',
              'NEEDS_REVIEW', 'Answer ${suffix}', 'LOW', '[]', 'FAILED',
              3, 'PENDING', ${10 + index}, ${10 + index});
    `);
  }
  return db;
}

describe('learning admin control', () => {
  const dbs: SqliteD1[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop()!.close();
  });

  it('bounds explicit sync to 10 candidates and makes zero Notion calls when disabled', async () => {
    const db = setupCandidates();
    dbs.push(db);
    const env = { DB: db, NOTION_LEARNING_ENABLED: 'false' } as any;
    const bootstrap = {
      token: '999999:fake-admin-token-abcdefghijklmnopqrstuvwxyz',
      path: 'p'.repeat(43),
      webhookSecret: 's'.repeat(43),
      userIds: new Set(['1001'])
    };
    const ctx = {
      updateId: '1',
      userId: '1001',
      chatId: '1001',
      callbackData: 'l:sync'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
    );

    await expect(processLearningCallback(env, bootstrap, ctx, 'sync'))
      .resolves.toBe('LEARNING_SYNC_BATCH');

    const counts = db.database.prepare(
      `SELECT notion_sync_status, COUNT(*) AS n
         FROM learning_candidates
        GROUP BY notion_sync_status
        ORDER BY notion_sync_status`
    ).all();
    expect(counts).toEqual([
      { notion_sync_status: 'DISABLED', n: 10 },
      { notion_sync_status: 'PENDING', n: 1 }
    ]);
    expect(fetchMock.mock.calls.every(call =>
      !String(call[0]).startsWith('https://api.notion.com/')
    )).toBe(true);
  });
});
