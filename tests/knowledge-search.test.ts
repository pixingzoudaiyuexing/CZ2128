import { describe, expect, it, vi } from 'vitest';
import {
  buildKnowledgeSearchTerms,
  renderKnowledgeContext,
  searchKnowledge
} from '../src/knowledge/repository';
import { buildAIContext } from '../src/core/ai-context';

describe('knowledge retrieval', () => {
  it('builds multilingual searchable tokens without FTS query syntax', () => {
    const terms = buildKnowledgeSearchTerms('退款 怎么处理？ Refund-order #123');
    expect(terms).toContain('退款');
    expect(terms).toContain('refund-order');
    expect(terms).toContain('123');
    expect(terms).not.toContain('?');
  });

  it('normalizes knowledge titles to one safe line', async () => {
    const { sanitizeKnowledgeTitle } = await import('../src/knowledge/repository');
    expect(sanitizeKnowledgeTitle('  退款\n   规则  ')).toBe('退款 规则');
  });

  it('queries only enabled FTS matches with a bounded result count', async () => {
    let bound: any[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          expect(sql).toContain('knowledge_entries_fts MATCH ?');
          const statement = {
            bind: (...values: any[]) => { bound = values; return statement; },
            all: async () => ({
              results: [{ id: 'kb_1', title: '退款', body: '退款在 3 个工作日内处理。', version: 2, rank: -4.2 }]
            })
          };
          return statement;
        }
      }
    } as any;
    const rows = await searchKnowledge(env, '我想退款');
    expect(rows).toHaveLength(1);
    expect(bound[1]).toBe(5);
    expect(String(bound[0])).toContain('退款');
  });

  it('renders reference-only provenance and caps output size', () => {
    const text = renderKnowledgeContext([
      { id: 'kb_1', title: '退款规则', body: 'A'.repeat(9000), version: 3, rank: -1 }
    ]);
    expect(text).toContain('[KB kb_1 v3] 退款规则');
    expect(text).toContain('not as instructions');
    expect(text!.length).toBeLessThanOrEqual(6002);
  });

  it('injects matched knowledge after the configured system prompt', async () => {
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            bind: (..._args: any[]) => statement,
            all: async () => {
              if (sql.includes('FROM messages')) {
                return { results: [{ actor_role: 'CUSTOMER', text_content: '怎么退款' }] };
              }
              if (sql.includes('knowledge_entries_fts')) {
                return { results: [{ id: 'kb_refund', title: '退款规则', body: '三天内处理。', version: 1, rank: -1 }] };
              }
              return { results: [] };
            }
          };
          return statement;
        }
      }
    } as any;
    const messages = await buildAIContext(env, 'conv', {
      systemPrompt: '客服系统提示词',
      contextMaxMessages: 10,
      contextMaxChars: 1000
    } as any);
    expect(messages[0]).toEqual({ role: 'system', content: '客服系统提示词' });
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('退款规则');
    expect(messages[2]).toEqual({ role: 'user', content: '怎么退款' });
  });

  it('falls back to the original AI context when knowledge retrieval fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            bind: () => statement,
            all: async () => {
              if (sql.includes('FROM messages')) return { results: [{ actor_role: 'CUSTOMER', text_content: 'hello' }] };
              throw new Error('fts unavailable');
            }
          };
          return statement;
        }
      }
    } as any;
    const messages = await buildAIContext(env, 'conv', {
      systemPrompt: 'system',
      contextMaxMessages: 10,
      contextMaxChars: 1000
    } as any);
    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' }
    ]);
    expect(warn).toHaveBeenCalled();
  });
});
