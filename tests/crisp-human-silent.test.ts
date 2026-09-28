import { afterEach, describe, expect, it, vi } from 'vitest';
import { processCrispEvent } from '../src/queue/crisp-handler';
import { SqliteD1 } from './helpers/sqlite-d1';

function makeEnv(db: SqliteD1) {
  return {
    DB: db as any,
    QUEUE: { send: vi.fn() } as any,
    CRISP_API_IDENTIFIER: 'identifier',
    CRISP_API_KEY: 'key',
    CRISP_WEBSITE_ID: 'website-1',
    TELEGRAM_BOT_TOKEN: '123456:telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
    TELEGRAM_SECRET_PATH: 'telegram-path',
    BOT_GROUP_ID: '-1001',
    ATTACHMENTS_BUCKET: {} as any,
    DLQ_QUARANTINE: {} as any
  } as any;
}

function seedConversation(db: SqliteD1, id: string, sessionRef: string): void {
  db.exec(`
    INSERT INTO conversations (
      id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref,
      customer_ref, operator_channel, operator_thread_ref, operator_thread_status,
      created_at, updated_at
    ) VALUES (
      '${id}', 'crisp', 'website-1', '${sessionRef}',
      'visitor-1', 'telegram', '77', 'OPEN', 1, 1
    )
  `);
}

function telegramBodies(fetchMock: any): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call: any[]) => String(call[0]).includes('api.telegram.org'))
    .map((call: any[]) => JSON.parse(String(call[1]?.body)));
}

describe('v1.0.1 Crisp human Telegram silence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('freezes Crisp operator provenance as silent and emits disable_notification=true on final sendMessage', async () => {
    const db = new SqliteD1();
    db.migrateThroughHumanLearning();
    seedConversation(db, 'conv-human', 'session-human');
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), { status: 200 })
    );

    const event = {
      version: 1 as const,
      source: 'crisp' as const,
      type: 'message_created' as const,
      eventId: 'crisp:human:1',
      payload: {
        websiteRef: 'website-1',
        sessionRef: 'session-human',
        customerRef: 'visitor-1',
        messageRef: 'human-1',
        actorRole: 'OPERATOR' as const,
        content: 'Human reply'
      }
    };

    await processCrispEvent(event, env);
    await processCrispEvent(event, env);

    const bodies = telegramBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      chat_id: '-1001',
      message_thread_id: '77',
      text: 'Human reply',
      disable_notification: true
    });

    const operation = await db.prepare(
      'SELECT request_options_json, status FROM outbound_operations WHERE id = ?'
    ).bind('send_tg_crisp_human-1').first<any>();
    expect(operation.status).toBe('SENT');
    expect(JSON.parse(operation.request_options_json)).toEqual({
      version: 1,
      disableNotification: true
    });

    const message = await db.prepare(
      'SELECT actor_role, direction FROM messages WHERE provider = ? AND provider_message_ref = ?'
    ).bind('crisp', 'human-1').first<any>();
    expect(message).toEqual({ actor_role: 'OPERATOR', direction: 'OUTBOUND' });
    db.close();
  });

  it('does not force silent delivery on ordinary Crisp customer ingress', async () => {
    const db = new SqliteD1();
    db.migrateThroughHumanLearning();
    seedConversation(db, 'conv-customer', 'session-customer');
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 502 } }), { status: 200 })
    );

    await processCrispEvent({
      version: 1,
      source: 'crisp',
      type: 'message_created',
      eventId: 'crisp:customer:1',
      payload: {
        websiteRef: 'website-1',
        sessionRef: 'session-customer',
        customerRef: 'visitor-1',
        messageRef: 'customer-1',
        actorRole: 'CUSTOMER',
        content: 'Customer message'
      }
    }, env);

    const bodies = telegramBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      chat_id: '-1001',
      message_thread_id: '77',
      text: 'Customer message'
    });
    expect(bodies[0]).not.toHaveProperty('disable_notification');

    const operation = await db.prepare(
      'SELECT request_options_json FROM outbound_operations WHERE id = ?'
    ).bind('send_tg_crisp_customer-1').first<any>();
    expect(JSON.parse(operation.request_options_json)).toEqual({
      version: 1,
      disableNotification: false,
      controls: 'AI_TOGGLE_V1'
    });
    db.close();
  });
});
