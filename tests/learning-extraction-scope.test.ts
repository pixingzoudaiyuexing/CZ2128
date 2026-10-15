import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractLearningCandidate, extractPendingLearningCandidates } from '../src/learning/extraction';
import { captureLearningCandidateByProviderRef } from '../src/learning/repository';
import { SqliteD1 } from './helpers/sqlite-d1';

const ALLOWED = '00000000-0000-4000-8000-000000000001';
const HISTORICAL = '00000000-0000-4000-8000-000000000002';

describe('learning extraction respects the deployment AI test scope', () => {
  let db: SqliteD1;
  let env: any;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new SqliteD1(); db.migrateThroughHumanLearning();
    env = { DB: db, AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'synthetic-key', AI_MODEL: 'synthetic-model',
      AI_TEST_SCOPE_ENABLED: 'true', AI_TEST_ALLOWED_CONVERSATION_IDS: JSON.stringify([ALLOWED]) };
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      expect(String(url)).toBe('https://ai.example/v1/chat/completions');
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        generalizable: true, title: 'Synthetic support guidance', question: 'How do I get help?',
        proposed_answer: 'Contact support for assistance.', reason: 'Reusable synthetic guidance', risk_flags: []
      }) } }] });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  async function seed(conversationId: string, reference: string, updatedAt = 1) {
    await db.prepare(`INSERT INTO conversations
      (id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,created_at,updated_at)
      VALUES (?,'crisp','site',?,'synthetic','telegram',1,1) ON CONFLICT(id) DO NOTHING`)
      .bind(conversationId, conversationId).run();
    await db.prepare(`INSERT INTO messages
      (id,conversation_id,provider,provider_message_ref,direction,actor_role,message_type,text_content,created_at)
      VALUES (?,?,'crisp',?,'OUTBOUND','OPERATOR','TEXT','Synthetic human support answer',1)`)
      .bind(reference, conversationId, reference).run();
    const candidate = (await captureLearningCandidateByProviderRef(env, 'crisp', reference))!;
    await db.prepare('UPDATE learning_candidates SET updated_at=? WHERE id=?').bind(updatedAt, candidate.id).run();
    return (await db.prepare('SELECT * FROM learning_candidates WHERE id=?').bind(candidate.id).first<any>())!;
  }

  it('leaves an explicitly denied candidate and its attempt budget unchanged without provider calls', async () => {
    const candidate = await seed(HISTORICAL, 'denied');
    const result = await extractLearningCandidate(env, candidate.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(candidate);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM learning_candidate_history').first()).toEqual({ n: 1 });
  });

  it('processes the allowed candidate once even behind more than ten historical pending rows', async () => {
    for (let index = 0; index < 15; index += 1) await seed(HISTORICAL, `historical-${index}`);
    const allowed = await seed(ALLOWED, 'allowed', 2);
    expect(await extractPendingLearningCandidates(env)).toBe(1);
    expect(await extractPendingLearningCandidates(env)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.prepare('SELECT extraction_status,extraction_attempt_count FROM learning_candidates WHERE id=?')
      .bind(allowed.id).first()).toEqual({ extraction_status: 'SUCCEEDED', extraction_attempt_count: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM learning_candidates WHERE source_conversation_id=? AND extraction_attempt_count=0')
      .bind(HISTORICAL).first()).toEqual({ n: 15 });
  });

  it.each([
    { AI_TEST_SCOPE_ENABLED: 'true', AI_TEST_ALLOWED_CONVERSATION_IDS: '[]' },
    { AI_TEST_SCOPE_ENABLED: 'TRUE', AI_TEST_ALLOWED_CONVERSATION_IDS: JSON.stringify([ALLOWED]) },
    { AI_TEST_SCOPE_ENABLED: 'true', AI_TEST_ALLOWED_CONVERSATION_IDS: '["invalid"]' }
  ])('fails closed for invalid scope %j before any attempt is consumed', async scope => {
    const candidate = await seed(ALLOWED, 'invalid-scope');
    Object.assign(env, scope);
    expect(await extractPendingLearningCandidates(env)).toBe(0);
    expect(await extractLearningCandidate(env, candidate.id)).toEqual(candidate);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves existing unscoped extraction behavior when the deployment switch is off', async () => {
    const historical = await seed(HISTORICAL, 'unscoped');
    env.AI_TEST_SCOPE_ENABLED = 'false';
    expect(await extractPendingLearningCandidates(env)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.prepare('SELECT extraction_attempt_count FROM learning_candidates WHERE id=?')
      .bind(historical.id).first()).toEqual({ extraction_attempt_count: 1 });
  });
});
