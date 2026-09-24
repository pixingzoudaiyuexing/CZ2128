import { afterEach, describe, expect, it, vi } from 'vitest';
import { processCrispEvent } from '../src/queue/crisp-handler';
import * as telegramApi from '../src/adapters/telegram/api';
import * as crispApi from '../src/adapters/crisp/api';
import { RUNTIME_CONFIG_KEYS } from '../src/runtime-config/types';
import { SqliteD1 } from './helpers/sqlite-d1';

vi.mock('../src/adapters/telegram/api', () => ({
  createTelegramTopic: vi.fn(),
  sendTelegramMessage: vi.fn()
}));
vi.mock('../src/adapters/crisp/api', () => ({
  createCrispMessage: vi.fn(),
  createCrispPicker: vi.fn()
}));

describe('Crisp keyword real-D1 idempotency', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the Telegram bridge and keyword Crisp reply only once across duplicate event consumption', async () => {
    const db = new SqliteD1();
    db.migrate();
    const now = Math.floor(Date.now() / 1000);
    db.exec(`
      INSERT INTO conversations
        (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
         operator_channel, operator_thread_ref, operator_thread_status, created_at, updated_at, version)
      VALUES
        ('conv-keyword', 'crisp', 'website-1', 'session-1', 'visitor-1',
         'telegram', '77', 'OPEN', ${now}, ${now}, 1);
    `);

    const sources = Object.fromEntries(RUNTIME_CONFIG_KEYS.map(key => [key, 'ENV'])) as any;
    sources.CRISP_KEYWORD_RULES = 'D1';
    const env: any = {
      DB: db,
      BOT_GROUP_ID: '-100',
      QUEUE: { send: vi.fn() },
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key',
      runtimeConfigSnapshot: {
        values: {
          CRISP_KEYWORD_RULES: JSON.stringify({
            version: 1,
            rules: [{
              id: 'kw_0000000000000001',
              keyword: '续费',
              reply: '固定预设回复',
              enabled: true
            }]
          })
        },
        sources,
        versions: { CRISP_KEYWORD_RULES: 1 },
        errors: {},
        overrideCount: 1,
        health: 'AVAILABLE'
      }
    };

    vi.mocked(telegramApi.sendTelegramMessage).mockImplementation(async (...args: any[]) => {
      const lifecycle = args[4];
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(200);
      return { messageId: 'tg-provider-1' } as any;
    });
    vi.mocked(crispApi.createCrispMessage).mockImplementation(async (...args: any[]) => {
      const lifecycle = args[5];
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(200);
      return { messageId: 'crisp-provider-1' } as any;
    });

    const event = {
      version: 1 as const,
      source: 'crisp' as const,
      type: 'message_created' as const,
      eventId: 'crisp:duplicate-keyword',
      payload: {
        websiteRef: 'website-1',
        sessionRef: 'session-1',
        customerRef: 'visitor-1',
        messageRef: 'duplicate-keyword',
        actorRole: 'CUSTOMER' as const,
        content: '续费'
      }
    };

    await processCrispEvent(event, env);
    await processCrispEvent(event, env);

    expect(telegramApi.sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(crispApi.createCrispMessage).toHaveBeenCalledTimes(1);
    expect(env.QUEUE.send).not.toHaveBeenCalled();

    const operations = await db.prepare(
      'SELECT destination_provider, status, subject_ref FROM outbound_operations WHERE conversation_id = ? ORDER BY destination_provider'
    ).bind('conv-keyword').all<any>();
    expect(operations.results).toHaveLength(2);
    expect(operations.results.map(row => row.status)).toEqual(['SENT', 'SENT']);
    expect(operations.results.some(row => row.subject_ref === 'crisp-keyword:v1:kw_0000000000000001')).toBe(true);
    db.close();
  });
});
