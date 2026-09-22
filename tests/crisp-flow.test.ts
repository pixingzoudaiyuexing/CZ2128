import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processCrispEvent } from '../src/queue/crisp-handler';
import { processTelegramEvent } from '../src/queue/telegram-handler';
import * as conversationService from '../src/core/conversation-service';
import * as outbound from '../src/core/outbound-operations';
import * as aiState from '../src/core/ai-state';

vi.mock('../src/core/conversation-service', () => ({
  getOrCreateConversation: vi.fn(), insertMessage: vi.fn(), updateOperatorThreadRef: vi.fn()
}));
vi.mock('../src/core/outbound-operations', () => ({ executeOutboundOperation: vi.fn() }));
vi.mock('../src/core/ai-state', () => ({ pauseOperator: vi.fn(), applyTelegramOperatorAction: vi.fn() }));
vi.mock('../src/adapters/telegram/api', () => ({
  createTelegramTopic: vi.fn(), sendTelegramMessage: vi.fn()
}));
vi.mock('../src/adapters/crisp/api', () => ({
  createCrispMessage: vi.fn(), createCrispPicker: vi.fn()
}));

describe('Crisp basic bridge orchestration', () => {
  let env: any;

  beforeEach(() => {
    vi.resetAllMocks();
    env = {
      BOT_GROUP_ID: '-100',
      QUEUE: { send: vi.fn() },
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({
        id: 'conv-crisp',
        operator_thread_ref: '77', helpdesk_provider: 'crisp',
        helpdesk_account_ref: 'website-1', helpdesk_conversation_ref: 'session-1'
      }) }) }) },
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    };
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-crisp', operator_thread_ref: '77', helpdesk_provider: 'crisp',
      helpdesk_account_ref: 'website-1', helpdesk_conversation_ref: 'session-1'
    } as any);
    vi.mocked(conversationService.updateOperatorThreadRef).mockResolvedValue('77');
    vi.mocked(outbound.executeOutboundOperation).mockResolvedValue({ status: 'SENT', providerMessageRef: 'p1' } as any);
    vi.mocked(aiState.applyTelegramOperatorAction).mockResolvedValue('APPLIED' as any);
  });

  it('bridges one Crisp customer text and pauses on operator text without misrouting AI to Chatwoot', async () => {
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:1',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '101', actorRole: 'CUSTOMER', content: 'Hello'
      }
    }, env);
    expect(conversationService.insertMessage).toHaveBeenCalledWith(
      env, 'conv-crisp', 'crisp', '101', 'INBOUND', 'CUSTOMER', 'TEXT', 'Hello'
    );
    expect(outbound.executeOutboundOperation).toHaveBeenCalledWith(
      env, 'conv-crisp', 'telegram', 'SEND_MESSAGE', expect.any(Function), 'send_tg_crisp_101', expect.any(Object)
    );
    expect(env.QUEUE.send).not.toHaveBeenCalled();

    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:2',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '102', actorRole: 'OPERATOR', content: 'Human'
      }
    }, env);
    expect(aiState.pauseOperator).toHaveBeenCalledWith(env, 'conv-crisp');
  });

  it('uses Crisp as the Telegram reply destination for Crisp conversations', async () => {
    await processTelegramEvent({
      version: 1, source: 'telegram', type: 'message_created', eventId: 'tg:1',
      payload: { supportProfileVersion: 0, updateRef: '1', messageRef: '9', threadRef: '77', content: 'Reply' }
    }, env);
    expect(outbound.executeOutboundOperation).toHaveBeenCalledWith(
      env, 'conv-crisp', 'crisp', 'SEND_MESSAGE', expect.any(Function), 'send_crisp_0:9', expect.any(Object)
    );
  });

  it('emits configured Crisp welcome and Picker operations only for a new session', async () => {
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValueOnce({
      id: 'new-conv', operator_thread_ref: null
    } as any);
    env.CRISP_WELCOME_TEXT = 'Welcome';
    env.CRISP_MENU_JSON = JSON.stringify({
      picker: { id: 'main', text: 'Choose', choices: [{ value: 'human', label: 'Human' }] }
    });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:3',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-new', customerRef: 'visitor-1',
        messageRef: '103', actorRole: 'CUSTOMER', content: 'Start'
      }
    }, env);
    const operationIds = vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => call[5]);
    expect(operationIds).toContain('crisp_welcome:new-conv');
    expect(operationIds).toContain('crisp_picker:new-conv:main');
  });

  it('pauses AI and notifies the mapped topic for a human handoff option', async () => {
    env.CRISP_MENU_JSON = JSON.stringify({
      options: [{ value: 'human', label: 'Contact human', handoff: true }]
    });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:handoff',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '104', actorRole: 'CUSTOMER', content: 'human', selectionValue: 'human'
      }
    }, env);
    expect(aiState.pauseOperator).toHaveBeenCalledWith(env, 'conv-crisp');
    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => call[5]))
      .toContain('crisp_handoff_tg:crisp:handoff');
  });

  it('sends a preset response and next Picker for a matching option', async () => {
    env.CRISP_MENU_JSON = JSON.stringify({
      options: [{
        value: 'sales', label: 'Sales', response: 'Sales will reply.',
        next: { id: 'sales-next', text: 'Choose sales topic', choices: [{ value: 'pricing', label: 'Pricing' }] }
      }]
    });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:sales',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '105', actorRole: 'CUSTOMER', content: 'sales', selectionValue: 'sales'
      }
    }, env);
    const operationIds = vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => call[5]);
    expect(operationIds).toContain('crisp_option:crisp:sales:response');
    expect(operationIds).toContain('crisp_option:crisp:sales:picker:sales-next');
  });
});
