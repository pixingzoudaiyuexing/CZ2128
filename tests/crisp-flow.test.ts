import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processCrispEvent } from '../src/queue/crisp-handler';
import { processTelegramEvent } from '../src/queue/telegram-handler';
import * as conversationService from '../src/core/conversation-service';
import * as outbound from '../src/core/outbound-operations';
import * as aiState from '../src/core/ai-state';
import * as attachmentRepository from '../src/core/attachment-repository';
import { crispFingerprintForOperation } from '../src/adapters/crisp/fingerprint';

vi.mock('../src/core/conversation-service', () => ({
  getOrCreateConversation: vi.fn(), insertMessage: vi.fn(), updateOperatorThreadRef: vi.fn()
}));
vi.mock('../src/core/outbound-operations', () => ({ executeOutboundOperation: vi.fn(), getOutboundOperation: vi.fn() }));
vi.mock('../src/core/attachment-repository', () => ({ enqueueAttachmentJobs: vi.fn() }));
vi.mock('../src/core/ai-state', () => ({
  checkAutoResume: vi.fn(),
  pauseOperator: vi.fn(),
  pauseOperatorForCrispSelection: vi.fn(),
  applyTelegramOperatorAction: vi.fn()
}));
vi.mock('../src/adapters/telegram/api', () => ({
  createTelegramTopic: vi.fn(), sendTelegramMessage: vi.fn()
}));
vi.mock('../src/adapters/crisp/api', () => ({
  createCrispMessage: vi.fn(), createCrispPicker: vi.fn()
}));

describe('Crisp basic bridge orchestration', () => {
  let env: any;

  function echoDb(sent: { id: string } | null = null, inFlight: Array<{ id: string }> = []) {
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.includes('provider_message_ref = ?')) return sent;
            if (sql.includes('FROM conversations WHERE operator_channel = ? AND operator_thread_ref = ?')) {
              return {
                id: 'conv-crisp',
                operator_thread_ref: '77',
                helpdesk_provider: 'crisp',
                helpdesk_account_ref: 'website-1',
                helpdesk_conversation_ref: 'session-1'
              };
            }
            return null;
          },
          all: async () => ({ results: sql.includes("status IN ('SENDING', 'AMBIGUOUS')") ? inFlight : [] })
        })
      })
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    env = {
      BOT_GROUP_ID: '-100',
      QUEUE: { send: vi.fn() },
      DB: echoDb(),
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    };
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-crisp', operator_thread_ref: '77', helpdesk_provider: 'crisp',
      helpdesk_account_ref: 'website-1', helpdesk_conversation_ref: 'session-1'
    } as any);
    vi.mocked(conversationService.updateOperatorThreadRef).mockResolvedValue('77');
    vi.mocked(outbound.executeOutboundOperation).mockResolvedValue({ status: 'SENT', providerMessageRef: 'p1' } as any);
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue(null);
    vi.mocked(aiState.applyTelegramOperatorAction).mockResolvedValue('APPLIED' as any);
    vi.mocked(aiState.checkAutoResume).mockResolvedValue(true);
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

  it('enqueues one stable AI trigger for configured ordinary Crisp customer text', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'ai-key';
    env.AI_MODEL = 'model';
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:ai-customer',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: 'ai-message-1', actorRole: 'CUSTOMER', content: 'Question for AI'
      }
    }, env);

    expect(env.QUEUE.send).toHaveBeenCalledTimes(1);
    expect(env.QUEUE.send).toHaveBeenCalledWith({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_trigger:conv-crisp:ai-message-1',
      payload: { convId: 'conv-crisp', messageId: 'ai-message-1' }
    });
  });

  it('does not enqueue AI while the durable conversation remains operator-paused', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'ai-key';
    env.AI_MODEL = 'model';
    vi.mocked(aiState.checkAutoResume).mockResolvedValue(false);

    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:paused-customer',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: 'paused-message-1', actorRole: 'CUSTOMER', content: 'Still need help'
      }
    }, env);

    expect(aiState.checkAutoResume).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id: 'conv-crisp', helpdesk_provider: 'crisp' })
    );
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('suppresses a Crisp operator echo only when durable outbound evidence matches', async () => {
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue({
      id: 'send_crisp_0:9', conversation_id: 'conv-crisp', destination_provider: 'crisp',
      operation_type: 'SEND_MESSAGE', status: 'SENT', provider_message_ref: 'provider-99', request_started_at: 100
    } as any);
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:echo',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: 'provider-99', actorRole: 'OPERATOR', content: 'Reply', automated: true,
        operationMarker: 'send_crisp_0:9'
      }
    }, env);
    expect(aiState.pauseOperator).not.toHaveBeenCalled();
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
  });

  it('suppresses an in-flight Crisp echo by its exact durable operation marker', async () => {
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue({
      id: 'send_crisp_0:9', conversation_id: 'conv-crisp', destination_provider: 'crisp',
      operation_type: 'SEND_MESSAGE', status: 'SENDING', provider_message_ref: null, request_started_at: 100
    } as any);
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:race',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: 'provider-race', actorRole: 'OPERATOR', content: 'Reply', automated: true,
        operationMarker: 'send_crisp_0:9'
      }
    }, env);
    expect(aiState.pauseOperator).not.toHaveBeenCalled();
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
  });

  it('suppresses a sent Crisp echo by exact durable provider fingerprint without custom properties', async () => {
    env.DB = echoDb({ id: 'send_crisp_0:9' });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:fingerprint-sent',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: 'provider-99', actorRole: 'OPERATOR', content: 'Reply', automated: true
      }
    }, env);
    expect(aiState.pauseOperator).not.toHaveBeenCalled();
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
  });

  it('suppresses an in-flight Crisp echo by deterministic request fingerprint before result persistence', async () => {
    const operationId = 'send_crisp_0:9';
    const fingerprint = String(await crispFingerprintForOperation(operationId));
    env.DB = echoDb(null, [{ id: operationId }]);
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:fingerprint-race',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: fingerprint, actorRole: 'OPERATOR', content: 'Reply', automated: true
      }
    }, env);
    expect(aiState.pauseOperator).not.toHaveBeenCalled();
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
  });

  it('does not suppress an automated operator message when deterministic fingerprint evidence does not match', async () => {
    env.DB = echoDb(null, [{ id: 'different-operation' }]);
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:fingerprint-no-match',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '12345', actorRole: 'OPERATOR', content: 'Third party automation', automated: true
      }
    }, env);
    expect(aiState.pauseOperator).toHaveBeenCalledWith(env, 'conv-crisp');
    expect(conversationService.insertMessage).toHaveBeenCalled();
  });

  it('does not suppress third-party automation or human operator messages without matching durable evidence', async () => {
    for (const testCase of [
      { payload: { messageRef: 'third-party', automated: true, operationMarker: 'external_1' }, operation: null },
      {
        payload: { messageRef: 'wrong-fingerprint', automated: true, operationMarker: 'send_crisp_0:9' },
        operation: {
          id: 'send_crisp_0:9', conversation_id: 'conv-crisp', destination_provider: 'crisp',
          operation_type: 'SEND_MESSAGE', status: 'SENT', provider_message_ref: 'different-provider-ref', request_started_at: 100
        }
      },
      {
        payload: { messageRef: 'marker-only', operationMarker: 'send_crisp_0:9' },
        operation: {
          id: 'send_crisp_0:9', conversation_id: 'conv-crisp', destination_provider: 'crisp',
          operation_type: 'SEND_MESSAGE', status: 'SENT', provider_message_ref: 'marker-only', request_started_at: 100
        }
      },
      { payload: { messageRef: 'human' }, operation: null }
    ]) {
      const payload = testCase.payload;
      vi.clearAllMocks();
      vi.mocked(conversationService.getOrCreateConversation).mockResolvedValue({
        id: 'conv-crisp', operator_thread_ref: '77', helpdesk_provider: 'crisp',
        helpdesk_account_ref: 'website-1', helpdesk_conversation_ref: 'session-1'
      } as any);
      vi.mocked(outbound.getOutboundOperation).mockResolvedValue(testCase.operation as any);
      vi.mocked(outbound.executeOutboundOperation).mockResolvedValue({ status: 'SENT', providerMessageRef: 'p1' } as any);
      await processCrispEvent({
        version: 1, source: 'crisp', type: 'message_created', eventId: `crisp:${payload.messageRef}`,
        payload: {
          websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
          actorRole: 'OPERATOR', content: 'Legitimate operator message', ...payload
        }
      }, env);
      expect(aiState.pauseOperator).toHaveBeenCalledWith(env, 'conv-crisp');
      expect(conversationService.insertMessage).toHaveBeenCalled();
      expect(outbound.executeOutboundOperation).toHaveBeenCalledWith(
        env, 'conv-crisp', 'telegram', 'SEND_MESSAGE', expect.any(Function),
        `send_tg_crisp_${payload.messageRef}`, expect.any(Object)
      );
    }
  });

  it('queues a Crisp customer image for Telegram without creating text or AI work', async () => {
    const attachment = {
      sourceAttachmentRef: 'file', attachmentType: 'photo' as const, originalFilename: 'x.png',
      mimeType: 'image/png', locator: { provider: 'crisp' as const, dataUrl: 'https://storage.crisp.chat/x.png' }
    };
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:image',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: 'image-1', actorRole: 'CUSTOMER', attachments: [attachment]
      }
    }, env);
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(attachmentRepository.enqueueAttachmentJobs).toHaveBeenCalledWith(
      env, expect.any(Object), 'conv-crisp', 'crisp', 'image-1', [attachment], 'telegram'
    );
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('suppresses a Crisp SEND_ATTACHMENT echo by exact durable numeric fingerprint evidence', async () => {
    env.DB = echoDb({ id: 'attachment_crisp:att' });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:attachment-echo',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '777', actorRole: 'OPERATOR', automated: true,
        content: '![Image](https://worker.example/attachments/token/inline)'
      }
    }, env);
    expect(aiState.pauseOperator).not.toHaveBeenCalled();
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
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
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'ai-key';
    env.AI_MODEL = 'model';
    env.CRISP_MENU_JSON = JSON.stringify({
      options: [{ pickerId: 'main', value: 'human', label: 'Contact human', handoff: true }]
    });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:handoff',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '104', actorRole: 'CUSTOMER', content: 'Contact human',
        selection: { pickerId: 'main', pickerMessageRef: 'picker-1', value: 'human', label: 'Contact human' }
      }
    }, env);
    expect(aiState.pauseOperatorForCrispSelection).toHaveBeenCalledWith(env, 'conv-crisp', 'crisp:handoff');
    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => call[5]))
      .toContain('crisp_handoff_tg:crisp:handoff');
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('sends a preset response and next Picker for a matching option', async () => {
    env.CRISP_MENU_JSON = JSON.stringify({
      options: [{
        pickerId: 'main', value: 'sales', label: 'Sales', response: 'Sales will reply.',
        next: { id: 'sales-next', text: 'Choose sales topic', choices: [{ value: 'pricing', label: 'Pricing' }] }
      }]
    });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:sales',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '105', actorRole: 'CUSTOMER', content: 'Sales',
        selection: { pickerId: 'main', pickerMessageRef: 'picker-2', value: 'sales', label: 'Sales' }
      }
    }, env);
    const operationIds = vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => call[5]);
    expect(operationIds).toContain('crisp_option:crisp:sales:response');
    expect(operationIds).toContain('crisp_option:crisp:sales:picker:sales-next');
  });

  it('does not treat ordinary text matching an option value as a Picker selection', async () => {
    env.CRISP_MENU_JSON = JSON.stringify({
      options: [{ pickerId: 'main', value: 'human', label: 'Contact human', handoff: true }]
    });
    await processCrispEvent({
      version: 1, source: 'crisp', type: 'message_created', eventId: 'crisp:text-human',
      payload: {
        websiteRef: 'website-1', sessionRef: 'session-1', customerRef: 'visitor-1',
        messageRef: '106', actorRole: 'CUSTOMER', content: 'human'
      }
    }, env);
    expect(aiState.pauseOperatorForCrispSelection).not.toHaveBeenCalled();
    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => call[5]))
      .not.toContain('crisp_handoff_tg:crisp:text-human');
  });
});
