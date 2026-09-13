import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { SupportEvent } from '../src/core/events';

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
      const r = this.db.tables.event_receipts.find(x => x.source === source && x.source_event_ref === source_event_ref);
      return r ? { ...r } : null;
    }
    if (this.query.includes('FROM conversations')) {
      if (this.query.includes('helpdesk_provider = ?')) {
        const [p, a, c] = this.boundParams;
        const r = this.db.tables.conversations.find(x => x.helpdesk_provider === p && x.helpdesk_account_ref === a && x.helpdesk_conversation_ref === c);
        return r ? { ...r } : null;
      }
      if (this.query.includes('operator_thread_ref')) {
        const [c, r] = this.boundParams;
        const o = this.db.tables.conversations.find(x => x.operator_channel === c && x.operator_thread_ref === r);
        return o ? { ...o } : null;
      }
      if (this.query.includes('id = ?')) {
        const o = this.db.tables.conversations.find(c => c.id === this.boundParams[0]);
        return o ? { ...o } : null;
      }
    }
    if (this.query.includes('FROM outbound_operations')) {
      const o = this.db.tables.outbound_operations.find(x => x.id === this.boundParams[0]);
      return o ? { ...o } : null;
    }
    return null;
  }

  async run() {
    const meta = { changes: 0 };
    if (this.query.includes('INSERT INTO conversations')) {
      const [id, p, a, cr, cus, ch, cat, uat, v] = this.boundParams;
      if (!this.db.tables.conversations.find(x => x.helpdesk_provider === p && x.helpdesk_account_ref === a && x.helpdesk_conversation_ref === cr)) {
        this.db.tables.conversations.push({
          id, helpdesk_provider: p, helpdesk_account_ref: a, helpdesk_conversation_ref: cr,
          customer_ref: cus, operator_channel: ch, created_at: cat, updated_at: uat, version: v
        });
        meta.changes = 1;
      }
    }
    if (this.query.includes('UPDATE conversations SET operator_thread_ref')) {
      const [r, uat, id] = this.boundParams;
      const c = this.db.tables.conversations.find(x => x.id === id);
      if (c) { c.operator_thread_ref = r; c.updated_at = uat; meta.changes = 1; }
    }
    if (this.query.includes('INSERT INTO messages')) {
      const [id, cid, p, pmr, d, ar, mt, tc, cat] = this.boundParams;
      if (!this.db.tables.messages.find(x => x.provider === p && x.provider_message_ref === pmr)) {
        this.db.tables.messages.push({
          id, conversation_id: cid, provider: p, provider_message_ref: pmr,
          direction: d, actor_role: ar, message_type: mt, text_content: tc, created_at: cat
        });
        meta.changes = 1;
      }
    }
    if (this.query.includes('INSERT INTO event_receipts')) {
      const [s, ser, st, ac, lu] = this.boundParams;
      if (!this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser)) {
        this.db.tables.event_receipts.push({
          source: s, source_event_ref: ser, status: 'PROCESSING', attempt_count: 1, lease_until: lu
        });
        meta.changes = 1;
      } else {
        throw new Error('UNIQUE constraint failed');
      }
    }
    if (this.query.includes('UPDATE event_receipts \n       SET status = \'PROCESSING\'')) {
      const [lu, s, ser, now] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r && (r.status === 'FAILED' || (r.status === 'PROCESSING' && r.lease_until <= now))) {
        r.status = 'PROCESSING';
        r.attempt_count++;
        r.lease_until = lu;
        meta.changes = 1;
      }
    }
    if (this.query.includes('UPDATE event_receipts SET status = \'PROCESSED\'')) {
      const [pat, s, ser] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r) { r.status = 'PROCESSED'; r.processed_at = pat; meta.changes = 1; }
    }
    if (this.query.includes('UPDATE event_receipts SET status = \'FAILED\'')) {
      const [err, s, ser] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r) { r.status = 'FAILED'; r.last_error = err; meta.changes = 1; }
    }
    if (this.query.includes('INSERT INTO outbound_operations')) {
      const [id, cid, dp, ot, st, cat, uat] = this.boundParams;
      if (!this.db.tables.outbound_operations.find(x => x.id === id)) {
        this.db.tables.outbound_operations.push({
          id, conversation_id: cid, destination_provider: dp, operation_type: ot,
          status: st, attempt_count: 0, created_at: cat, updated_at: uat
        });
        meta.changes = 1;
      } else {
        throw new Error('UNIQUE');
      }
    }
    if (this.query.includes("status = 'SENDING'") && this.query.includes("attempt_count + 1")) {
      const [lu, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && (o.status === 'PENDING' || o.status === 'FAILED_RETRYABLE')) {
        o.status = 'SENDING'; o.lease_until = lu; o.attempt_count++;
        meta.changes = 1;
      }
    }
    if (this.query.includes("status = 'SENT'")) {
      const [pmr, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) { o.status = 'SENT'; o.provider_message_ref = pmr; meta.changes = 1; }
    }
    if (this.query.includes("status = 'FAILED_RETRYABLE'")) {
      const [err, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) { o.status = 'FAILED_RETRYABLE'; o.last_error = err; meta.changes = 1; }
    }
    if (this.query.includes("status = 'FAILED_FINAL'")) {
      const [now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o) { o.status = 'FAILED_FINAL'; meta.changes = 1; }
    }
    if (this.query.includes("status = 'AMBIGUOUS'")) {
      const [now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && o.status === 'SENDING') { o.status = 'AMBIGUOUS'; meta.changes = 1; }
    }
    
    return { meta };
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
      eventId: 'cw-evt-1', source: 'chatwoot', type: 'message_created',
      payload: { account: { id: 1 }, conversation: { id: 2 }, sender: { id: 3, type: 'contact' }, id: 4, content: 'Hello', message_type: 0 }
    };
    await handleQueueEvent(event, env);
    const db = env.DB as MockD1;
    expect(db.tables.event_receipts[0].status).toBe('PROCESSED');
    expect(db.tables.conversations.length).toBe(1);
    expect(db.tables.messages.length).toBe(1);
    expect(db.tables.outbound_operations.length).toBe(2);
    expect(db.tables.outbound_operations[0].status).toBe('SENT');
  });

  it('handles concurrent duplicate event safely (atomic claim)', async () => {
    const event: SupportEvent = {
      eventId: 'cw-evt-concurrent', source: 'chatwoot', type: 'message_created',
      payload: { account: { id: 1 }, conversation: { id: 2 }, sender: { id: 3 }, id: 4, content: 'Hi', message_type: 0 }
    };
    // Promise.all tests concurrency
    const results = await Promise.allSettled([
      handleQueueEvent(event, env),
      handleQueueEvent(event, env)
    ]);
    
    // One should succeed, one should reject (or return safely depending on locking)
    // Wait, if it fails to lock, it throws "Event locked by another worker"
    const db = env.DB as MockD1;
    expect(db.tables.event_receipts.length).toBe(1);
    expect(db.tables.messages.length).toBe(1); // Only 1 provider side effect
    expect(global.fetch).toHaveBeenCalledTimes(2); // create topic + send message
  });

  it('bounds retry attempts and handles ambiguous delivery', async () => {
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99'
    });
    
    // Setup an outbound op stuck in SENDING and expired
    db.tables.outbound_operations.push({
      id: 'send_chatwoot_301', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
      status: 'SENDING', attempt_count: 1, lease_until: Math.floor(Date.now() / 1000) - 100, created_at: 0, updated_at: 0
    });

    const event: SupportEvent = {
      eventId: 'tg-evt-2', source: 'telegram', type: 'message_created',
      payload: { message: { message_thread_id: 99, message_id: 301, text: 'Fail reply' } }
    };

    await handleQueueEvent(event, env);
    expect(db.tables.outbound_operations[0].status).toBe('AMBIGUOUS');
    // And NO fetch should be made!
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('topic lifecycle events', async () => {
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99'
    });

    const eventRes: SupportEvent = {
      eventId: 'cw-evt-res', source: 'chatwoot', type: 'conversation_status_changed',
      payload: { account: { id: 1 }, id: 2, status: 'resolved' }
    };
    await handleQueueEvent(eventRes, env);
    expect(db.tables.outbound_operations.some(o => o.operation_type === 'CLOSE_TOPIC')).toBe(true);

    const eventOpen: SupportEvent = {
      eventId: 'cw-evt-open', source: 'chatwoot', type: 'conversation_status_changed',
      payload: { account: { id: 1 }, id: 2, status: 'open' }
    };
    await handleQueueEvent(eventOpen, env);
    expect(db.tables.outbound_operations.some(o => o.operation_type === 'REOPEN_TOPIC')).toBe(true);
  });
});
