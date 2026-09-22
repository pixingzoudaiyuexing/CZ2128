import { afterEach, describe, expect, it, vi } from 'vitest';
import { crispMessageEventId } from '../src/adapters/crisp/webhook';
import { normalizeCrispEvent } from '../src/index';
import { handleQueueEvent } from '../src/queue/consumer';
import { SqliteD1 } from './helpers/sqlite-d1';

describe('Crisp Picker idempotency on real local D1', () => {
  const databases: SqliteD1[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) db.close();
  });

  it('reclaims a failed Queue receipt without repeating handoff state or visible sends', async () => {
    const db = new SqliteD1();
    db.migrate();
    databases.push(db);
    db.exec(`
      INSERT INTO conversations
      (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
       operator_channel, operator_thread_ref, ai_mode, ai_handoff_epoch,
       created_at, updated_at, version)
      VALUES ('crisp-conv', 'crisp', 'website-1', 'session-1', 'visitor-1',
              'telegram', '77', 'ENABLED', 0, 1, 1, 1);
    `);

    let failAfterFirstHandoff = true;
    const env = {
      DB: db as any,
      QUEUE: { send: vi.fn() },
      BOT_GROUP_ID: '-100',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      CRISP_MENU_JSON: JSON.stringify({
        options: [{ pickerId: 'main', value: 'human', label: 'Contact human', handoff: true }]
      }),
      hooks: {
        afterCrispHandoffStateApplied: vi.fn(async () => {
          if (failAfterFirstHandoff) {
            failAfterFirstHandoff = false;
            throw new Error('synthetic post-handoff failure');
          }
        })
      }
    } as any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: fetchMock.mock.calls.length } }), { status: 200 })
    );

    const firstPayload = {
      event: 'message:updated',
      data: {
        website_id: 'website-1', session_id: 'session-1', fingerprint: 501, timestamp: 10,
        content: { id: 'main', choices: [{ value: 'human', label: 'Contact human', selected: true }] }
      }
    };
    const duplicatePayload = {
      ...firstPayload,
      data: { ...firstPayload.data, timestamp: 11, unrelated: 'different raw body' }
    };
    const firstEventId = await crispMessageEventId(firstPayload, JSON.stringify(firstPayload));
    const duplicateEventId = await crispMessageEventId(duplicatePayload, JSON.stringify(duplicatePayload));
    expect(duplicateEventId).toBe(firstEventId);
    const firstEvent = normalizeCrispEvent(firstPayload, firstEventId, 'website-1');
    const duplicateEvent = normalizeCrispEvent(duplicatePayload, duplicateEventId, 'website-1');
    if (!firstEvent || !duplicateEvent) throw new Error('Expected valid Crisp Picker selection events');

    await expect(handleQueueEvent(firstEvent, env)).rejects.toThrow('synthetic post-handoff failure');
    expect(await db.prepare(
      `SELECT ai_mode, ai_handoff_epoch, version FROM conversations WHERE id = 'crisp-conv'`
    ).first()).toEqual({ ai_mode: 'PAUSED_OPERATOR', ai_handoff_epoch: 1, version: 2 });
    expect(await db.prepare(
      `SELECT status, attempt_count FROM event_receipts WHERE source = 'crisp' AND source_event_ref = ?`
    ).bind(firstEventId).first()).toEqual({ status: 'FAILED', attempt_count: 1 });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'CRISP_PICKER_HANDOFF_APPLIED'`
    ).first<{ count: number }>())?.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await handleQueueEvent(duplicateEvent, env);
    await handleQueueEvent(firstEvent, env);

    expect(await db.prepare(
      `SELECT ai_mode, ai_handoff_epoch, version FROM conversations WHERE id = 'crisp-conv'`
    ).first()).toEqual({ ai_mode: 'PAUSED_OPERATOR', ai_handoff_epoch: 1, version: 2 });
    expect(await db.prepare(
      `SELECT status, attempt_count FROM event_receipts WHERE source = 'crisp' AND source_event_ref = ?`
    ).bind(firstEventId).first()).toEqual({ status: 'PROCESSED', attempt_count: 2 });
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM reliability_audit WHERE action = 'CRISP_PICKER_HANDOFF_APPLIED'`
    ).first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM outbound_operations WHERE status = 'SENT'`
    ).first<{ count: number }>())?.count).toBe(2);
    expect((await db.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE provider = 'crisp'`
    ).first<{ count: number }>())?.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
