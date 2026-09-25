import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  processKnowledgeCallback,
  processKnowledgeMessage,
  showKnowledgePage
} from '../src/admin/knowledge';
import * as knowledge from '../src/knowledge/repository';
import * as sessions from '../src/runtime-config/repository';

const bootstrap = {
  token: '123456:admin-token-abcdefghijklmnopqrstuvwxyz',
  path: 'p'.repeat(43),
  webhookSecret: 's'.repeat(43),
  userIds: new Set(['1001'])
};
const ctx = {
  updateId: '9001',
  userId: '1001',
  chatId: '1001'
};

function telegramMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
  );
}

describe('knowledge admin UI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders paged knowledge entries and an add action', async () => {
    const fetchMock = telegramMock();
    vi.spyOn(knowledge, 'listKnowledgeEntries').mockResolvedValue([
      {
        id: 'kb_0123456789abcdef', title: '退款规则', body: '三天内退款', search_terms: '退款',
        enabled: 1, version: 2, created_by: '1001', updated_by: '1001', created_at: 1, updated_at: 2
      }
    ]);
    await showKnowledgePage({} as any, bootstrap as any, ctx as any, 0);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.text).toContain('AI 知识库');
    expect(body.text).toContain('退款规则');
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.map((item: any) => item.callback_data)).toContain('b:v:kb_0123456789abcdef');
    expect(buttons.map((item: any) => item.callback_data)).toContain('b:add');
  });

  it('starts a two-step reviewed knowledge creation flow', async () => {
    telegramMock();
    const save = vi.spyOn(sessions, 'saveAdminSession').mockResolvedValue(undefined);
    const clear = vi.spyOn(sessions, 'clearAdminSession').mockResolvedValue(undefined);
    const create = vi.spyOn(knowledge, 'createKnowledgeEntry').mockResolvedValue({
      id: 'kb_0123456789abcdef', title: '退款规则', body: '三个工作日内处理。',
      search_terms: '退款 处理', enabled: 1, version: 1,
      created_by: '1001', updated_by: '1001', created_at: 1, updated_at: 1
    });

    expect(await processKnowledgeCallback({} as any, bootstrap as any, ctx as any, 'add')).toBe('KNOWLEDGE_ADD_BEGIN');
    expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'KNOWLEDGE_ADD_TITLE', expected_version: 0
    }));

    const titleSession = {
      admin_user_id: '1001', action: 'KNOWLEDGE_ADD_TITLE', target: 'KNOWLEDGE_NEW',
      expected_version: 0, candidate_value_text: null, candidate_ciphertext: null,
      candidate_nonce: null, context_json: null, expires_at: 9999999999, updated_at: 1
    };
    expect(await processKnowledgeMessage({} as any, bootstrap as any, { ...ctx, text: '退款规则' } as any, titleSession as any))
      .toBe('KNOWLEDGE_ADD_TITLE');
    expect(save).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      action: 'KNOWLEDGE_ADD_BODY', candidate_value_text: '退款规则'
    }));

    const bodySession = { ...titleSession, action: 'KNOWLEDGE_ADD_BODY', candidate_value_text: '退款规则' };
    expect(await processKnowledgeMessage({} as any, bootstrap as any, { ...ctx, updateId: '9002', text: '三个工作日内处理。' } as any, bodySession as any))
      .toBe('KNOWLEDGE_CREATED');
    expect(create).toHaveBeenCalledWith(expect.anything(), '退款规则', '三个工作日内处理。', '1001', '9002');
    expect(clear).toHaveBeenCalled();
  });

  it('binds mutations to the version encoded in the stale-safe callback', async () => {
    telegramMock();
    vi.spyOn(knowledge, 'getKnowledgeEntry').mockResolvedValue({
      id: 'kb_0123456789abcdef', title: '退款规则', body: '正文', search_terms: '退款',
      enabled: 1, version: 4, created_by: '1001', updated_by: '1001', created_at: 1, updated_at: 2
    });
    const toggle = vi.spyOn(knowledge, 'setKnowledgeEntryEnabled').mockRejectedValue(
      new Error('KNOWLEDGE_VERSION_CONFLICT')
    );
    await expect(processKnowledgeCallback(
      {} as any, bootstrap as any, ctx as any, 't:kb_0123456789abcdef:3'
    )).rejects.toThrow('KNOWLEDGE_VERSION_CONFLICT');
    expect(toggle).toHaveBeenCalledWith(
      expect.anything(), 'kb_0123456789abcdef', 3, false, '1001', '9001'
    );
  });
});
