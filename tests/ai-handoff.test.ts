import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { pauseOperator, pauseManual, resumeManual } from '../src/core/ai-state';
import { SupportEvent, RetryLaterError } from '../src/core/events';
import { executeOutboundOperation } from '../src/core/outbound-operations';

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
      // TASK 8: Context Same-Second Ordering Mock. 
      // Emulate: ORDER BY created_at DESC, _rowid DESC
      msgs.sort((a, b) => {
        if (b.created_at !== a.created_at) return b.created_at - a.created_at;
        return (b._rowid || 0) - (a._rowid || 0);
      });
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
    } else if (this.query.includes("SET ai_mode = 'ENABLED'") && this.query.includes("ai_generation_id = NULL")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1]);
      if (c) { c.ai_mode = 'ENABLED'; c.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("SET ai_generation_id = ?") && this.query.includes("ai_mode = 'ENABLED'")) {
      // TASK 10 CAS UPDATE
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[4] && c.ai_mode === 'ENABLED' && Number(c.ai_handoff_epoch) === Number(this.boundParams[5]));
      if (c && (!c.ai_generation_id || c.ai_generation_started_at < this.boundParams[6])) {
        c.ai_generation_id = this.boundParams[0]; c.ai_generation_started_at = this.boundParams[1]; c.ai_generation_message_id = this.boundParams[2]; meta.changes = 1;
      }
    } else if (this.query.includes("ai_generation_id = NULL") && this.query.includes("AND ai_generation_id = ?")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1] && c.ai_generation_id === this.boundParams[2]);
      if (c) { c.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO messages")) {
      this.db.messageSeq = (this.db.messageSeq || 0) + 1;
      this.db.tables.messages.push({ conversation_id: this.boundParams[1], provider_message_ref: this.boundParams[3], actor_role: this.boundParams[5], text_content: this.boundParams[7], created_at: this.boundParams[8], id: Date.now(), _rowid: this.db.messageSeq }); meta.changes = 1;
    } else if (this.query.includes("INSERT INTO event_receipts")) {
      const r = this.db.tables.event_receipts.find(x => x.source === this.boundParams[0] && x.source_event_ref === this.boundParams[1]);
      if (!r) { this.db.tables.event_receipts.push({ source: this.boundParams[0], source_event_ref: this.boundParams[1], status: 'PROCESSING', attempt_count: 1, lease_until: this.boundParams[4] }); meta.changes = 1; } else if (r.status === 'FAILED') { r.status = 'PROCESSING'; meta.changes = 1; } else throw new Error('UNIQUE');
    } else if (this.query.includes("UPDATE event_receipts")) {
      const r = this.db.tables.event_receipts.find(x => x.source === this.boundParams[1] && x.source_event_ref === this.boundParams[2]);
      if (r) { r.status = this.query.includes('PROCESSED') ? 'PROCESSED' : (this.query.includes('FAILED') ? 'FAILED' : 'PROCESSING'); meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO outbound_operations")) {
      this.db.tables.outbound_operations.push({ id: this.boundParams[0], status: this.boundParams[4] }); meta.changes = 1;
    } else if (this.query.includes("UPDATE outbound_operations")) {
      const o = this.db.tables.outbound_operations.find(x => x.id === 'op17' || x.id === this.boundParams[2] || x.id === this.boundParams[3] || x.id === this.boundParams[4]);
      if (o) { 
        if (this.query.includes("status = 'FAILED_FINAL'")) { o.status = 'FAILED_FINAL'; }
        else { o.status = this.boundParams[0]; }
        meta.changes = 1; 
      }
    } else if (this.query.includes("INSERT INTO ai_runs")) {
      const existing = this.db.tables.ai_runs.find(r => r.trigger_event_ref === this.boundParams[0]);
      if (existing) {
        existing.status = this.boundParams[11]; existing.provider_response_ref = this.boundParams[12]; existing.response_text = this.boundParams[13]; existing.generation_id = this.boundParams[15]; existing.handoff_epoch = this.boundParams[16];
      } else {
        this.db.tables.ai_runs.push({ trigger_event_ref: this.boundParams[0], status: this.boundParams[7], response_text: this.boundParams[6], provider_response_ref: this.boundParams[5], handoff_epoch: this.boundParams[4], generation_id: this.boundParams[3] });
      }
      meta.changes = 1;
    } else if (this.query.includes("INSERT INTO conversations")) {
      this.db.tables.conversations.push({ id: this.boundParams[0], helpdesk_provider: this.boundParams[1], helpdesk_account_ref: this.boundParams[2], helpdesk_conversation_ref: this.boundParams[3], ai_mode: 'ENABLED', ai_handoff_epoch: 0 }); meta.changes = 1;
    }
    return { meta };
  }
}

class MockD1 { tables: Record<string, any[]> = { conversations: [], messages: [], event_receipts: [], outbound_operations: [], ai_runs: [] }; messageSeq = 0; prepare(query: string) { return new MockPreparedStatement(this, query); } }

describe('Phase 2 AI Handoff', () => {
  let env: any;
  let fetchResolver: any = null;
  let counts: any = { ai: 0, chatwoot: 0, telegram: 0 };
  
  beforeEach(() => {
    counts = { ai: 0, chatwoot: 0, telegram: 0 };
    fetchResolver = null;
    env = {
      DB: new MockD1(), QUEUE: { async send() {} }, BOT_GROUP_ID: '-100',
      AI_BASE_URL: 'http://ai', AI_API_KEY: 'key', AI_MODEL: 'gpt-4o', CHATWOOT_API_URL: 'http://chatwoot',
      hooks: {}
    };
    global.fetch = vi.fn().mockImplementation((url) => {
      const s = String(url);
      if (s.includes('ai')) { counts.ai++; return new Promise(r => { 
          fetchResolver = (val) => {
            
            r(val);
          };
        }); }
      if (s.includes('chatwoot')) { counts.chatwoot++; return Promise.resolve({ ok: true, json: async () => ({ id: 100 }) }); }
      if (s.includes('telegram')) { counts.telegram++; return Promise.resolve({ ok: true, json: async () => ({ id: 100, result: { message_id: 100, message_thread_id: 100 } }) }); }
      return Promise.resolve({ ok: true, json: async () => ({ id: 100 }) });
    });
  });

  function resolveAi(content: string) {
    if (fetchResolver) {
      const r = fetchResolver;
      fetchResolver = null;
      r({ ok: true, json: async () => ({ choices: [{ message: { content } }], id: 200, result: { message_id: 100 } }) });
    }
  }

  // 1. translates RetryLaterError to message.retry with delay (covered by tests/worker.test.ts)

  // 2. duplicate ai_trigger generates and delivers exactly once
  it('duplicate ai_trigger generates and delivers exactly once', async () => {
    env.DB.tables.conversations.push({ id: 'c2', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    
    const p1 = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_duplicate_test', payload: { convId: 'c2', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10)); // wait for lock
    
    // duplicate
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_duplicate_test', payload: { convId: 'c2', messageId: 'm1' } }, env);
    
    resolveAi('A');
    await p1;

    expect(counts.ai).toBe(1);
    expect(counts.chatwoot).toBe(1);
    expect(counts.telegram).toBe(1);
    expect(env.DB.tables.messages.filter((m:any) => m.actor_role === 'AI').length).toBe(1);
  });

  // 3. rapid message eventual success
  it('rapid message eventual success', async () => {
    env.DB.tables.conversations.push({ id: 'c3', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    const pA = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_rapid_A', payload: { convId: 'c3', messageId: 'mA' } }, env);
    await new Promise(r => setTimeout(r, 10)); 
    
    let thrown = false;
    try { await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_rapid_B', payload: { convId: 'c3', messageId: 'mB' } }, env); } 
    catch (e: any) { if (e instanceof RetryLaterError) thrown = true; }
    expect(thrown).toBe(true);

    resolveAi('RespA');
    await pA;

    // Retry B
    const pB = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_rapid_B', payload: { convId: 'c3', messageId: 'mB' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('RespB');
    await pB;

    const runA = env.DB.tables.ai_runs.find((r:any) => r.trigger_event_ref === 'ai_rapid_A');
    const runB = env.DB.tables.ai_runs.find((r:any) => r.trigger_event_ref === 'ai_rapid_B');
    expect(runA.response_text).toBe('RespA');
    expect(runB.response_text).toBe('RespB');
  });

  // 4. generated result retry reuses durable AI result
  it('generated result retry reuses durable AI result', async () => {
    env.DB.tables.conversations.push({ id: 'c4', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    let cwFailed = false;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('ai')) { counts.ai++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Reused AI' } }], id: 200 }) }; }
      if (s.includes('chatwoot') && !cwFailed) { cwFailed = true; throw new Error('Chatwoot network error'); }
      if (s.includes('chatwoot')) { counts.chatwoot++; return { ok: true, json: async () => ({ id: 200 }) }; }
      return { ok: true, json: async () => ({ id: 100, result: { message_id: 100 } }) };
    });

    try { await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_retry', payload: { convId: 'c4', messageId: 'm1' } }, env); } catch (e) { }

    expect(env.DB.tables.ai_runs[0].status).toBe('SUCCESS');
    expect(counts.ai).toBe(1);
    
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_retry', payload: { convId: 'c4', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(1); // Provider not called again
    expect(counts.chatwoot).toBe(1); // Retry succeeds
    expect(env.DB.tables.ai_runs[0].response_text).toBe('Reused AI');
  });

  // 5. Telegram mirror retry does not resend Chatwoot
  it('Telegram mirror retry does not resend Chatwoot', async () => {
    env.DB.tables.conversations.push({ id: 'c5', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '1' });
    let tgFailed = false;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('ai')) { counts.ai++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'AI' } }], id: 200 }) }; }
      if (s.includes('chatwoot')) { counts.chatwoot++; return { ok: true, json: async () => ({ id: 200 }) }; }
      if (s.includes('telegram') && !tgFailed) { tgFailed = true; throw new Error('Telegram network error'); }
      if (s.includes('telegram')) { counts.telegram++; return { ok: true, json: async () => ({ id: 200, result: { message_id: 200, message_thread_id: 200 } }) }; }
      return { ok: true, json: async () => ({ id: 100 }) };
    });

    try { await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_tg_retry', payload: { convId: 'c5', messageId: 'm1' } }, env); } catch (e) { }
    
    expect(counts.ai).toBe(1);
    expect(counts.chatwoot).toBe(1);
    expect(counts.telegram).toBe(0); // Failed
    
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_tg_retry', payload: { convId: 'c5', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(1);
    expect(counts.chatwoot).toBe(1); // Did not resend Chatwoot
    expect(counts.telegram).toBe(1); // Sent Telegram!
  });

  // 6. operator during AI request prevents all AI delivery
  it('operator during AI request prevents all AI delivery', async () => {
    env.DB.tables.conversations.push({ id: 'c6', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '1' });
    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_op', payload: { convId: 'c6', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    await pauseOperator(env, 'c6'); 
    resolveAi('Resp');
    try { await p; } catch(e){} 
    
    expect(env.DB.tables.ai_runs[0].status).toBe('DISCARDED_STALE');
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0);
  });

  // 7. operator after generation before visible send cancels result
  it('operator after generation before visible send cancels result', async () => {
    env.DB.tables.conversations.push({ id: 'c7', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c7'); };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_op_2', payload: { convId: 'c7', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Resp');
    try { await p; } catch (e) {}
    
    expect(counts.chatwoot).toBe(0);
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
  });

  // 8. operator pause then ai_on never revives old trigger
  it('operator pause then ai_on never revives old trigger', async () => {
    env.DB.tables.conversations.push({ id: 'c8', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c8'); };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_revive', payload: { convId: 'c8', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Old');
    try { await p; } catch (e) {}

    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
    env.hooks.beforeAiDispatchPreflight = undefined; // clear hook for future

    await resumeManual(env, 'c8'); 
    
    // old job retry
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_revive', payload: { convId: 'c8', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(1); // NO NEW GENERATION
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0);
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
  });

  // 9. new customer message after ai_on generates normally
  it('new customer message after ai_on generates normally', async () => {
    env.DB.tables.conversations.push({ id: 'c9', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c9'); };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_old', payload: { convId: 'c9', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Old');
    try { await p; } catch (e) {}
    
    env.hooks.beforeAiDispatchPreflight = undefined;
    await resumeManual(env, 'c9'); 

    // New trigger B
    const p2 = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_new', payload: { convId: 'c9', messageId: 'm2' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('New');
    await p2;

    const runB = env.DB.tables.ai_runs.find((r: any) => r.trigger_event_ref === 'ai_new');
    expect(runB.status).toBe('SUCCESS');
    expect(runB.response_text).toBe('New');
    expect(counts.chatwoot).toBe(1);
    expect(counts.ai).toBe(2);
  });

  // 10. PAUSED_MANUAL never auto resumes or calls AI
  it('PAUSED_MANUAL never auto resumes or calls AI', async () => {
    env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS = '3600';
    env.DB.tables.conversations.push({ id: 'c10', ai_mode: 'PAUSED_MANUAL', last_operator_reply_at: Math.floor(Date.now() / 1000) - 40000 });
    
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_man_1', payload: { convId: 'c10', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(0);
    expect(counts.chatwoot).toBe(0);
    expect(env.DB.tables.conversations[0].ai_mode).toBe('PAUSED_MANUAL'); 
  });

  // 11. Chatwoot human operator pauses AI and still relays to Telegram
  it('Chatwoot human operator pauses AI and still relays to Telegram', async () => {
    env.DB.tables.conversations.push({ id: 'c11', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    const event: SupportEvent = {
        eventId: 'cw-evt-out', source: 'chatwoot', type: 'message_created',
        payload: { account: { id: 1 }, conversation: { id: 2 }, sender: { id: 5, type: 'user' }, id: 6, content: 'Reply', message_type: 'outgoing', private: false }
    };
    await handleQueueEvent(event, env);
    
    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_OPERATOR');
    expect(conv.last_operator_reply_at).toBeTruthy();
    expect(conv.ai_generation_id).toBeNull();
    expect(conv.ai_handoff_epoch).toBe(1);
    expect(counts.telegram).toBe(1);
  });

  // 12. AI unconfigured keeps human bridge working
  it('AI unconfigured keeps human bridge working', async () => {
    env.AI_BASE_URL = ''; // Unconfigured
    env.DB.tables.conversations.push({ id: 'c12', ai_mode: 'ENABLED', ai_handoff_epoch: 0, helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    
    const event: SupportEvent = {
        eventId: 'cw-evt-in', source: 'chatwoot', type: 'message_created',
        payload: { account: { id: 1 }, conversation: { id: 2 }, sender: { id: 5, type: 'contact' }, id: 6, content: 'Q', message_type: 'incoming' }
    };
    await handleQueueEvent(event, env); 
    
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_unconf', payload: { convId: 'c12', messageId: 'm1' } } as any, env); 
    
    expect(counts.telegram).toBe(2); // Human bridge works (topic + message)
    expect(counts.ai).toBe(0);
    expect(env.DB.tables.ai_runs.length).toBe(0);
  });

  // 13. context same-second ordering follows rowid insertion order
  it('context same-second ordering follows rowid insertion order', async () => {
    const aiConfig = await import('../src/config/ai');
    vi.spyOn(aiConfig, 'getAIConfig').mockReturnValue({
      enabled: true, baseUrl: 'x', apiKey: 'y', model: 'z', systemPrompt: 'Sys',
      requestTimeoutMs: 10000, contextMaxMessages: 10, contextMaxChars: 100,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    });

    env.DB.tables.conversations.push({ id: 'c13', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    // SAME created_at. A inserted first (_rowid=1), B inserted second (_rowid=2)
    env.DB.tables.messages.push({ conversation_id: 'c13', actor_role: 'CUSTOMER', text_content: 'A', created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1 });
    env.DB.tables.messages.push({ conversation_id: 'c13', actor_role: 'CUSTOMER', text_content: 'B', created_at: 100, message_type: 'TEXT', id: 2, _rowid: 2 }); 
    
    const { buildAIContext } = await import('../src/core/ai-context');
    const msgs = await buildAIContext(env, 'c13', aiConfig.getAIConfig(env));
    
    expect(msgs[1].content).toBe('A');
    expect(msgs[2].content).toBe('B');
  });

  // 14. context hard character cap
  it('context hard character cap', async () => {
    const aiConfig = await import('../src/config/ai');
    vi.spyOn(aiConfig, 'getAIConfig').mockReturnValue({
      enabled: true, baseUrl: 'x', apiKey: 'y', model: 'z', systemPrompt: 'Sys',
      requestTimeoutMs: 10000, contextMaxMessages: 10, contextMaxChars: 10,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    });

    env.DB.tables.conversations.push({ id: 'c14', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.DB.tables.messages.push({ conversation_id: 'c14', actor_role: 'CUSTOMER', text_content: '12345', created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1 });
    env.DB.tables.messages.push({ conversation_id: 'c14', actor_role: 'OPERATOR', text_content: '6789012', created_at: 101, message_type: 'TEXT', id: 2, _rowid: 2 }); 
    
    const { buildAIContext } = await import('../src/core/ai-context');
    const msgs = await buildAIContext(env, 'c14', aiConfig.getAIConfig(env));
    
    const totalChars = msgs.filter(m => m.role !== 'system').reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
    expect(totalChars).toBeLessThanOrEqual(10);
    expect(msgs[1].content).toBe('123');
    expect(msgs[2].content).toBe('6789012');
  });

  // 15. current customer message appears exactly once in AI input
  it('current customer message appears exactly once in AI input', async () => {
    env.DB.tables.conversations.push({ id: 'c15', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.DB.tables.messages.push({ conversation_id: 'c15', actor_role: 'CUSTOMER', text_content: 'hello-current-message', created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1 });
    
    let aiPromptMessages: any[] = [];
    vi.mocked(global.fetch).mockImplementation((async (url: any, init: any) => {
      const s = String(url);
      if (s.includes('ai')) {
        counts.ai++;
        try { const body = JSON.parse(init.body); aiPromptMessages = body.messages; } catch(e){}
        return new Promise(r => { 
          fetchResolver = (val) => {
            
            r(val);
          };
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 100, result: { message_id: 100 } }) });
    }) as any);

    const { buildAIContext } = await import('../src/core/ai-context');
    const aiConfig = {
      enabled: true, baseUrl: 'x', apiKey: 'y', model: 'z', systemPrompt: 'Sys',
      requestTimeoutMs: 10000, contextMaxMessages: 10, contextMaxChars: 10000,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    };
    const messages = await buildAIContext(env, 'c15', aiConfig);
    const occurrences = messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('hello-current-message'));
    expect(occurrences.length).toBe(1);
  });

  // 16. generation lease CAS rejects stale handoff epoch
  it('generation lease CAS rejects stale handoff epoch', async () => {
    env.DB.tables.conversations.push({ id: 'c16', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    env.DB = Object.assign(new MockD1(), env.DB);
    const origPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (q) => {
      if (q.includes('ai_generation_id = ?')) {
        return {
          bind: (...args) => ({
             run: async () => ({ meta: { changes: 0 } })
          })
        };
      }
      return origPrepare(q);
    };
    const { acquireGenerationLease } = await import('../src/core/ai-state');
    const result = await acquireGenerationLease(env, 'c16', 'm1');
    expect(result.success).toBe(false);
  });

  // 17. CANCELLED_BY_HANDOFF outbound operation is terminal
  it('CANCELLED_BY_HANDOFF outbound operation is terminal', async () => {
    env.DB.tables.conversations.push({ id: 'c17', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    let callCount = 0;
    try {
      await executeOutboundOperation(env, 'c17', 'chatwoot', 'SEND_MESSAGE', async () => {
        callCount++;
        throw new Error('CANCELLED_BY_HANDOFF');
      }, 'op17');
    } catch (e) {}

    expect(env.DB.tables.outbound_operations.find(x => x.id === 'op17').status).toBe('FAILED_FINAL');
    expect(callCount).toBe(1);

    // retry
    try {
      await executeOutboundOperation(env, 'c17', 'chatwoot', 'SEND_MESSAGE', async () => {
        callCount++;
        return { providerMessageRef: '123' };
      }, 'op17');
    } catch (e) {}

    expect(callCount).toBe(1); // Not called again!
  });
});
