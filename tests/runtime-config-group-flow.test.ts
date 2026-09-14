import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processChatwootEvent } from '../src/queue/chatwoot-handler';
import { migrateTelegramGroup } from '../src/runtime-config/service';
import { RuntimeDb, masterKey } from './helpers/runtime-db';
import * as conversations from '../src/core/conversation-service';
import * as outbound from '../src/core/outbound-operations';
import * as telegram from '../src/adapters/telegram/api';

vi.mock('../src/core/conversation-service', () => ({
  getOrCreateConversation: vi.fn(), insertMessage: vi.fn(), updateOperatorThreadRef: vi.fn(), updateOperatorThreadStatus: vi.fn()
}));
vi.mock('../src/core/outbound-operations', () => ({ executeOutboundOperation: vi.fn() }));
vi.mock('../src/adapters/telegram/api', () => ({
  createTelegramTopic: vi.fn(), sendTelegramMessage: vi.fn(), closeTelegramTopic: vi.fn(), reopenTelegramTopic: vi.fn()
}));

describe('runtime support group migration flow', () => {
  beforeEach(() => vi.resetAllMocks());

  it('creates a new topic in the new group after existing mappings are invalidated', async () => {
    const db = new RuntimeDb();
    const conversation = {
      id: 'conv', operator_channel: 'telegram', operator_thread_ref: 'old-topic',
      operator_thread_status: 'OPEN', version: 1
    };
    db.conversations.push(conversation);
    const env = {
      DB: db, QUEUE: { send: vi.fn() }, RUNTIME_CONFIG_MASTER_KEY: masterKey(),
      BOT_GROUP_ID: '-100999', CHATWOOT_API_URL: 'https://chatwoot.example'
    } as any;
    await migrateTelegramGroup(env, '-1001234', 0, '1', '1');
    expect(conversation.operator_thread_ref).toBeNull();

    vi.mocked(conversations.getOrCreateConversation).mockResolvedValue(conversation as any);
    vi.mocked(conversations.updateOperatorThreadRef).mockResolvedValue('new-topic');
    vi.mocked(telegram.createTelegramTopic).mockResolvedValue({ messageThreadId: 'new-topic' });
    vi.mocked(telegram.sendTelegramMessage).mockResolvedValue({ messageId: 'message' });
    vi.mocked(outbound.executeOutboundOperation).mockImplementation(async (_env, _conv, _provider, type, action) => {
      if (type === 'CREATE_TOPIC') return { status: 'SENT', providerMessageRef: (await action('topic-op', { requestStarted: vi.fn(), responseObserved: vi.fn() })).providerMessageRef };
      return { status: 'SENT', providerMessageRef: (await action('msg-op', { requestStarted: vi.fn(), responseObserved: vi.fn() })).providerMessageRef || 'message' };
    });

    await processChatwootEvent({
      version: 1, source: 'chatwoot', type: 'message_created', eventId: 'event',
      payload: {
        accountRef: '1', conversationRef: '2', customerRef: '3', customerName: 'Synthetic',
        messageRef: '4', content: 'hello', actorRole: 'CUSTOMER'
      }
    }, { ...env, BOT_GROUP_ID: '-1001234' });

    expect(telegram.createTelegramTopic).toHaveBeenCalledWith(expect.anything(), '-1001234', expect.any(String), expect.anything());
    expect(conversations.updateOperatorThreadRef).toHaveBeenCalledWith(expect.anything(), 'conv', 'new-topic');
  });
});
