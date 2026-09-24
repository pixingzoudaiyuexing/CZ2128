import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processCrispEvent } from '../src/queue/crisp-handler';
import * as conversationService from '../src/core/conversation-service';
import * as outbound from '../src/core/outbound-operations';
import * as aiState from '../src/core/ai-state';
import * as crispApi from '../src/adapters/crisp/api';
import { CrispKeywordRulesConfig } from '../src/config/crisp-keywords';

vi.mock('../src/core/conversation-service', () => ({
  getOrCreateConversation: vi.fn(), insertMessage: vi.fn(), updateOperatorThreadRef: vi.fn()
}));
vi.mock('../src/core/outbound-operations', () => ({ executeOutboundOperation: vi.fn(), getOutboundOperation: vi.fn() }));
vi.mock('../src/core/attachment-repository', () => ({ enqueueAttachmentJobs: vi.fn() }));
vi.mock('../src/core/ai-state', () => ({
  checkAutoResume: vi.fn(),
  pauseOperator: vi.fn(),
  pauseOperatorForCrispSelection: vi.fn()
}));
vi.mock('../src/adapters/telegram/api', () => ({
  createTelegramTopic: vi.fn(), sendTelegramMessage: vi.fn()
}));
vi.mock('../src/adapters/crisp/api', () => ({
  createCrispMessage: vi.fn(), createCrispPicker: vi.fn()
}));

const RULE_ID = 'kw_0000000000000001';

function rules(keyword: string, reply = 'preset reply', enabled = true): CrispKeywordRulesConfig {
  return { version: 1, rules: [{ id: RULE_ID, keyword, reply, enabled }] };
}

function db(mode: 'ENABLED' | 'PAUSED_OPERATOR' | 'PAUSED_MANUAL' = 'ENABLED', historyValue?: string) {
  return {
    prepare: (sql: string) => {
      let params: any[] = [];
      const statement = {
        bind: (...values: any[]) => { params = values; return statement; },
        first: async () => {
          if (sql.includes('SELECT ai_mode FROM conversations')) return { ai_mode: mode };
          if (sql.includes('FROM runtime_config_history WHERE key = ? AND version = ?')) {
            return historyValue && params[0] === 'CRISP_KEYWORD_RULES' && params[1] === 1
              ? { key: params[0], version: 1, value_kind: 'PLAIN', value_text: historyValue, is_deleted: 0 }
              : null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } })
      };
      return statement;
    }
  };
}

function keywordSnapshot(config: CrispKeywordRulesConfig, version = 1) {
  return {
    values: { CRISP_KEYWORD_RULES: JSON.stringify(config) },
    sources: { CRISP_KEYWORD_RULES: 'D1', TELEGRAM_SUPPORT_PROFILE: 'ENV', BOT_GROUP_ID: 'ENV' },
    versions: { CRISP_KEYWORD_RULES: version },
    errors: {},
    health: 'AVAILABLE',
    overrideCount: 1
  } as any;
}

function event(messageRef: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    source: 'crisp' as const,
    type: 'message_created' as const,
    eventId: `crisp:${messageRef}`,
    payload: {
      websiteRef: 'website-1',
      sessionRef: 'session-1',
      customerRef: 'visitor-1',
      messageRef,
      actorRole: 'CUSTOMER' as const,
      content,
      ...extra
    }
  };
}

describe('Crisp keyword reply orchestration', () => {
  let env: any;

  beforeEach(() => {
    vi.resetAllMocks();
    env = {
      BOT_GROUP_ID: '-100',
      QUEUE: { send: vi.fn() },
      DB: db(),
      CRISP_API_IDENTIFIER: 'identifier',
      CRISP_API_KEY: 'key'
    };
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-crisp',
      operator_thread_ref: '77',
      helpdesk_provider: 'crisp',
      helpdesk_account_ref: 'website-1',
      helpdesk_conversation_ref: 'session-1',
      ai_mode: 'ENABLED'
    } as any);
    vi.mocked(conversationService.updateOperatorThreadRef).mockResolvedValue('77');
    vi.mocked(outbound.executeOutboundOperation).mockResolvedValue({ status: 'SENT', providerMessageRef: 'p1' } as any);
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue(null);
    vi.mocked(aiState.checkAutoResume).mockResolvedValue(true);
    vi.mocked(crispApi.createCrispMessage).mockResolvedValue({ messageId: 'crisp-reply' } as any);
  });

  it('forwards a matched customer message to the original Topic, sends one keyword operation, and suppresses AI', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'key';
    env.AI_MODEL = 'model';
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费'));

    await processCrispEvent(event('kw-1', '续费'), env);

    const calls = vi.mocked(outbound.executeOutboundOperation).mock.calls;
    expect(calls.some(call => call[2] === 'telegram' && call[5] === 'send_tg_crisp_kw-1')).toBe(true);
    const keywordCalls = calls.filter(call => call[2] === 'crisp' && String(call[5]).startsWith('crisp_keyword:'));
    expect(keywordCalls).toHaveLength(1);
    expect(keywordCalls[0][6]).toMatchObject({ subject: { type: 'MESSAGE', ref: `crisp-keyword:v1:${RULE_ID}` } });
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('matches ASCII case-insensitively after trimming while remaining exact', async () => {
    env.runtimeConfigSnapshot = keywordSnapshot(rules('Renew Now'));
    await processCrispEvent(event('kw-2', '  RENEW now  '), env);
    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls
      .filter(call => call[2] === 'crisp' && String(call[5]).startsWith('crisp_keyword:'))).toHaveLength(1);
  });

  it('does not trigger on substring-only text and preserves the ordinary AI path', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'key';
    env.AI_MODEL = 'model';
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费'));

    await processCrispEvent(event('kw-3', '我想了解怎么续费'), env);

    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls
      .some(call => call[2] === 'crisp' && String(call[5]).startsWith('crisp_keyword:'))).toBe(false);
    expect(env.QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ai_trigger',
      eventId: 'ai_trigger:conv-crisp:kw-3'
    }));
  });

  it('does not auto-reply or auto-resume while manual handoff is active', async () => {
    env.DB = db('PAUSED_MANUAL');
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费'));
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-crisp', operator_thread_ref: '77', helpdesk_provider: 'crisp',
      helpdesk_account_ref: 'website-1', helpdesk_conversation_ref: 'session-1', ai_mode: 'PAUSED_MANUAL'
    } as any);
    vi.mocked(aiState.checkAutoResume).mockResolvedValue(false);

    await processCrispEvent(event('kw-4', '续费'), env);

    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls
      .some(call => call[2] === 'crisp')).toBe(false);
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('suppresses Welcome and Picker on a first customer message that matches a rule', async () => {
    env.runtimeConfigSnapshot = keywordSnapshot(rules('Start'));
    env.CRISP_WELCOME_TEXT = 'Welcome';
    env.CRISP_MENU_JSON = JSON.stringify({
      picker: { id: 'main', text: 'Choose', choices: [{ value: 'human', label: 'Human' }] }
    });
    vi.mocked(conversationService.getOrCreateConversation).mockResolvedValueOnce({
      id: 'new-conv', operator_thread_ref: null, helpdesk_provider: 'crisp',
      helpdesk_account_ref: 'website-1', helpdesk_conversation_ref: 'session-1', ai_mode: 'ENABLED'
    } as any);

    await processCrispEvent(event('kw-5', 'Start'), env);

    const ids = vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => String(call[5]));
    expect(ids.some(id => id.startsWith('crisp_keyword:'))).toBe(true);
    expect(ids).not.toContain('crisp_welcome:new-conv');
    expect(ids).not.toContain('crisp_picker:new-conv:main');
  });

  it('never treats a Picker selection as a keyword trigger', async () => {
    env.runtimeConfigSnapshot = keywordSnapshot(rules('Sales'));
    env.CRISP_MENU_JSON = JSON.stringify({
      options: [{ pickerId: 'main', value: 'sales', label: 'Sales', response: 'Sales response' }]
    });

    await processCrispEvent(event('kw-6', 'Sales', {
      selection: { pickerId: 'main', pickerMessageRef: 'picker-1', value: 'sales', label: 'Sales' }
    }), env);

    const ids = vi.mocked(outbound.executeOutboundOperation).mock.calls.map(call => String(call[5]));
    expect(ids.some(id => id.startsWith('crisp_keyword:'))).toBe(false);
    expect(ids).toContain('crisp_option:crisp:kw-6:response');
  });

  it('does not trigger keyword automation for Crisp operator text', async () => {
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费'));
    await processCrispEvent({
      ...event('kw-7', '续费'),
      payload: { ...event('kw-7', '续费').payload, actorRole: 'OPERATOR' as const }
    }, env);
    expect(aiState.pauseOperator).toHaveBeenCalledWith(env, 'conv-crisp', 'CRISP_OPERATOR');
    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls.some(call => call[2] === 'crisp')).toBe(false);
  });

  it('treats a terminal keyword operation as consumed on duplicate delivery and never starts AI', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'key';
    env.AI_MODEL = 'model';
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费', 'new reply'), 2);
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue({
      id: 'existing', conversation_id: 'conv-crisp', destination_provider: 'crisp',
      operation_type: 'SEND_MESSAGE', status: 'SENT', subject_type: 'MESSAGE',
      subject_ref: `crisp-keyword:v1:${RULE_ID}`
    } as any);

    await processCrispEvent(event('kw-8', '续费'), env);

    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls.filter(call => call[2] === 'crisp')).toHaveLength(0);
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('preserves an old rule reply for an in-flight operation after the config is edited', async () => {
    const old = JSON.stringify(rules('续费', 'old frozen reply'));
    env.DB = db('ENABLED', old);
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费', 'new changed reply'), 2);
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue({
      id: 'existing', conversation_id: 'conv-crisp', destination_provider: 'crisp',
      operation_type: 'SEND_MESSAGE', status: 'PENDING', subject_type: 'MESSAGE',
      subject_ref: `crisp-keyword:v1:${RULE_ID}`
    } as any);
    vi.mocked(outbound.executeOutboundOperation).mockImplementation(async (...args: any[]) => {
      if (args[2] === 'crisp') {
        await args[4](args[5], { requestStarted: vi.fn(), responseObserved: vi.fn() });
      }
      return { status: 'SENT', providerMessageRef: 'p1' } as any;
    });

    await processCrispEvent(event('kw-9', '续费'), env);

    expect(crispApi.createCrispMessage).toHaveBeenCalledWith(
      env, 'website-1', 'session-1', 'old frozen reply', expect.any(String), expect.any(Object)
    );
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('does not blind-resend or fall back to AI after an AMBIGUOUS keyword result', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'key';
    env.AI_MODEL = 'model';
    env.runtimeConfigSnapshot = keywordSnapshot(rules('续费'));
    vi.mocked(outbound.executeOutboundOperation).mockImplementation(async (...args: any[]) =>
      args[2] === 'crisp'
        ? { status: 'AMBIGUOUS' } as any
        : { status: 'SENT', providerMessageRef: 'p1' } as any
    );

    await processCrispEvent(event('kw-10', '续费'), env);
    vi.mocked(outbound.getOutboundOperation).mockResolvedValue({
      id: 'existing', conversation_id: 'conv-crisp', destination_provider: 'crisp',
      operation_type: 'SEND_MESSAGE', status: 'AMBIGUOUS', subject_type: 'MESSAGE',
      subject_ref: `crisp-keyword:v1:${RULE_ID}`
    } as any);
    await processCrispEvent(event('kw-10', '续费'), env);

    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls.filter(call => call[2] === 'crisp')).toHaveLength(1);
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('fails closed for malformed keyword config while preserving Telegram bridge and normal AI behavior', async () => {
    env.AI_BASE_URL = 'https://ai.example/v1';
    env.AI_API_KEY = 'key';
    env.AI_MODEL = 'model';
    env.runtimeConfigSnapshot = {
      values: {},
      sources: { CRISP_KEYWORD_RULES: 'D1', TELEGRAM_SUPPORT_PROFILE: 'ENV', BOT_GROUP_ID: 'ENV' },
      versions: {},
      errors: { CRISP_KEYWORD_RULES: 'RUNTIME_CONFIG_VALUE_INVALID' },
      health: 'ERROR',
      overrideCount: 1
    };

    await processCrispEvent(event('kw-11', '续费'), env);

    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls
      .some(call => call[2] === 'telegram' && call[5] === 'send_tg_crisp_kw-11')).toBe(true);
    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls
      .some(call => call[2] === 'crisp')).toBe(false);
    expect(env.QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai_trigger' }));
  });

  it('matches at most one rule for one customer message', async () => {
    env.runtimeConfigSnapshot = keywordSnapshot({
      version: 1,
      rules: [
        { id: RULE_ID, keyword: 'billing', reply: 'one', enabled: true },
        { id: 'kw_0000000000000002', keyword: 'support', reply: 'two', enabled: true }
      ]
    });

    await processCrispEvent(event('kw-12', 'billing'), env);

    expect(vi.mocked(outbound.executeOutboundOperation).mock.calls
      .filter(call => call[2] === 'crisp' && String(call[5]).startsWith('crisp_keyword:'))).toHaveLength(1);
  });
});
