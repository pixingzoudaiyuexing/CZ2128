import { afterEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import { publishApprovedLearningCandidate } from '../src/learning/publish';
import { searchKnowledge } from '../src/knowledge/repository';

function setup(status: 'APPROVED' | 'REJECTED' = 'APPROVED') {
  const db = new SqliteD1();
  db.migrateThroughHumanLearning();
  db.exec(`
    INSERT INTO conversations
    (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
     operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
    VALUES ('conv-1', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1);
    INSERT INTO messages
    (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
    VALUES ('a', 'conv-1', 'crisp', 'a', 'OUTBOUND', 'OPERATOR', 'TEXT', 'Three days', 3);
    INSERT INTO learning_candidates
    (id, version, source_conversation_id, source_human_message_id, source_provider,
     review_status, sanitized_answer, extracted_title, extracted_question, extracted_answer,
     extraction_reason, risk_level, risk_flags_json, extraction_status, extraction_attempt_count,
     notion_page_id, notion_sync_status, last_synced_candidate_version, reviewed_at, created_at, updated_at)
    VALUES
    ('lrn_publish_001', 3, 'conv-1', 'a', 'crisp', '${status}', 'Three days',
     'Refund timing', 'How long does a refund take?', 'Refunds take three business days.',
     'Reusable guidance', 'LOW', '[]', 'SUCCEEDED', 1, 'page-publish-1', 'SYNCED', 2, 4, 3, 4);
  `);
  return { db, env: { DB: db } as any };
}

describe('learning publication', () => {
  const dbs: SqliteD1[] = [];
  afterEach(() => {
    while (dbs.length) dbs.pop()!.close();
  });

  it('atomically publishes one Approved candidate into the existing knowledge store and FTS', async () => {
    const { db, env } = setup(); dbs.push(db);
    const published = await publishApprovedLearningCandidate(env, 'lrn_publish_001');
    expect(published.review_status).toBe('PUBLISHED');
    expect(published.published_knowledge_id).toMatch(/^kb_lrn_[0-9a-f]{24}$/);
    expect(published.published_knowledge_version).toBe(1);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get()).toEqual({ n: 1 });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM knowledge_entry_history').get()).toEqual({ n: 1 });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM learning_candidate_history WHERE action='PUBLISH'").get())
      .toEqual({ n: 1 });
    const results = await searchKnowledge(env, 'refund timing');
    expect(results.map(row => row.id)).toContain(published.published_knowledge_id);
  });

  it('repeated and concurrent publication converge on the same knowledge identity', async () => {
    const { db, env } = setup(); dbs.push(db);
    const [first, second] = await Promise.all([
      publishApprovedLearningCandidate(env, 'lrn_publish_001'),
      publishApprovedLearningCandidate(env, 'lrn_publish_001')
    ]);
    expect(first.published_knowledge_id).toBe(second.published_knowledge_id);
    const third = await publishApprovedLearningCandidate(env, 'lrn_publish_001');
    expect(third.published_knowledge_id).toBe(first.published_knowledge_id);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get()).toEqual({ n: 1 });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM knowledge_entry_history').get()).toEqual({ n: 1 });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM learning_candidate_history WHERE action='PUBLISH'").get())
      .toEqual({ n: 1 });
  });

  it('never publishes Rejected candidates', async () => {
    const { db, env } = setup('REJECTED'); dbs.push(db);
    const candidate = await publishApprovedLearningCandidate(env, 'lrn_publish_001');
    expect(candidate.review_status).toBe('REJECTED');
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get()).toEqual({ n: 0 });
  });

  it('fails closed on a deterministic knowledge-id collision with unrelated ownership', async () => {
    const { db, env } = setup(); dbs.push(db);
    const cryptoModule = await import('node:crypto');
    const hex = cryptoModule.createHash('sha256').update('lrn_publish_001').digest('hex');
    const id = 'kb_lrn_' + hex.slice(0, 24);
    db.exec(`
      INSERT INTO knowledge_entries
      (id, title, body, search_terms, enabled, version, created_by, updated_by, created_at, updated_at)
      VALUES ('${id}', 'Unrelated', 'Other', 'unrelated', 1, 1, 'manual', 'manual', 1, 1);
    `);
    await expect(publishApprovedLearningCandidate(env, 'lrn_publish_001'))
      .rejects.toThrow('LEARNING_PUBLICATION_CAS_CONFLICT');
    const row = db.database.prepare("SELECT review_status,published_knowledge_id FROM learning_candidates WHERE id='lrn_publish_001'").get();
    expect(row).toEqual({ review_status: 'APPROVED', published_knowledge_id: null });
  });
});
