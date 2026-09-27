import { afterEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import {
  captureLearningCandidateByProviderRef,
  getLearningCandidateBySourceMessage,
  listRecoverableHumanReplies,
  recoverMissingLearningCandidates
} from '../src/learning/repository';

function setup() {
  const db = new SqliteD1();
  db.migrateThroughHumanLearning();
  db.exec(`
    INSERT INTO conversations
    (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
     operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
    VALUES ('conv-1', 'crisp', 'site', 'session', 'customer', 'telegram', '77', 'OPEN', 1, 1, 1);
  `);
  return { db, env: { DB: db } as any };
}

describe('learning candidate capture', () => {
  const dbs: SqliteD1[] = [];
  afterEach(() => {
    while (dbs.length) dbs.pop()!.close();
  });

  it('captures one logical candidate per canonical human message and nearest prior customer question', async () => {
    const { db, env } = setup(); dbs.push(db);
    db.exec(`
      INSERT INTO messages
      (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
      VALUES
      ('msg-q', 'conv-1', 'crisp', 'q1', 'INBOUND', 'CUSTOMER', 'TEXT', 'Email alice@example.com asks order ABCD12345?', 10),
      ('msg-a', 'conv-1', 'crisp', 'a1', 'OUTBOUND', 'OPERATOR', 'TEXT', 'Refunds take three days.', 11);
    `);

    const first = await captureLearningCandidateByProviderRef(env, 'crisp', 'a1');
    const second = await captureLearningCandidateByProviderRef(env, 'crisp', 'a1');
    expect(first?.id).toBe(second?.id);
    expect(first?.source_question_message_id).toBe('msg-q');
    expect(first?.sanitized_question).not.toContain('alice@example.com');
    expect(first?.sanitized_question).not.toContain('ABCD12345');
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM learning_candidates').get()).toEqual({ n: 1 });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM learning_candidate_history').get()).toEqual({ n: 1 });
  });

  it('keeps identical text from different source messages distinct and unique-fences concurrent capture', async () => {
    const { db, env } = setup(); dbs.push(db);
    db.exec(`
      INSERT INTO messages
      (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
      VALUES
      ('msg-a1', 'conv-1', 'crisp', 'same-1', 'OUTBOUND', 'OPERATOR', 'TEXT', 'Same answer', 11),
      ('msg-a2', 'conv-1', 'crisp', 'same-2', 'OUTBOUND', 'OPERATOR', 'TEXT', 'Same answer', 12);
    `);
    const [a, duplicate] = await Promise.all([
      captureLearningCandidateByProviderRef(env, 'crisp', 'same-1'),
      captureLearningCandidateByProviderRef(env, 'crisp', 'same-1')
    ]);
    const b = await captureLearningCandidateByProviderRef(env, 'crisp', 'same-2');
    expect(a?.id).toBe(duplicate?.id);
    expect(b?.id).not.toBe(a?.id);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM learning_candidates').get()).toEqual({ n: 2 });
  });

  it('recovers only customer-visible Telegram replies and Crisp operator replies with a bounded scan', async () => {
    const { db, env } = setup(); dbs.push(db);
    db.exec(`
      INSERT INTO messages
      (id, conversation_id, provider, provider_message_ref, direction, actor_role, message_type, text_content, created_at)
      VALUES
      ('tg-ok', 'conv-1', 'telegram', '1:101', 'INBOUND', 'OPERATOR', 'TEXT', 'Visible reply', 20),
      ('tg-pending', 'conv-1', 'telegram', '1:102', 'INBOUND', 'OPERATOR', 'TEXT', 'Not visible yet', 21),
      ('crisp-ok', 'conv-1', 'crisp', 'op-1', 'OUTBOUND', 'OPERATOR', 'TEXT', 'Already visible', 22);
      INSERT INTO outbound_operations
      (id, conversation_id, destination_provider, operation_type, status, attempt_count,
       reconciliation_status, subject_type, subject_ref, created_at, updated_at)
      VALUES
      ('send_crisp_1:101', 'conv-1', 'crisp', 'SEND_MESSAGE', 'SENT', 1,
       'NOT_REQUIRED', 'MESSAGE', 'telegram:1:101', 20, 20),
      ('send_crisp_1:102', 'conv-1', 'crisp', 'SEND_MESSAGE', 'PENDING', 0,
       'NOT_REQUIRED', 'MESSAGE', 'telegram:1:102', 21, 21);
    `);
    const eligible = await listRecoverableHumanReplies(env, 25);
    expect(eligible.map(row => row.id)).toEqual(['tg-ok', 'crisp-ok']);
    expect(await recoverMissingLearningCandidates(env, 25)).toBe(2);
    expect(await getLearningCandidateBySourceMessage(env, 'tg-ok')).not.toBeNull();
    expect(await getLearningCandidateBySourceMessage(env, 'crisp-ok')).not.toBeNull();
    expect(await getLearningCandidateBySourceMessage(env, 'tg-pending')).toBeNull();
  });
});

