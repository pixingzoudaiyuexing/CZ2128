import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import { applyTelegramOperatorAction } from '../src/core/ai-state';
import { processTelegramEvent } from '../src/queue/telegram-handler';
import {
  CRISP_KEYWORD_CONFIG_MAX_LENGTH,
  CRISP_KEYWORD_RULES_MAX_COUNT,
  parseCrispKeywordRules
} from '../src/config/crisp-keywords';
import {
  crispAiIdentity,
  crispOperatorIdentity,
  validateCrispAvatarUrl,
  validateCrispNickname
} from '../src/config/crisp-identities';
import { customerNotificationMode } from '../src/config/telegram-customer-ux';

function insertConversation(db: SqliteD1, id = 'conv-1'): void {
  db.exec(`
    INSERT INTO conversations (
      id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref,
      customer_ref, operator_channel, operator_thread_ref, created_at, updated_at
    ) VALUES (
      '${id}', 'crisp', 'site-1', 'session-1',
      'customer-1', 'telegram', '77', 1, 1
    )
  `);
}

function rule(index: number, reply = 'reply') {
  return {
    id: `kw_${String(index).padStart(16, '0')}`,
    keyword: `keyword-${index}`,
    reply,
    enabled: true
  };
}

describe('Crisp-12 legacy UX contracts', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([1, 20, 21, 99, 100])('accepts %i keyword rules', count => {
    const raw = JSON.stringify({ version: 1, rules: Array.from({ length: count }, (_, i) => rule(i + 1)) });
    expect(parseCrispKeywordRules(raw)?.rules).toHaveLength(count);
  });

  it('rejects 101 rules and enforces the bounded total capacity', () => {
    const tooMany = JSON.stringify({ version: 1, rules: Array.from({ length: 101 }, (_, i) => rule(i + 1)) });
    expect(parseCrispKeywordRules(tooMany)).toBeNull();

    const nearWorstCase = JSON.stringify({
      version: 1,
      rules: Array.from({ length: CRISP_KEYWORD_RULES_MAX_COUNT }, (_, i) =>
        rule(i + 1, 'x'.repeat(4000))
      )
    });
    expect(nearWorstCase.length).toBeLessThan(CRISP_KEYWORD_CONFIG_MAX_LENGTH);
    expect(parseCrispKeywordRules(nearWorstCase)?.rules).toHaveLength(100);
    expect(parseCrispKeywordRules('x'.repeat(CRISP_KEYWORD_CONFIG_MAX_LENGTH + 1))).toBeNull();
  });

  it('validates independent Crisp identities without fetching avatar URLs', () => {
    expect(validateCrispNickname(' 人工客服 ')).toBe('人工客服');
    expect(validateCrispNickname('bad\nname')).toBeNull();
    expect(validateCrispAvatarUrl('https://cdn.example/avatar.png')).toBe('https://cdn.example/avatar.png');
    expect(validateCrispAvatarUrl('http://cdn.example/avatar.png')).toBeNull();

    expect(crispOperatorIdentity({} as any)).toEqual({ nickname: '人工客服' });
    expect(crispAiIdentity({} as any)).toEqual({ nickname: '智能客服' });
  });

  it('persists the three pause sources and clears them when AI is enabled', async () => {
    const db = new SqliteD1();
    try {
      db.migrate();
      insertConversation(db);
      const env = { DB: db } as any;

      await applyTelegramOperatorAction(env, 'conv-1', 0, '10', 'HUMAN_REPLY');
      let row = await db.prepare('SELECT ai_mode, ai_pause_source FROM conversations WHERE id = ?')
        .bind('conv-1').first<any>();
      expect(row).toMatchObject({ ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'TELEGRAM_OPERATOR' });

      await applyTelegramOperatorAction(env, 'conv-1', 0, '11', 'AI_OFF');
      row = await db.prepare('SELECT ai_mode, ai_pause_source FROM conversations WHERE id = ?')
        .bind('conv-1').first<any>();
      expect(row).toMatchObject({ ai_mode: 'PAUSED_MANUAL', ai_pause_source: 'MANUAL' });

      await applyTelegramOperatorAction(env, 'conv-1', 0, '12', 'AI_ON');
      row = await db.prepare('SELECT ai_mode, ai_pause_source FROM conversations WHERE id = ?')
        .bind('conv-1').first<any>();
      expect(row).toMatchObject({ ai_mode: 'ENABLED', ai_pause_source: null });
    } finally {
      db.close();
    }
  });

  it('keeps repeated AI toggle actions state-idempotent while advancing update ordering', async () => {
    const db = new SqliteD1();
    try {
      db.migrate();
      insertConversation(db);
      const env = { DB: db } as any;

      expect(await applyTelegramOperatorAction(env, 'conv-1', 0, '20', 'AI_OFF')).toBe('APPLIED');
      const first = await db.prepare(
        'SELECT ai_handoff_epoch, last_telegram_operator_update_id FROM conversations WHERE id = ?'
      ).bind('conv-1').first<any>();

      expect(await applyTelegramOperatorAction(env, 'conv-1', 0, '21', 'AI_OFF')).toBe('CURRENT');
      const second = await db.prepare(
        'SELECT ai_handoff_epoch, last_telegram_operator_update_id FROM conversations WHERE id = ?'
      ).bind('conv-1').first<any>();
      expect(second.ai_handoff_epoch).toBe(first.ai_handoff_epoch);
      expect(second.last_telegram_operator_update_id).toBe(21);

      expect(await applyTelegramOperatorAction(env, 'conv-1', 0, '21', 'AI_OFF')).toBe('CURRENT');
      const third = await db.prepare(
        'SELECT ai_handoff_epoch, last_telegram_operator_update_id FROM conversations WHERE id = ?'
      ).bind('conv-1').first<any>();
      expect(third).toEqual(second);
    } finally {
      db.close();
    }
  });

  it('uses source-specific default notification policy while preserving legacy paused rows', () => {
    const env = {} as any;
    expect(customerNotificationMode(env, { ai_mode: 'ENABLED' } as any)).toBe('normal');
    expect(customerNotificationMode(env, { ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'CRISP_OPERATOR' } as any)).toBe('silent');
    expect(customerNotificationMode(env, { ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'TELEGRAM_OPERATOR' } as any)).toBe('normal');
    expect(customerNotificationMode(env, { ai_mode: 'PAUSED_MANUAL', ai_pause_source: 'MANUAL' } as any)).toBe('silent');
    expect(customerNotificationMode(env, { ai_mode: 'PAUSED_OPERATOR', ai_pause_source: null } as any)).toBe('normal');
  });

  it('binds AI callback control to a sent Crisp customer message instead of callback-supplied ids', async () => {
    const db = new SqliteD1();
    try {
      db.migrate();
      insertConversation(db);
      db.exec(`
        INSERT INTO outbound_operations (
          id, conversation_id, destination_provider, operation_type, status,
          provider_message_ref, attempt_count, created_at, updated_at,
          reconciliation_status, subject_type, subject_ref, target_evidence_json, request_options_json
        ) VALUES (
          'send_tg_crisp_msg-1', 'conv-1', 'telegram', 'SEND_MESSAGE', 'SENT',
          '901', 1, 1, 1,
          'NOT_REQUIRED', 'MESSAGE', 'crisp:msg-1',
          '{"version":1,"provider":"telegram","supportProfileSource":"ENV","botGroupIdSource":"ENV","groupRef":"-10099","threadRef":"77","method":"sendMessage"}',
          '{"version":1,"disableNotification":false,"controls":"AI_TOGGLE_V1"}'
        )
      `);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      );
      const env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: '123456:token',
        BOT_GROUP_ID: '-10099'
      } as any;

      await processTelegramEvent({
        version: 1,
        source: 'telegram',
        type: 'control_action',
        eventId: 'tg:0:50',
        payload: {
          supportProfileVersion: 0,
          updateRef: '50',
          callbackQueryRef: 'cb-1',
          messageRef: '901',
          threadRef: '77',
          operatorRef: '1001',
          action: 'AI_OFF'
        }
      }, env);

      const row = await db.prepare('SELECT ai_mode, ai_pause_source FROM conversations WHERE id = ?')
        .bind('conv-1').first<any>();
      expect(row).toMatchObject({ ai_mode: 'PAUSED_MANUAL', ai_pause_source: 'MANUAL' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/answerCallbackQuery');
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body.callback_query_id).toBe('cb-1');
    } finally {
      db.close();
    }
  });
});
