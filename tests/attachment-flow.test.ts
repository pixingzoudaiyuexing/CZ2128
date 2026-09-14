import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processChatwootEvent } from '../src/queue/chatwoot-handler';
import { processTelegramEvent } from '../src/queue/telegram-handler';
import * as attachmentRepository from '../src/core/attachment-repository';
import * as conversationService from '../src/core/conversation-service';
import * as outbound from '../src/core/outbound-operations';
import * as aiState from '../src/core/ai-state';

vi.mock('../src/core/attachment-repository', () => ({ enqueueAttachmentJobs: vi.fn() }));
vi.mock('../src/core/conversation-service', () => ({
  getOrCreateConversation: vi.fn(), insertMessage: vi.fn(),
  updateOperatorThreadRef: vi.fn(), updateOperatorThreadStatus: vi.fn()
}));
vi.mock('../src/core/outbound-operations', () => ({
  executeOutboundOperation: vi.fn(), markOutboundOperationFinal: vi.fn()
}));
vi.mock('../src/core/ai-state', () => ({
  pauseOperator: vi.fn(), applyTelegramOperatorAction: vi.fn()
}));

const descriptor = {
  sourceAttachmentRef: 'source', attachmentType: 'document' as const,
  locator: { provider: 'telegram' as const, fileId: 'file' }
};

describe('attachment bridge orchestration', () => {
  let queued: any[];
  let env: any;

  beforeEach(() => {
    vi.resetAllMocks();
    queued = [];
    env = {
      QUEUE: { send: vi.fn(async event => { queued.push(event); }) },
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({
        id: 'conv', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2', operator_thread_ref: '7'
      }) }) }) },
      CHATWOOT_API_URL: 'https://chatwoot.example'
    };
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValue({
      id: 'conv', operator_thread_ref: '7'
    } as any);
    vi.mocked(outbound.executeOutboundOperation).mockResolvedValue({ status: 'SENT', providerMessageRef: 'provider-message' });
    vi.mocked(aiState.applyTelegramOperatorAction).mockResolvedValue('APPLIED');
  });

  it('customer attachment-only queues binary without empty text or AI trigger', async () => {
    await processChatwootEvent({
      version: 1, source: 'chatwoot', type: 'message_created', eventId: 'cw',
      payload: {
        accountRef: '1', conversationRef: '2', customerRef: '3', messageRef: '4',
        actorRole: 'CUSTOMER', attachments: [{ ...descriptor, locator: { provider: 'chatwoot', dataUrl: 'https://chatwoot.example/a' } }]
      }
    }, env);

    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
    expect(attachmentRepository.enqueueAttachmentJobs).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(0);
  });

  it('customer caption is bridged once and AI receives no binary locator', async () => {
    await processChatwootEvent({
      version: 1, source: 'chatwoot', type: 'message_created', eventId: 'cw-caption',
      payload: {
        accountRef: '1', conversationRef: '2', customerRef: '3', messageRef: '5',
        actorRole: 'CUSTOMER', content: 'Caption once',
        attachments: [{ ...descriptor, locator: { provider: 'chatwoot', dataUrl: 'https://chatwoot.example/private' } }]
      }
    }, env);

    expect(conversationService.insertMessage).toHaveBeenCalledTimes(1);
    expect(outbound.executeOutboundOperation).toHaveBeenCalledTimes(1);
    expect(attachmentRepository.enqueueAttachmentJobs).toHaveBeenCalledTimes(1);
    expect(queued).toEqual([{
      version: 1, source: 'internal', type: 'ai_trigger',
      eventId: 'ai_trigger:conv:5', payload: { convId: 'conv', messageId: '5' }
    }]);
    expect(JSON.stringify(queued)).not.toContain('dataUrl');
  });

  it('Telegram attachment-only applies human state and queues binary without empty text', async () => {
    await processTelegramEvent({
      version: 1, source: 'telegram', type: 'message_created', eventId: 'tg',
      payload: { updateRef: '10', messageRef: '11', threadRef: '7', attachments: [descriptor] }
    }, env);

    expect(aiState.applyTelegramOperatorAction).toHaveBeenCalledWith(env, 'conv', '10', 'HUMAN_REPLY');
    expect(conversationService.insertMessage).not.toHaveBeenCalled();
    expect(outbound.executeOutboundOperation).not.toHaveBeenCalled();
    expect(attachmentRepository.enqueueAttachmentJobs).toHaveBeenCalledTimes(1);
  });

  it.each(['/ai_off', '/ai_on'])('treats attachment caption %s as a human reply, not a command', async content => {
    await processTelegramEvent({
      version: 1, source: 'telegram', type: 'message_created', eventId: `tg-${content}`,
      payload: { updateRef: '12', messageRef: '13', threadRef: '7', content, attachments: [descriptor] }
    }, env);

    expect(aiState.applyTelegramOperatorAction).toHaveBeenCalledWith(env, 'conv', '12', 'HUMAN_REPLY');
    expect(aiState.applyTelegramOperatorAction).not.toHaveBeenCalledWith(env, 'conv', '12', 'AI_OFF');
    expect(aiState.applyTelegramOperatorAction).not.toHaveBeenCalledWith(env, 'conv', '12', 'AI_ON');
    expect(attachmentRepository.enqueueAttachmentJobs).toHaveBeenCalledTimes(1);
  });
});
