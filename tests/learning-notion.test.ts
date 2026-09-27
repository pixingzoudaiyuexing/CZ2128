import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import {
  pullLearningCandidateReview,
  syncLearningCandidateToNotion,
  validateNotionLearningSources
} from '../src/learning/notion';

const candidateSchema = {
  properties: {
    Candidate: { type: 'title' },
    'Candidate ID': { type: 'rich_text' },
    'Captured At': { type: 'date' },
    'D1 Knowledge ID': { type: 'rich_text' },
    'D1 Knowledge Version': { type: 'number' },
    'Proposed Answer': { type: 'rich_text' },
    Question: { type: 'rich_text' },
    'Review Notes': { type: 'rich_text' },
    'Reviewed At': { type: 'date' },
    Risk: { type: 'select' },
    'Source Conversation Ref': { type: 'rich_text' },
    'Source Message Ref': { type: 'rich_text' },
    Status: { type: 'status' },
    'Why Candidate': { type: 'rich_text' }
  }
};

const sourcesSchema = {
  properties: {
    Name: { type: 'title' },
    'Source Ref': { type: 'rich_text' },
    'Source URL': { type: 'url' },
    Type: { type: 'select' },
    Topic: { type: 'rich_text' },
    Status: { type: 'status' },
    Sensitivity: { type: 'select' },
    'Review Notes': { type: 'rich_text' },
    'D1 Knowledge ID': { type: 'rich_text' },
    'D1 Version': { type: 'number' },
    'Last Reviewed': { type: 'date' }
  }
};

function richText(value: string) {
  return { type: 'rich_text', rich_text: [{ plain_text: value, type: 'text', text: { content: value } }] };
}

function title(value: string) {
  return { type: 'title', title: [{ plain_text: value, type: 'text', text: { content: value } }] };
}

function reviewPage(
  status: string,
  overrides: Partial<Record<string, any>> = {},
  id = 'page-0001'
) {
  return {
    object: 'page',
    id,
    in_trash: false,
    last_edited_time: '2026-09-27T08:00:00.000Z',
    properties: {
      Candidate: title('Refund timing'),
      'Candidate ID': richText('lrn_test_0001'),
      Question: richText('How long does a refund take?'),
      'Proposed Answer': richText('Refunds take three business days.'),
      'Review Notes': richText('Reviewed'),
      Status: { type: 'status', status: { name: status } },
      ...overrides
    }
  };
}

function setup() {
  const db = new SqliteD1();
  db.migrateThroughHumanLearning();
  db.exec(`
    INSERT INTO conversations
    (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
     operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
    VALUES ('conv-1', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1);
    INSERT INTO messages
    (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
    VALUES
    ('q', 'conv-1', 'crisp', 'q', 'INBOUND', 'CUSTOMER', 'TEXT', 'How long?', 2),
    ('a', 'conv-1', 'crisp', 'a', 'OUTBOUND', 'OPERATOR', 'TEXT', 'Three days', 3);
    INSERT INTO learning_candidates
    (id, version, source_conversation_id, source_human_message_id, source_question_message_id,
     source_provider, review_status, sanitized_question, sanitized_answer,
     extracted_title, extracted_question, extracted_answer, extraction_reason,
     risk_level, risk_flags_json, extraction_status, extraction_attempt_count,
     notion_sync_status, created_at, updated_at)
    VALUES
    ('lrn_test_0001', 2, 'conv-1', 'a', 'q', 'crisp', 'NEEDS_REVIEW',
     'How long?', 'Three days', 'Refund timing', 'How long does a refund take?',
     'Refunds take three business days.', 'Reusable timing', 'LOW', '[]', 'SUCCEEDED', 1,
     'PENDING', 3, 3);
  `);
  const env = {
    DB: db,
    NOTION_LEARNING_ENABLED: 'true',
    NOTION_API_TOKEN: 'fake-notion-token',
    NOTION_LEARNING_CANDIDATES_DATA_SOURCE_ID: 'candidate_source_001',
    NOTION_KNOWLEDGE_SOURCES_DATA_SOURCE_ID: 'knowledge_source_001'
  } as any;
  return { db, env };
}

function okJson(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('learning Notion adapter', () => {
  const dbs: SqliteD1[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (dbs.length) dbs.pop()!.close();
  });

  it('treats disabled integration as normal and incomplete enabled config as Notion-only failure', async () => {
    const { db, env } = setup(); dbs.push(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    env.NOTION_LEARNING_ENABLED = 'false';
    let candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_sync_status).toBe('DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();

    env.NOTION_LEARNING_ENABLED = 'true';
    env.NOTION_API_TOKEN = '';
    candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_sync_status).toBe('ERROR');
    expect(candidate.notion_error_code).toBe('NOTION_CONFIG_INCOMPLETE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates both configured data-source schemas without using database display names', async () => {
    const { db, env } = setup(); dbs.push(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/data_sources/candidate_source_001')) return okJson(candidateSchema);
      if (url.endsWith('/data_sources/knowledge_source_001')) return okJson(sourcesSchema);
      throw new Error('unexpected request');
    });
    await expect(validateNotionLearningSources(env)).resolves.toBe('READY');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does bounded lookup before create, persists one page identity, and reuses it on retry', async () => {
    const { db, env } = setup(); dbs.push(db);
    let queryCount = 0;
    let createCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.endsWith('/data_sources/candidate_source_001') && method === 'GET') return okJson(candidateSchema);
      if (url.endsWith('/data_sources/candidate_source_001/query')) {
        queryCount += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.page_size).toBe(3);
        expect(body.filter).toEqual({
          property: 'Candidate ID',
          rich_text: { equals: 'lrn_test_0001' }
        });
        return okJson({
          results: queryCount === 1 ? [] : [reviewPage('Needs Review')]
        });
      }
      if (url.endsWith('/pages') && method === 'POST') {
        createCount += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.parent).toEqual({ type: 'data_source_id', data_source_id: 'candidate_source_001' });
        expect(JSON.stringify(body)).not.toContain('fake-notion-token');
        return okJson(reviewPage('Needs Review'));
      }
      if (url.endsWith('/pages/page-0001') && method === 'PATCH') {
        return okJson(reviewPage('Needs Review'));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    let candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_page_id).toBe('page-0001');
    expect(candidate.notion_sync_status).toBe('SYNCED');
    expect(candidate.last_synced_candidate_version).toBe(2);
    candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_page_id).toBe('page-0001');
    expect(createCount).toBe(1);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/query'))).toHaveLength(2);
  });

  it('fails closed on duplicate Candidate ID matches and never creates another page', async () => {
    const { db, env } = setup(); dbs.push(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/data_sources/candidate_source_001')) return okJson(candidateSchema);
      if (url.endsWith('/query')) {
        return okJson({ results: [reviewPage('Needs Review', {}, 'page-0001'), reviewPage('Needs Review', {}, 'page-0002')] });
      }
      throw new Error('create/update must not run');
    });
    const candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_sync_status).toBe('DUPLICATE');
    expect(candidate.notion_error_code).toBe('NOTION_DUPLICATE_CANDIDATE');
    expect(fetchMock.mock.calls.some(call => (call[1]?.method || 'GET') === 'POST' && String(call[0]).endsWith('/pages'))).toBe(false);
  });

  it.each([
    [429, 'NOTION_RATE_LIMITED'],
    [503, 'NOTION_PROVIDER_5XX']
  ])('persists bounded Notion error for HTTP %s', async (status, code) => {
    const { db, env } = setup(); dbs.push(db);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private provider body', { status }));
    const candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_sync_status).toBe('ERROR');
    expect(candidate.notion_error_code).toBe(code);
  });

  it('persists timeout and later converges by lookup without duplicate creation', async () => {
    const { db, env } = setup(); dbs.push(db);
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      })
    );
    const pending = syncLearningCandidateToNotion(env, 'lrn_test_0001');
    await vi.advanceTimersByTimeAsync(10001);
    let candidate = await pending;
    expect(candidate.notion_error_code).toBe('NOTION_TIMEOUT');

    vi.useRealTimers();
    fetchMock.mockRestore();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.endsWith('/data_sources/candidate_source_001') && method === 'GET') return okJson(candidateSchema);
      if (url.endsWith('/query')) return okJson({ results: [reviewPage('Needs Review')] });
      if (url.endsWith('/pages/page-0001') && method === 'PATCH') return okJson(reviewPage('Needs Review'));
      throw new Error('unexpected request');
    });
    candidate = await syncLearningCandidateToNotion(env, 'lrn_test_0001');
    expect(candidate.notion_sync_status).toBe('SYNCED');
    expect(candidate.notion_page_id).toBe('page-0001');
  });
});

describe('learning Notion review pull', () => {
  const dbs: SqliteD1[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop()!.close();
  });

  function synced() {
    const value = setup(); dbs.push(value.db);
    value.db.exec(`
      UPDATE learning_candidates
         SET notion_page_id='page-0001', notion_sync_status='SYNCED',
             last_synced_candidate_version=2
       WHERE id='lrn_test_0001';
    `);
    return value;
  }

  it('applies safe Approved edits with a version-CAS fence', async () => {
    const { env } = synced();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(reviewPage('Approved')));
    const candidate = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(candidate.review_status).toBe('APPROVED');
    expect(candidate.version).toBe(3);
    expect(candidate.review_notes).toBe('Reviewed');
  });

  it('makes Rejected terminal for the reviewed candidate version', async () => {
    const { env } = synced();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(reviewPage('Rejected')));
    const candidate = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(candidate.review_status).toBe('REJECTED');
    expect(candidate.version).toBe(3);
    const again = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(again.review_status).toBe('REJECTED');
  });

  it('rejects stale reviews before any Notion read', async () => {
    const { db, env } = synced();
    db.exec("UPDATE learning_candidates SET version=3, notion_sync_status='SYNCED' WHERE id='lrn_test_0001'");
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const candidate = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(candidate.review_status).toBe('NEEDS_REVIEW');
    expect(candidate.notion_sync_status).toBe('PENDING');
    expect(candidate.notion_error_code).toBe('NOTION_STALE_REVIEW');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on wrong Candidate ID or page identity', async () => {
    const { env } = synced();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(okJson(reviewPage('Approved', {
      'Candidate ID': richText('wrong-id')
    })));
    let candidate = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(candidate.notion_error_code).toBe('NOTION_REVIEW_IDENTITY_MISMATCH');

    const { db: db2, env: env2 } = setup(); dbs.push(db2);
    db2.exec("UPDATE learning_candidates SET notion_page_id='page-0001', notion_sync_status='SYNCED', last_synced_candidate_version=2 WHERE id='lrn_test_0001'");
    fetchMock.mockResolvedValueOnce(okJson(reviewPage('Approved', {}, 'page-other')));
    candidate = await pullLearningCandidateReview(env2, 'lrn_test_0001');
    expect(candidate.notion_error_code).toBe('NOTION_REVIEW_IDENTITY_MISMATCH');
  });

  it('re-scans reviewer edits and refuses high-risk Approved content', async () => {
    const { env } = synced();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(reviewPage('Approved', {
      'Proposed Answer': richText('Use 123456789:AAExampleTelegramToken_abcdefghijklmnop')
    })));
    const candidate = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(candidate.review_status).toBe('NEEDS_REVIEW');
    expect(candidate.risk_level).toBe('HIGH');
    expect(candidate.extracted_answer).toContain('[REDACTED_TELEGRAM_TOKEN]');
    expect(candidate.notion_sync_status).toBe('PENDING');
    expect(candidate.notion_error_code).toBe('APPROVED_CONTENT_UNSAFE');
  });

  it('keeps D1 Published authoritative when Notion Published writeback fails, then converges later', async () => {
    const { db, env } = synced();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(reviewPage('Approved')));
    const reviewed = await pullLearningCandidateReview(env, 'lrn_test_0001');
    expect(reviewed.review_status).toBe('APPROVED');

    const { publishApprovedLearningCandidate } = await import('../src/learning/publish');
    const published = await publishApprovedLearningCandidate(env, reviewed.id);
    expect(published.review_status).toBe('PUBLISHED');
    expect(published.published_knowledge_id).toBeTruthy();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporary outage', { status: 503 }));
    let afterWriteback = await syncLearningCandidateToNotion(env, published.id);
    expect(afterWriteback.review_status).toBe('PUBLISHED');
    expect(afterWriteback.published_knowledge_id).toBe(published.published_knowledge_id);
    expect(afterWriteback.notion_sync_status).toBe('ERROR');
    expect(afterWriteback.notion_error_code).toBe('NOTION_PROVIDER_5XX');

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.endsWith('/data_sources/candidate_source_001') && method === 'GET') return okJson(candidateSchema);
      if (url.endsWith('/query')) return okJson({ results: [reviewPage('Published')] });
      if (url.endsWith('/pages/page-0001') && method === 'PATCH') return okJson(reviewPage('Published'));
      throw new Error('unexpected request');
    });
    afterWriteback = await syncLearningCandidateToNotion(env, published.id);
    expect(afterWriteback.review_status).toBe('PUBLISHED');
    expect(afterWriteback.notion_sync_status).toBe('SYNCED');
  });
});

