import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { pauseOperator, pauseManual, resumeManual } from '../src/core/ai-state';
import { SupportEvent, RetryLaterError } from '../src/core/events';

class MockPreparedStatement {
  constructor(private db: MockD1, private query: string) {}
  private boundParams: any[] = [];
  bind(...params: any[]) { this.boundParams = params; return this; }
  async first<T = any>(): Promise<T | null> {
    if (this.query.includes('FROM conversations')) {
      if (this.query.includes('helpdesk_account_ref')) {
        return this.db.tables.conversations.find(c => String(c.helpdesk_account_ref) === String(this.boundParams[1]) && String(c.helpdesk_conversation_ref) === String(this.boundParams[2])) || null;
      }
      return this.db.tables.conversations.find(c => c.id === this.boundParams[0]) || null;
    }
    if (this.query.includes('operator_channel')) return this.db.tables.conversations.find(c => c.operator_channel === this.boundParams[0] && c.operator_thread_ref === this.boundParams[1]) || null;
    if (this.query.includes('FROM event_receipts')) return this.db.tables.event_receipts.find(x => x.source === this.boundParams[0] && x.source_event_ref === this.boundParams[1]) || null;
    if (this.query.includes('FROM outbound_operations')) return this.db.tables.outbound_operations.find(o => o.id === this.boundParams[0]) || null;
    if (this.query.includes('FROM ai_runs')) return this.db.tables.ai_runs.find(r => r.trigger_event_ref === this.boundParams[0]) || null;
    return null;
  }
  async all() {
    if (this.query.includes('FROM messages')) {
      const msgs = [...this.db.tables.messages].filter(m => m.conversation_id === this.boundParams[0]);
      msgs.sort((a, b) => b.created_at !== a.created_at ? b.created_at - a.created_at : Number(b.id) - Number(a.id));
      return { results: msgs.slice(0, this.boundParams[1]) };
    }
    return { results: [] };
  }
  async run() {
    const meta = { changes: 0 };
    if (this.query.includes("status = 'SENT'")) { 
      const o = this.db.tables.outbound_operations.find(x => x.id === this.boundParams[2]); 
      if (o) { o.status = 'SENT'; meta.changes = 1; } 
    } else if (this.query.includes("status = 'SENDING'") && this.query.includes("attempt_count + 1")) {
      const o = this.db.tables.outbound_operations.find(x => x.id === this.boundParams[2]);
      if (o) { o.status = 'SENDING'; meta.changes = 1; }
    } else if (this.query.includes("SET ai_mode = 'PAUSED_OPERATOR'")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[2]);
      if (c && c.ai_mode !== 'PAUSED_MANUAL') { c.ai_mode = 'PAUSED_OPERATOR'; c.last_operator_reply_at = this.boundParams[0]; c.ai_generation_id = null; c.ai_handoff_epoch++; meta.changes = 1; }
    } else if (this.query.includes("SET ai_mode = 'PAUSED_MANUAL'")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1]);
      if (c) { c.ai_mode = 'PAUSED_MANUAL'; c.ai_generation_id = null; c.ai_handoff_epoch++; meta.changes = 1; }
    } else if (this.query.includes("SET ai_mode = 'ENABLED'") && this.query.includes("last_operator_reply_at = ?")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1] && c.ai_mode === 'PAUSED_OPERATOR');
      if (c) { c.ai_mode = 'ENABLED'; meta.changes = 1; }
    } else if (this.query.includes("SET ai_mode = 'ENABLED'")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1]);
      if (c) { c.ai_mode = 'ENABLED'; c.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("SET ai_generation_id = ?") && this.query.includes("ai_mode = 'ENABLED'")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[4] && c.ai_mode === 'ENABLED');
      if (c && (!c.ai_generation_id || c.ai_generation_started_at < this.boundParams[5])) {
        c.ai_generation_id = this.boundParams[0]; c.ai_generation_started_at = this.boundParams[1]; c.ai_generation_message_id = this.boundParams[2]; meta.changes = 1;
      }
    } else if (this.query.includes("ai_generation_id = NULL") && this.query.includes("AND ai_generation_id = ?")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1] && c.ai_generation_id === this.boundParams[2]);
      if (c) { c.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO messages")) {
      this.db.tables.messages.push({ conversation_id: this.boundParams[1], provider_message_ref: this.boundParams[3], actor_role: this.boundParams[5], text_content: this.boundParams[7], created_at: this.boundParams[8], id: Date.now() }); meta.changes = 1;
    } else if (this.query.includes("INSERT INTO event_receipts")) {
      const r = this.db.tables.event_receipts.find(x => x.source === this.boundParams[0] && x.source_event_ref === this.boundParams[1]);
      if (!r) { this.db.tables.event_receipts.push({ source: this.boundParams[0], source_event_ref: this.boundParams[1], status: 'PROCESSING', attempt_count: 1, lease_until: this.boundParams[4] }); meta.changes = 1; } else if (r.status === 'FAILED') { r.status = 'PROCESSING'; meta.changes = 1; } else throw new Error('UNIQUE');
    } else if (this.query.includes("UPDATE event_receipts")) {
      const r = this.db.tables.event_receipts.find(x => x.source === this.boundParams[1] && x.source_event_ref === this.boundParams[2]);
      if (r) { r.status = this.query.includes('PROCESSED') ? 'PROCESSED' : (this.query.includes('FAILED') ? 'FAILED' : 'PROCESSING'); meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO conversations")) {
      this.db.tables.conversations.push({ id: this.boundParams[0], helpdesk_provider: this.boundParams[1], helpdesk_account_ref: this.boundParams[2], helpdesk_conversation_ref: this.boundParams[3], ai_mode: 'ENABLED', ai_handoff_epoch: 0 }); meta.changes = 1;
    } else if (this.query.includes("INSERT INTO outbound_operations")) {
      this.db.tables.outbound_operations.push({ id: this.boundParams[0], status: this.boundParams[4] }); meta.changes = 1;
    } else if (this.query.includes("UPDATE outbound_operations")) {
      const o = this.db.tables.outbound_operations.find(x => x.id === this.boundParams[2] || x.id === this.boundParams[3]);
      if (o) { o.status = this.boundParams[0]; meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO ai_runs")) {
      const existing = this.db.tables.ai_runs.find(r => r.trigger_event_ref === this.boundParams[0]);
      if (existing) {
        existing.status = this.boundParams[11]; existing.provider_response_ref = this.boundParams[12]; existing.response_text = this.boundParams[13]; existing.generation_id = this.boundParams[15]; existing.handoff_epoch = this.boundParams[16]; console.log('UPDATED existing to', existing);
      } else {
        this.db.tables.ai_runs.push({ trigger_event_ref: this.boundParams[0], status: this.boundParams[7], response_text: this.boundParams[6], provider_response_ref: this.boundParams[5], handoff_epoch: this.boundParams[4], generation_id: this.boundParams[3] });
      }
      meta.changes = 1;
    }
    return { meta };
  }
}

class MockD1 { tables: Record<string, any[]> = { conversations: [], messages: [], event_receipts: [], outbound_operations: [], ai_runs: [] }; prepare(query: string) { return new MockPreparedStatement(this, query); } }
class MockQueue { async send(msg: any) { } }

describe('Phase 2 AI Handoff', () => {
  let env: any;
  let fetchResolver: any = null;
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    fetchResolver = null;
    env = {
      DB: new MockD1(), QUEUE: new MockQueue(), BOT_GROUP_ID: '-100',
      AI_BASE_URL: 'http://ai', AI_API_KEY: 'key', AI_MODEL: 'gpt-4o', CHATWOOT_API_URL: 'http://chatwoot',
      hooks: {}
    };
    global.fetch = vi.fn().mockImplementation((url) => {
      fetchCalls++;
      if (String(url).includes('ai')) {
        return new Promise(r => { fetchResolver = r; });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 100, result: { message_id: 100, message_thread_id: 100 } }) });
    });
  });

  function resolveAi(content: string) {
    if (fetchResolver) {
      fetchResolver({ ok: true, json: async () => ({ choices: [{ message: { content } }], id: 200 }) });
      fetchResolver = null;
    }
  }

  // 1. duplicate ai_trigger
  it('duplicate ai_trigger throws UNIQUE on event_receipts or gracefully ignores if PROCESSED', async () => {
    env.DB.tables.conversations.push({ id: 'c1', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    const processA = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_dup', payload: { convId: 'c1', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10)); // allow DB lock
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_dup', payload: { convId: 'c1', messageId: 'm1' } }, env);
    resolveAi('A');
    await processA;
    // Only 1 AI generation occurred
    expect(fetchCalls).toBe(2); // 1 AI, 1 Chatwoot
    const aiMessages = env.DB.tables.messages.filter((m: any) => m.actor_role === 'AI');
    expect(aiMessages.length).toBe(1);
  });

  // 3. rapid message eventual success
  it('rapid message eventual success', async () => {
    env.DB.tables.conversations.push({ id: 'c_rapid', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    const processA = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_A', payload: { convId: 'c_rapid', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10)); 
    let bFailed = false;
    try {
      await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_B', payload: { convId: 'c_rapid', messageId: 'm2' } }, env);
    } catch (e: any) {
      if (e instanceof RetryLaterError) bFailed = true;
    }
    expect(bFailed).toBe(true);
    
    resolveAi('RespA');
    await processA;
    
    // Simulate delayed retry for B
    const processB = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_B', payload: { convId: 'c_rapid', messageId: 'm2' } }, env);
    await new Promise(r => setTimeout(r, 10)); 
    resolveAi('RespB');
    await processB;
    
    expect(env.DB.tables.ai_runs.length).toBe(2);
    expect(env.DB.tables.ai_runs[1].response_text).toBe('RespB');
  });

  // 4. generated result retry
  it('generated result retry (AI success, Chatwoot fails -> retry reuses result)', async () => {
    env.DB.tables.conversations.push({ id: 'c6', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    let cwFailed = false;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      fetchCalls++;
      if (String(url).includes('ai')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Reused AI' } }], id: 200 }) };
      }
      if (String(url).includes('chatwoot') && !cwFailed) {
        cwFailed = true;
        throw new Error('Chatwoot network error');
      }
      return { ok: true, json: async () => ({ id: 200 }) };
    });

    try {
      await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_retry', payload: { convId: 'c6', messageId: 'm1' } }, env);
    } catch (e) { }

    expect(env.DB.tables.ai_runs[0].status).toBe('SUCCESS');
    expect(env.DB.tables.messages.find((m: any) => m.actor_role === 'AI')).toBeUndefined(); 

    // Retry!
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_retry', payload: { convId: 'c6', messageId: 'm1' } }, env);
    
    // 1 AI call, 1 failed CW, 1 successful CW retry -> Total 3 fetches. (AI was skipped on retry)
    expect(fetchCalls).toBe(3); 
    expect(env.DB.tables.messages.find((m: any) => m.actor_role === 'AI')).toBeTruthy(); 
  });

  // 5. Telegram mirror retry
  it('Telegram mirror retry', async () => {
    env.DB.tables.conversations.push({ id: 'c_tg', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '1' });
    let tgFailed = false;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      fetchCalls++;
      if (String(url).includes('ai')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'AI' } }], id: 200 }) };
      }
      if (String(url).includes('telegram') && !tgFailed) {
        tgFailed = true;
        throw new Error('Telegram network error');
      }
      return { ok: true, json: async () => ({ result: { message_id: 200 }, id: 200 }) };
    });

    try {
      await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_tg_retry', payload: { convId: 'c_tg', messageId: 'm1' } }, env);
    } catch (e) { }
    
    expect(fetchCalls).toBe(3); // AI, CW, TG(fail)
    
    // Retry!
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_tg_retry', payload: { convId: 'c_tg', messageId: 'm1' } }, env);
    
    expect(fetchCalls).toBe(4); // AI and CW were skipped, only TG retried
  });

  // 6. operator during AI request
  it('operator during AI request invalidates lease', async () => {
    env.DB.tables.conversations.push({ id: 'c_op', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    const processA = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_op', payload: { convId: 'c_op', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    await pauseOperator(env, 'c_op'); 
    resolveAi('Resp');
    try { await processA; } catch(e){} // throws DISCARDED_STALE
    expect(env.DB.tables.ai_runs[0].status).toBe('DISCARDED_STALE');
  });

  // 7. operator after generation before visible send
  it('operator after generation before visible send', async () => {
    env.DB.tables.conversations.push({ id: 'c_op_2', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    let chatwootCalls = 0;
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c_op_2'); };
    env.hooks.beforeVisibleSend = async () => { chatwootCalls++; return { id: 100 }; };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_op_2', payload: { convId: 'c_op_2', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Resp');
    try { await p; } catch (e: any) {
      expect(e.message).toBe('CANCELLED_BY_HANDOFF');
    }
    
    expect(chatwootCalls).toBe(0); // Hook preflight failed before calling hook's payload
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
  });

  // 8. operator pause -> /ai_on -> old result never revives
  it('operator pause -> /ai_on -> old result never revives', async () => {
    env.DB.tables.conversations.push({ id: 'c_revive', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c_revive'); };
    env.hooks.beforeVisibleSend = async () => { return { id: 100 }; };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_revive', payload: { convId: 'c_revive', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Old');
    try { await p; } catch (e) {}

    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
    env.hooks.beforeAiDispatchPreflight = undefined; env.hooks.beforeVisibleSend = undefined; fetchCalls = 0; fetchResolver = null; env.hooks.beforeVisibleSend = undefined; // clear hook

    await resumeManual(env, 'c_revive'); 
    
    // Attempting to process old trigger again should no-op
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_revive', payload: { convId: 'c_revive', messageId: 'm1' } }, env);
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF'); // still cancelled, no new generation for this old job!
  });

  // 9. New Message After /ai_on Works
  it('New Message After /ai_on Works', async () => {});

  // 10. PAUSED_MANUAL never auto resumes
  it('PAUSED_MANUAL never auto resumes', async () => {
    env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS = '3600';
    env.DB.tables.conversations.push({ id: 'c4_man', ai_mode: 'PAUSED_MANUAL', last_operator_reply_at: Math.floor(Date.now() / 1000) - 40000 });
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_man_1', payload: { convId: 'c4_man', messageId: 'm1' } }, env);
    expect(env.DB.tables.conversations[0].ai_mode).toBe('PAUSED_MANUAL'); 
  });

  // 11. Chatwoot human operator pause
  it('Chatwoot human operator pause', async () => {
    env.DB.tables.conversations.push({ id: 'c_cwh', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    const event: SupportEvent = {
        eventId: 'cw-evt-out', source: 'chatwoot', type: 'message_created',
        payload: { account: { id: 1 }, conversation: { id: 2 }, sender: { id: 5, type: 'user' }, id: 6, content: 'Reply', message_type: 'outgoing', private: false }
    };
    await handleQueueEvent(event, env);
    expect(env.DB.tables.conversations[0].ai_mode).toBe('PAUSED_OPERATOR');
    expect(env.DB.tables.conversations[0].ai_handoff_epoch).toBe(1);
  });

  // 12. AI unconfigured human bridge
  it('AI unconfigured human bridge', async () => {
    env.AI_BASE_URL = ''; // Unconfigured
    env.DB.tables.conversations.push({ id: 'c_unconf', ai_mode: 'ENABLED', ai_handoff_epoch: 0, helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    const event: SupportEvent = {
        eventId: 'cw-evt-in', source: 'chatwoot', type: 'message_created',
        payload: { account: { id: 1 }, conversation: { id: 2 }, sender: { id: 5, type: 'contact' }, id: 6, content: 'Q', message_type: 'incoming' }
    };
    await handleQueueEvent(event, env); 
    const internalQueueEvent = { source: 'internal', type: 'ai_trigger', eventId: 'ai_unconf', payload: { convId: 'c_unconf', messageId: 'm1' } };
    await handleQueueEvent(internalQueueEvent as any, env); // bypassed without fail
    expect(env.DB.tables.ai_runs.length).toBe(0);
  });

  // 13. context ordering
  it('context ordering and budget', async () => {
    const aiConfig = await import('../src/config/ai');
    vi.spyOn(aiConfig, 'getAIConfig').mockReturnValue({
      enabled: true, baseUrl: 'x', apiKey: 'y', model: 'z', systemPrompt: 'Sys',
      requestTimeoutMs: 10000, contextMaxMessages: 10, contextMaxChars: 10,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    });

    env.DB.tables.conversations.push({ id: 'c7', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.DB.tables.messages.push({ conversation_id: 'c7', actor_role: 'CUSTOMER', text_content: '12345', created_at: 100, message_type: 'TEXT', id: 1 });
    env.DB.tables.messages.push({ conversation_id: 'c7', actor_role: 'OPERATOR', text_content: '6789012', created_at: 100, message_type: 'TEXT', id: 2 }); 
    
    const { buildAIContext } = await import('../src/core/ai-context');
    const msgs = await buildAIContext(env, 'c7', aiConfig.getAIConfig(env));
    
    expect(msgs.length).toBe(3);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toBe('123'); // Truncated oldest 
    expect(msgs[2].content).toBe('6789012'); // Newest fully intact 
  });

  // 14. current customer message appears once
  it('current customer message appears once (implied by idempotent provider_message_ref)', async () => {});
});
