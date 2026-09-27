import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLearningMaintenance } from '../src/learning/maintenance';
import { SqliteD1 } from './helpers/sqlite-d1';

describe('learning scheduled maintenance bounds', () => {
  const dbs: SqliteD1[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop()!.close();
  });

  it('caps capture at 25 and extraction at 10 while Notion is disabled', async () => {
    const db = new SqliteD1();
    dbs.push(db);
    db.migrateThroughHumanLearning();
    db.exec(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
      VALUES ('conv-1', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1);
    `);
    for (let index = 0; index < 30; index++) {
      const suffix = String(index).padStart(2, '0');
      db.exec(`
        INSERT INTO messages
        (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
        VALUES ('m-${suffix}', 'conv-1', 'crisp', 'op-${suffix}', 'OUTBOUND', 'OPERATOR', 'TEXT',
                'Reusable answer ${suffix}', ${100 + index});
      `);
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const env = { DB: db, NOTION_LEARNING_ENABLED: 'false' } as any;

    const result = await runLearningMaintenance(env);

    expect(result).toEqual({
      captured: 25,
      extracted: 10,
      synced: 0,
      reviews: 0,
      published: 0
    });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM learning_candidates').get()).toEqual({ n: 25 });
    expect(db.database.prepare(
      "SELECT COUNT(*) AS n FROM learning_candidates WHERE extraction_attempt_count = 1"
    ).get()).toEqual({ n: 10 });
    expect(db.database.prepare(
      "SELECT COUNT(*) AS n FROM learning_candidates WHERE extraction_attempt_count = 0"
    ).get()).toEqual({ n: 15 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
