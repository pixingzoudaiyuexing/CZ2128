import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { pauseOperator } from '../src/core/ai-state';
import { SupportEvent } from '../src/core/events';

class MockPreparedStatement {
  constructor(private db: MockD1, private query: string) {}
  private boundParams: any[] = [];
  bind(...params: any[]) { this.boundParams = params; return this; }
  async first<T = any>(): Promise<T | null> {
    if (this.query.includes('FROM outbound_operations')) return this.db.tables.outbound_operations.find(o => o.id === this.boundParams[0]) || null;
    if (this.query.includes('FROM conversations WHERE id = ?')) return this.db.tables.conversations.find(c => c.id === this.boundParams[0]) || null;
    if (this.query.includes('operator_channel')) return this.db.tables.conversations.find(c => c.operator_channel === this.boundParams[0] && c.operator_thread_ref === this.boundParams[1]) || null;
    if (this.query.includes('FROM event_receipts')) return this.db.tables.event_receipts.find(x => x.source === this.boundParams[0] && x.source_event_ref === this.boundParams[1]) || null;
    return null;
  }
  async all() {
    if (this.query.includes('FROM messages')) {
      const msgs = this.db.tables.messages.filter(m => m.conversation_id === this.boundParams[0]);
      msgs.sort((a, b) => b.created_at - a.created_at);
      return { results: msgs.slice(0, this.boundParams[1]) };
    }
    return { results: [] };
  }
  async run() {
    const meta = { changes: 0 };
    if (this.query.includes("status = 'SENT'")) { const o = this.db.tables.outbound_operations.find(x => x.id === this.boundParams[2]); if (o) { o.status = 'SENT'; meta.changes = 1; } } else if (this.query.includes("SET ai_mode = 'PAUSED_OPERATOR'")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[2]);
      if (c && c.ai_mode !== 'PAUSED_MANUAL') { c.ai_mode = 'PAUSED_OPERATOR'; c.last_operator_reply_at = this.boundParams[0]; c.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("SET ai_mode = 'PAUSED_MANUAL'")) {
      const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1]);
      if (c) { c.ai_mode = 'PAUSED_MANUAL'; c.ai_generation_id = null; meta.changes = 1; }
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
      this.db.tables.messages.push({ conversation_id: this.boundParams[1], provider_message_ref: this.boundParams[3], actor_role: this.boundParams[5], text_content: this.boundParams[7], created_at: this.boundParams[8] }); meta.changes = 1;
    } else if (this.query.includes("INSERT INTO event_receipts")) {
      const r = this.db.tables.event_receipts.find(x => x.source === this.boundParams[0] && x.source_event_ref === this.boundParams[1]);
      if (!r) { this.db.tables.event_receipts.push({ source: this.boundParams[0], source_event_ref: this.boundParams[1], status: 'PROCESSING', attempt_count: 1, lease_until: this.boundParams[4] }); meta.changes = 1; } else throw new Error('UNIQUE');
    } else if (this.query.includes("UPDATE event_receipts")) {
      const r = this.db.tables.event_receipts.find(x => x.source === this.boundParams[1] && x.source_event_ref === this.boundParams[2]);
      if (r) { r.status = this.query.includes('PROCESSED') ? 'PROCESSED' : 'PROCESSING'; meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO outbound_operations")) {
      this.db.tables.outbound_operations.push({ id: this.boundParams[0], status: this.boundParams[4] });
      meta.changes = 1;
    }
    return { meta };
  }
}

class MockD1 { tables: Record<string, any[]> = { conversations: [], messages: [], event_receipts: [], outbound_operations: [] }; prepare(query: string) { return new MockPreparedStatement(this, query); } }
class MockQueue { async send(msg: any) { } }

describe('Phase 2 AI Handoff', () => {
  let env: any;

  beforeEach(() => {
    env = {
      DB: new MockD1(), QUEUE: new MockQueue(), BOT_GROUP_ID: '-100',
      AI_BASE_URL: 'http://ai', AI_API_KEY: 'key', AI_MODEL: 'gpt-4o'
    };
    global.fetch = vi.fn().mockResolvedValue({ 
      ok: true, 
      json: async () => ({ choices: [{ message: { content: 'AI Answer' } }], result: { message_id: 100, message_thread_id: 99 }, id: 200 }) 
    });
  });

  it('operator reply invalidates generation lease and discards result', async () => {
    env.DB.tables.conversations.push({ id: 'c1', ai_mode: 'ENABLED', helpdesk_account_ref: '1', helpdesk_conversation_ref: '1', operator_channel: 'telegram', operator_thread_ref: '10' });
    
    let resolveAi: any;
    const aiPromise = new Promise(r => { resolveAi = r; });
    global.fetch = vi.fn().mockImplementation(() => aiPromise);

    const triggerEvent: SupportEvent = { source: 'internal', type: 'ai_trigger', eventId: 'ai1', payload: { convId: 'c1', messageId: 'm1', content: 'Hi' } };
    
    const processPromise = handleQueueEvent(triggerEvent, env);

    await new Promise(r => setTimeout(r, 50));
    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_generation_id).toBeTruthy(); 

    await pauseOperator(env, 'c1');
    expect(conv.ai_mode).toBe('PAUSED_OPERATOR');
    expect(conv.ai_generation_id).toBeNull(); 

    resolveAi({ ok: true, json: async () => ({ choices: [{ message: { content: 'AI Result' } }], result: { message_id: 100 } }) });
    await processPromise; 

    expect(env.DB.tables.messages.find((m: any) => m.actor_role === 'AI')).toBeUndefined();
  });

  it('/ai_off and /ai_on transitions', async () => {
    env.DB.tables.conversations.push({ id: 'c2', ai_mode: 'ENABLED', operator_channel: 'telegram', operator_thread_ref: '10' });
    
    await handleQueueEvent({ source: 'telegram', type: 'message_created', eventId: 'tg1', payload: { message: { message_thread_id: 10, message_id: 1, text: '/ai_off' } } }, env);
    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_MANUAL');

    await handleQueueEvent({ source: 'telegram', type: 'message_created', eventId: 'tg2', payload: { message: { message_thread_id: 10, message_id: 2, text: 'human reply' } } }, env);
    expect(conv.ai_mode).toBe('PAUSED_MANUAL');

    await handleQueueEvent({ source: 'telegram', type: 'message_created', eventId: 'tg3', payload: { message: { message_thread_id: 10, message_id: 3, text: '/ai_on' } } }, env);
    expect(conv.ai_mode).toBe('ENABLED');
  });

  it('AI provider failure releases lease', async () => {
    env.DB.tables.conversations.push({ id: 'c3', ai_mode: 'ENABLED' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    try {
      await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai1', payload: { convId: 'c3', messageId: 'm1', content: 'Hi' } }, env);
    } catch (e: any) {
      expect(e.message).toContain('AI Provider Failed: HTTP 500');
    }

    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_generation_id).toBeNull(); 
  });

  it('auto resume after timeout', async () => {
    env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS = '3600';
    env.DB.tables.conversations.push({ id: 'c4', ai_mode: 'PAUSED_OPERATOR', last_operator_reply_at: Math.floor(Date.now() / 1000) - 4000 });
    
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'AI' } }], result: { message_id: 100 } }) });
    
    await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai1', payload: { convId: 'c4', messageId: 'm1', content: 'Hi' } }, env);
    
    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('ENABLED');
    expect(env.DB.tables.messages.find((m: any) => m.actor_role === 'AI')).toBeTruthy();
  });

  it('rapid customer messages do not duplicate or lose if generation active', async () => {
    env.DB.tables.conversations.push({ id: 'c5', ai_mode: 'ENABLED' });
    
    let resolveAi: any;
    const aiPromise = new Promise(r => { resolveAi = r; });
    global.fetch = vi.fn().mockImplementation(() => aiPromise);

    const processA = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'aiA', payload: { convId: 'c5', messageId: 'mA' } }, env);
    await new Promise(r => setTimeout(r, 20)); 
    
    let bFailed = false;
    try {
      await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'aiB', payload: { convId: 'c5', messageId: 'mB' } }, env);
    } catch (e: any) {
      bFailed = true;
      expect(e.message).toContain('Lease locked');
    }
    expect(bFailed).toBe(true); 

    resolveAi({ ok: true, json: async () => ({ choices: [{ message: { content: 'A' } }], result: { message_id: 100 } }) });
    await processA;
  });
});
