import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processTelegramEvent } from '../src/queue/telegram-handler';
import * as aiState from '../src/core/ai-state';
import * as uploadService from '../src/uploads/service';

vi.mock('../src/core/ai-state', () => ({
  applyTelegramOperatorAction: vi.fn()
}));

vi.mock('../src/uploads/service', () => ({
  createAndSendUploadInvite: vi.fn(),
  revokeUploadInviteFromTelegram: vi.fn()
}));

function event(command: '/upload' | '/upload_revoke', operatorRef = '42') {
  return {
    version: 1 as const,
    source: 'telegram' as const,
    type: 'message_created' as const,
    eventId: 'tg:0:100',
    payload: {
      supportProfileVersion: 0,
      updateRef: '100',
      messageRef: '101',
      threadRef: '77',
      operatorRef,
      publicOrigin: 'https://worker.example',
      content: command
    }
  };
}

function env(allowed: string | undefined) {
  return {
    ADMIN_TELEGRAM_USER_IDS: allowed,
    BOT_GROUP_ID: '-100',
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: 'conv',
            helpdesk_provider: 'crisp',
            helpdesk_account_ref: 'site',
            helpdesk_conversation_ref: 'session',
            operator_thread_ref: '77',
            operator_thread_status: 'OPEN'
          })
        })
      })
    }
  } as any;
}

describe('Stage B upload command authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(aiState.applyTelegramOperatorAction).mockResolvedValue('APPLIED' as any);
    vi.mocked(uploadService.createAndSendUploadInvite).mockResolvedValue('SENT');
    vi.mocked(uploadService.revokeUploadInviteFromTelegram).mockResolvedValue();
  });

  it('allows an already-authorized Telegram admin to create an invite in the mapped Topic', async () => {
    const testEnv = env('42,43');
    await processTelegramEvent(event('/upload', '42'), testEnv);

    expect(aiState.applyTelegramOperatorAction).toHaveBeenCalledWith(
      testEnv, 'conv', 0, '100', 'HUMAN_REPLY'
    );
    expect(uploadService.createAndSendUploadInvite).toHaveBeenCalledOnce();
    expect(uploadService.createAndSendUploadInvite).toHaveBeenCalledWith(
      testEnv,
      expect.objectContaining({ id: 'conv', helpdesk_provider: 'crisp', operator_thread_ref: '77' }),
      expect.objectContaining({
        operatorRef: '42',
        supportProfileVersion: 0,
        updateRef: '100',
        threadRef: '77',
        publicOrigin: 'https://worker.example'
      })
    );
  });

  it('allows an authorized operator to revoke the current invite', async () => {
    const testEnv = env('42,43');
    await processTelegramEvent(event('/upload_revoke', '43'), testEnv);

    expect(uploadService.revokeUploadInviteFromTelegram).toHaveBeenCalledOnce();
    expect(uploadService.createAndSendUploadInvite).not.toHaveBeenCalled();
  });

  it('fails closed for a group member who is not in the trusted Telegram admin allowlist', async () => {
    const testEnv = env('42,43');
    await processTelegramEvent(event('/upload', '99'), testEnv);

    expect(aiState.applyTelegramOperatorAction).not.toHaveBeenCalled();
    expect(uploadService.createAndSendUploadInvite).not.toHaveBeenCalled();
    expect(uploadService.revokeUploadInviteFromTelegram).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted allowlist is missing or malformed', async () => {
    for (const allowed of [undefined, '', 'bad,0,-1']) {
      const testEnv = env(allowed);
      await processTelegramEvent(event('/upload', '42'), testEnv);
    }

    expect(aiState.applyTelegramOperatorAction).not.toHaveBeenCalled();
    expect(uploadService.createAndSendUploadInvite).not.toHaveBeenCalled();
  });
});
