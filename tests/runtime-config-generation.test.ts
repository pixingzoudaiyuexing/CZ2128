import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTelegramOperatorAction } from '../src/core/ai-state';
import { RetryableProcessingError } from '../src/core/errors';
import { TelegramMessageEvent } from '../src/core/events';
import { handleQueueEvent } from '../src/queue/consumer';
import * as telegramHandler from '../src/queue/telegram-handler';

vi.mock('../src/queue/telegram-handler', () => ({ processTelegramEvent: vi.fn() }));

class ReceiptDb {
  receipts: any[] = [];
  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      first: async () => this.receipts.find(row => row.source === params[0] && row.source_event_ref === params[1]) || null,
      run: async () => {
        let changes = 0;
        if (query.includes('INSERT INTO event_receipts')) {
          if (!this.receipts.some(row => row.source === params[0] && row.source_event_ref === params[1])) {
            this.receipts.push({
              source: params[0], source_event_ref: params[1], status: 'PROCESSING',
              attempt_count: 1, lease_until: params[2], claim_token: params[3]
            });
            changes = 1;
          }
        } else if (query.includes("SET status = 'PROCESSED'")) {
          const row = this.receipts.find(item =>
            item.source === params[1] && item.source_event_ref === params[2] && item.claim_token === params[3]);
          if (row) { row.status = 'PROCESSED'; row.claim_token = null; changes = 1; }
        } else if (query.includes("SET status = 'FAILED'")) {
          changes = 1;
        }
        return { meta: { changes } };
      }
    };
    return statement;
  }
}

class OrderingDb {
  conversation = {
    id: 'conv', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
    last_telegram_operator_profile_version: 1,
    last_telegram_operator_update_id: 900000
  } as any;
  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      run: async () => {
        const human = query.includes('last_operator_reply_at = ?');
        const [replyAt, profile, update, updatedAt, id, expectedProfile, _sameProfile, expectedUpdate] = human
          ? params
          : [undefined, ...params];
        const row = this.conversation;
        const storedProfile = Number(row.last_telegram_operator_profile_version || 0);
        const allowed = row.id === id && (
          storedProfile < Number(expectedProfile) ||
          (storedProfile === Number(expectedProfile) && Number(row.last_telegram_operator_update_id) < Number(expectedUpdate))
        );
        if (!allowed) return { meta: { changes: 0 } };
        row.last_telegram_operator_profile_version = profile;
        row.last_telegram_operator_update_id = update;
        row.updated_at = updatedAt;
        if (human) {
          row.ai_mode = row.ai_mode === 'PAUSED_MANUAL' ? row.ai_mode : 'PAUSED_OPERATOR';
          row.last_operator_reply_at = replyAt;
          row.ai_handoff_epoch += 1;
        } else if (query.includes("PAUSED_MANUAL")) {
          row.ai_mode = 'PAUSED_MANUAL';
          row.ai_handoff_epoch += 1;
        } else {
          row.ai_mode = 'ENABLED';
        }
        return { meta: { changes: 1 } };
      },
      first: async () => ({
        last_telegram_operator_profile_version: this.conversation.last_telegram_operator_profile_version,
        last_telegram_operator_update_id: this.conversation.last_telegram_operator_update_id
      })
    };
    return statement;
  }
}

function telegramEvent(profile: number, update: number, content = 'human', attachments?: any[]): TelegramMessageEvent {
  return {
    version: 1,
    source: 'telegram',
    type: 'message_created',
    eventId: `tg:${profile}:${update}`,
    payload: {
      supportProfileVersion: profile,
      updateRef: String(update),
      messageRef: String(update),
      threadRef: '7',
      content,
      ...(attachments ? { attachments } : {})
    }
  };
}

function queueEnv(db: ReceiptDb, currentProfile: number) {
  return {
    DB: db,
    runtimeConfigSnapshot: {
      values: {}, sources: {}, versions: { TELEGRAM_SUPPORT_PROFILE: currentProfile },
      errors: {}, overrideCount: 1, health: 'AVAILABLE'
    }
  } as any;
}

describe('Support Bot generation fencing', () => {
  beforeEach(() => vi.resetAllMocks());

  it('keeps the same Telegram update ID distinct across support generations', async () => {
    const db = new ReceiptDb();
    await handleQueueEvent(telegramEvent(1, 100), queueEnv(db, 1));
    await handleQueueEvent(telegramEvent(2, 100), queueEnv(db, 2));
    expect(db.receipts.map(row => row.source_event_ref)).toEqual(['tg:1:100', 'tg:2:100']);
    expect(telegramHandler.processTelegramEvent).toHaveBeenCalledTimes(2);
  });

  it('applies a low update ID from a newer generation', async () => {
    const db = new OrderingDb();
    const result = await applyTelegramOperatorAction({ DB: db } as any, 'conv', 2, '10', 'HUMAN_REPLY');
    expect(result).toBe('APPLIED');
    expect(db.conversation).toMatchObject({
      last_telegram_operator_profile_version: 2,
      last_telegram_operator_update_id: 10,
      ai_mode: 'PAUSED_OPERATOR'
    });
  });

  it('rejects a higher numeric update ID from an older generation', async () => {
    const db = new OrderingDb();
    db.conversation.last_telegram_operator_profile_version = 2;
    db.conversation.last_telegram_operator_update_id = 10;
    const result = await applyTelegramOperatorAction({ DB: db } as any, 'conv', 1, '999999', 'AI_OFF');
    expect(result).toBe('STALE_PROFILE');
    expect(db.conversation).toMatchObject({
      last_telegram_operator_profile_version: 2,
      last_telegram_operator_update_id: 10,
      ai_mode: 'ENABLED'
    });
  });

  it.each([
    ['human reply', telegramEvent(1, 999999, 'late human')],
    ['AI command', telegramEvent(1, 999998, '/ai_off')],
    ['attachment', telegramEvent(1, 999997, '', [{ sourceAttachmentRef: 'f', attachmentType: 'document', locator: { provider: 'telegram', fileId: 'f' } }])]
  ])('drops old-profile queued %s before all side effects', async (_label, event) => {
    const db = new ReceiptDb();
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleQueueEvent(event, queueEnv(db, 2));
    expect(telegramHandler.processTelegramEvent).not.toHaveBeenCalled();
    expect(db.receipts).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('STALE_TELEGRAM_SUPPORT_PROFILE'));
  });

  it('retries an event from a future support generation without side effects', async () => {
    const db = new ReceiptDb();
    await expect(handleQueueEvent(telegramEvent(3, 1), queueEnv(db, 2)))
      .rejects.toBeInstanceOf(RetryableProcessingError);
    expect(telegramHandler.processTelegramEvent).not.toHaveBeenCalled();
    expect(db.receipts).toHaveLength(0);
  });
});
