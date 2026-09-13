import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { SupportEvent } from '../core/events';

class MockPreparedStatement {
  constructor(private db: MockD1, private query: string) {}
  private boundParams: any[] = [];

  bind(...params: any[]) {
    this.boundParams = params;
    return this;
  }

  async first<T = any>(): Promise<T | null> {
    if (this.query.includes('FROM event_receipts')) {
      const [source, source_event_ref] = this.boundParams;
      return this.db.tables.event_receipts.find(r => r.source === source && r.source_event_ref === source_event_ref) || null;
    }
    if (this.query.includes('FROM conversations')) {
      if (this.query.includes('helpdesk_provider')) {
        const [p, a, c] = this.boundParams;
        return this.db.tables.conversations.find(x => x.helpdesk_provider === p && x.helpdesk_account_ref === a && x.helpdesk_conversation_ref === c) || null;
      }
      if (this.query.includes('operator_thread_ref')) {
        const [c, r] = this.boundParams;
        return this.db.tables.conversations.find(x => x.operator_channel === c && x.operator_thread_ref === r) || null;
      }
      if (this.query.includes('id = ?')) {
        return this.db.tables.conversations.find(x => x.id === this.boundParams[0]) || null;
      }
    }
    if (this.query.includes('FROM outbound_operations')) {
      return this.db.tables.outbound_operations.find(o => o.id === this.boundParams[0]) || null;
    }
    return null;
  }

  async run() {
    if (this.query.includes('INSERT INTO conversations')) {
      const [id, p, a, cr, cus, ch, cat, uat, v] = this.boundParams;
      this.db.tables.conversations.push({
        id, helpdesk_provider: p, helpdesk_account_ref: a, helpdesk_conversation_ref: cr,
        customer_ref: cus, operator_channel: ch, created_at: cat, updated_at: uat, version: v
      });
    }
    if (this.query.includes('UPDATE conversations SET operator_thread_ref')) {
      const [r, uat, id] = this.boundParams;
      const c = this.db.tables.conversations.find(x => x.id === id);
      if (c) { c.operator_thread_ref = r; c.updated_at = uat; }
    }
    if (this.query.includes('UPDATE conversations SET last_operator_reply_at')) {
      const [r, id] = this.boundParams;
      const c = this.db.tables.conversations.find(x => x.id === id);
      if (c) c.last_operator_reply_at = r;
    }
    if (this.query.includes('INSERT INTO messages')) {
      const [id, cid, p, pmr, d, ar, mt, tc, cat] = this.boundParams;
      this.db.tables.messages.push({
        id, conversation_id: cid, provider: p, provider_message_ref: pmr,
        direction: d, actor_role: ar, message_type: mt, text_content: tc, created_at: cat
      });
    }
    if (this.query.includes('INSERT INTO event_receipts')) {
      const [s, ser, st, ac, pat] = this.boundParams;
      this.db.tables.event_receipts.push({
        source: s, source_event_ref: ser, status: st, attempt_count: ac, processed_at: pat
      });
    }
    if (this.query.includes('UPDATE event_receipts SET status')) {
      if (this.query.includes('last_error')) {
        const [st, err, s, ser] = this.boundParams;
        const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
        if (r) { r.status = st; r.last_error = err; }
      } else {
        const [st, pat, s, ser] = this.boundParams;
        const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
        if (r) { r.status = st; r.processed_at = pat; }
      }
    }
    if (this.query.includes('UPDATE event_receipts SET attempt_count')) {
      const [s, ser] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r) r.attempt_count++;
    }
    if (this.query.includes('INSERT INTO outbound_operations')) {
      const [id, cid, dp, ot, st, cat, uat] = this.boundParams;
      this.db.tables.outbound_operations.push({
        id, conversation_id: cid, destination_provider: dp, operation_type: ot,
        status: st, attempt_count: 0, created_at: cat, updated_at: uat
      });
    }
    if (this.query.includes("status = 'SENDING'")) {
      const [lu, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) { o.status = 'SENDING'; o.lease_until = lu; o.attempt_count++; }
    }
    if (this.query.includes("status = 'SENT'")) {
      const [pmr, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) { o.status = 'SENT'; o.provider_message_ref = pmr; }
    }
    if (this.query.includes("status = 'FAILED_RETRYABLE'")) {
      const [err, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) { o.status = 'FAILED_RETRYABLE'; o.last_error = err; }
    }
    if (this.query.includes("status = 'FAILED_FINAL'")) {
      const [now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) o.status = 'FAILED_FINAL';
    }
  }
}

class MockD1 {
  tables: Record<string, any[]> = {
    conversations: [],
    messages: [],
    event_receipts: [],
    outbound_operations: [],
  };

  prepare(query: string) {
    return new MockPreparedStatement(this, query);
  }
}

describe('Queue Event Processing', () => {
  let env: any;

  beforeEach(() => {
    env = {
      DB: new MockD1(),
      BOT_GROUP_ID: '-1001',
      CHATWOOT_API_TOKEN: 'token',
      CHATWOOT_API_URL: 'http://chatwoot',
      TELEGRAM_BOT_TOKEN: 'tg_token'
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { message_thread_id: 99, message_id: 100 }, id: 200 })
    });
  });

  it('handles customer Chatwoot message -> creates topic and sends to Telegram', async () => {
    const event: SupportEvent = {
      eventId: 'cw-evt-1',
      source: 'chatwoot',
      type: 'message_created',
      payload: {
        account: { id: 1 },
        conversation: { id: 2 },
        sender: { id: 3, type: 'contact', name: 'Bob' },
        id: 4,
        content: 'Hello'
      }
    };

    await handleQueueEvent(event, env);

    const db = env.DB as MockD1;
    // Check receipts
    expect(db.tables.event_receipts[0].status).toBe('PROCESSED');
    
    // Check conversation created
    expect(db.tables.conversations.length).toBe(1);
    const conv = db.tables.conversations[0];
    expect(conv.operator_thread_ref).toBe('99');

    // Check message inserted
    expect(db.tables.messages.length).toBe(1);
    expect(db.tables.messages[0].actor_role).toBe('CUSTOMER');

    // Check outbound operations (1 for create topic, 1 for send message)
    expect(db.tables.outbound_operations.length).toBe(2);
    expect(db.tables.outbound_operations[0].status).toBe('SENT');
    expect(db.tables.outbound_operations[1].status).toBe('SENT');
    expect(db.tables.outbound_operations[1].operation_type).toBe('SEND_MESSAGE');

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('handles duplicate queue delivery safely', async () => {
    const event: SupportEvent = {
      eventId: 'cw-evt-2',
      source: 'chatwoot',
      type: 'message_created',
      payload: {
        account: { id: 1 }, conversation: { id: 2 }, sender: { id: 3, type: 'contact' }, id: 5, content: 'Hi'
      }
    };

    await handleQueueEvent(event, env);
    await handleQueueEvent(event, env); // Duplicate

    const db = env.DB as MockD1;
    // Should still only have 1 receipt processed
    expect(db.tables.event_receipts.length).toBe(1);
    // Messages inserted (only 1)
    expect(db.tables.messages.length).toBe(1);
    // Outbound ops (2)
    expect(db.tables.outbound_operations.length).toBe(2);
    
    // Fetch called twice (topic create, send message) - not 4 times
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('sends Telegram operator reply -> Chatwoot with source_id', async () => {
    // Setup existing conversation mapped to thread '99'
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99'
    });

    const event: SupportEvent = {
      eventId: 'tg-evt-1',
      source: 'telegram',
      type: 'message_created',
      payload: {
        message: {
          message_thread_id: 99,
          message_id: 300,
          text: 'Operator reply'
        }
      }
    };

    await handleQueueEvent(event, env);

    expect(db.tables.messages.length).toBe(1);
    expect(db.tables.outbound_operations.length).toBe(1);
    expect(db.tables.outbound_operations[0].status).toBe('SENT');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    // Important: verify source_id is set to suppress echo
    expect(body.source_id).toMatch(/^cz2128:/);
  });

  it('bounds retry attempts for outbound operations', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99'
    });

    const event: SupportEvent = {
      eventId: 'tg-evt-2',
      source: 'telegram',
      type: 'message_created',
      payload: {
        message: { message_thread_id: 99, message_id: 301, text: 'Fail reply' }
      }
    };

    // Attempt 1
    await expect(handleQueueEvent(event, env)).rejects.toThrow();
    expect(db.tables.outbound_operations[0].status).toBe('FAILED_RETRYABLE');
    expect(db.tables.outbound_operations[0].attempt_count).toBe(1);
    
    // Attempt 2
    // We clear lease_until for testing
    db.tables.outbound_operations[0].lease_until = 0;
    await expect(handleQueueEvent(event, env)).rejects.toThrow();
    expect(db.tables.outbound_operations[0].attempt_count).toBe(2);

    // Attempt 3
    db.tables.outbound_operations[0].lease_until = 0;
    await expect(handleQueueEvent(event, env)).rejects.toThrow();
    expect(db.tables.outbound_operations[0].attempt_count).toBe(3);

    // Attempt 4 - should trigger FAILED_FINAL and NOT throw
    db.tables.outbound_operations[0].lease_until = 0;
    await handleQueueEvent(event, env);
    expect(db.tables.outbound_operations[0].status).toBe('FAILED_FINAL');
  });

  it('closes topic when conversation resolved', async () => {
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99'
    });

    const event: SupportEvent = {
      eventId: 'cw-evt-res',
      source: 'chatwoot',
      type: 'conversation_resolved',
      payload: {
        account: { id: 1 },
        id: 2
      }
    };

    await handleQueueEvent(event, env);

    expect(db.tables.outbound_operations.length).toBe(1);
    expect(db.tables.outbound_operations[0].operation_type).toBe('CLOSE_TOPIC');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
