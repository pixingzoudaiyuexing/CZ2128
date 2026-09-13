import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { SupportEvent } from '../src/core/events';
import { getOrCreateConversation } from '../src/core/conversation-service';

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
      if (this.query.includes('WHERE id = ?')) {
        const o = this.db.tables.conversations.find(c => c.id === this.boundParams[0]);
        return o ? { ...o } : null;
      }
      if (this.query.includes('operator_thread_ref')) {
        const [c, r] = this.boundParams;
        const o = this.db.tables.conversations.find(x => x.operator_channel === c && x.operator_thread_ref === r);
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
      if (c && !c.operator_thread_ref) {
        c.operator_thread_ref = r; c.updated_at = uat; c.version += 1; meta.changes = 1;
      }
    }
    if (this.query.includes('SET operator_thread_status = ?')) {
      const [nextStatus, updatedAt, id, expectedVersion, expectedStatus] = this.boundParams;
      const c = this.db.tables.conversations.find(x => x.id === id);
      if (c && c.version === expectedVersion && (c.operator_thread_status || 'OPEN') === expectedStatus) {
        c.operator_thread_status = nextStatus; c.updated_at = updatedAt; c.version += 1; meta.changes = 1;
      }
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
      const [s, ser, lu, claimToken] = this.boundParams;
      if (!this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser)) {
        this.db.tables.event_receipts.push({
          source: s, source_event_ref: ser, status: 'PROCESSING', attempt_count: 1, lease_until: lu, claim_token: claimToken
        });
        meta.changes = 1;
      }
    }
    if (this.query.includes("SET status = 'PROCESSING', attempt_count = attempt_count + 1")) {
      const [lu, claimToken, s, ser, now] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r && (r.status === 'FAILED' || (r.status === 'PROCESSING' && r.lease_until <= now))) {
        r.status = 'PROCESSING';
        r.attempt_count++;
        r.lease_until = lu;
        r.claim_token = claimToken;
        meta.changes = 1;
      }
    }
    if (this.query.includes('UPDATE event_receipts SET status = \'PROCESSED\'')) {
      const [pat, s, ser, claimToken] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r?.status === 'PROCESSING' && r.claim_token === claimToken) {
        r.status = 'PROCESSED'; r.processed_at = pat; r.lease_until = null; r.claim_token = null; meta.changes = 1;
      }
    }
    if (this.query.includes('UPDATE event_receipts SET status = \'FAILED\'')) {
      const [err, s, ser, claimToken] = this.boundParams;
      const r = this.db.tables.event_receipts.find(x => x.source === s && x.source_event_ref === ser);
      if (r?.status === 'PROCESSING' && r.claim_token === claimToken) {
        r.status = 'FAILED'; r.last_error = err; r.lease_until = null; r.claim_token = null; meta.changes = 1;
      }
    }
    if (this.query.includes('INSERT INTO outbound_operations')) {
      const [id, cid, dp, ot, st, cat, uat] = this.boundParams;
      if (!this.db.tables.outbound_operations.find(x => x.id === id)) {
        this.db.tables.outbound_operations.push({
          id, conversation_id: cid, destination_provider: dp, operation_type: ot,
          status: st, attempt_count: 0, created_at: cat, updated_at: uat
        });
        meta.changes = 1;
      }
    }
    if (this.query.includes("status = 'SENDING'") && this.query.includes("attempt_count + 1")) {
      const [lu, leaseToken, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && (o.status === 'PENDING' || o.status === 'FAILED_RETRYABLE')) {
        o.status = 'SENDING'; o.lease_until = lu; o.lease_token = leaseToken; o.attempt_count++;
        meta.changes = 1;
      }
    }
    if (this.query.includes("status = 'SENT'")) {
      const [pmr, now, id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o?.status === 'SENDING' && o.lease_token === leaseToken) {
        o.status = 'SENT'; o.provider_message_ref = pmr; o.lease_until = null; o.lease_token = null; meta.changes = 1;
      }
    }
    if (this.query.includes('SET status = ?, last_error = ?')) {
      const [status, err, now, id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o?.status === 'SENDING' && o.lease_token === leaseToken) {
        o.status = status; o.last_error = err; o.lease_until = null; o.lease_token = null; meta.changes = 1;
      }
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

function chatwootMessageEvent(
  eventId: string,
  messageRef: string,
  content: string,
  actorRole: 'CUSTOMER' | 'OPERATOR' = 'CUSTOMER',
  customerName?: string
): SupportEvent {
  return {
    version: 1,
    eventId,
    source: 'chatwoot',
    type: 'message_created',
    payload: {
      accountRef: '1',
      conversationRef: '2',
      customerRef: '3',
      customerName,
      messageRef,
      content,
      actorRole
    }
  };
}

function telegramMessageEvent(eventId: string, messageRef: string, threadRef: string, content: string): SupportEvent {
  return {
    version: 1,
    eventId,
    source: 'telegram',
    type: 'message_created',
    payload: { updateRef: eventId, messageRef, threadRef, content }
  };
}

describe('Queue Event Processing', () => {
  let env: any;

  beforeEach(() => {
    env = {
      DB: new MockD1(),
      QUEUE: new (class { async send() {} })(), BOT_GROUP_ID: '-1001',
      CHATWOOT_API_TOKEN: 'token',
      CHATWOOT_API_URL: 'http://chatwoot',
      TELEGRAM_BOT_TOKEN: 'tg_token'
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_thread_id: 99, message_id: 100 }, id: 200 })
    });
  });

  it('handles customer Chatwoot message -> creates topic and sends to Telegram', async () => {
    const event = chatwootMessageEvent('cw-evt-1', '4', 'Hello');
    await handleQueueEvent(event, env);
    const db = env.DB as MockD1;
    expect(db.tables.event_receipts[0].status).toBe('PROCESSED');
    expect(db.tables.conversations.length).toBe(1);
    expect(db.tables.messages.length).toBe(1);
    expect(db.tables.outbound_operations.length).toBe(2);
    expect(db.tables.outbound_operations[0].status).toBe('SENT');
  });

  it('handles concurrent duplicate event safely (atomic claim)', async () => {
    const event = chatwootMessageEvent('cw-evt-concurrent', '4', 'Hi');
    // Promise.all tests concurrency
    const results = await Promise.allSettled([
      handleQueueEvent(event, env),
      handleQueueEvent(event, env)
    ]);
    
    const db = env.DB as MockD1;
    expect(db.tables.event_receipts.length).toBe(1);
    expect(db.tables.messages.length).toBe(1); // Only 1 provider side effect
    expect(global.fetch).toHaveBeenCalledTimes(2); // create topic + send message
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('protects conversation creation with the database unique key', async () => {
    const [first, second] = await Promise.all([
      getOrCreateConversation(env, 'chatwoot', '1', '2', '3'),
      getOrCreateConversation(env, 'chatwoot', '1', '2', '3')
    ]);
    const db = env.DB as MockD1;
    expect(db.tables.conversations).toHaveLength(1);
    expect(first.id).toBe(second.id);
  });

  it('serializes topic creation across different events and delivers both after retry', async () => {
    const firstEvent = chatwootMessageEvent('cw-topic-race-1', '41', 'First', 'CUSTOMER', 'Customer');
    const secondEvent = chatwootMessageEvent('cw-topic-race-2', '42', 'Second', 'CUSTOMER', 'Customer');

    const concurrent = await Promise.allSettled([
      handleQueueEvent(firstEvent, env),
      handleQueueEvent(secondEvent, env)
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);

    const retryEvent = concurrent[0].status === 'rejected' ? firstEvent : secondEvent;
    await handleQueueEvent(retryEvent, env);

    const db = env.DB as MockD1;
    expect(db.tables.conversations).toHaveLength(1);
    expect(db.tables.outbound_operations.filter(operation => operation.id.startsWith('create_topic_'))).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('bounds retry attempts and handles ambiguous delivery', async () => {
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99', operator_thread_status: 'OPEN', version: 1
    });
    
    db.tables.outbound_operations.push({
      id: 'send_chatwoot_301', conversation_id: 'conv-1', destination_provider: 'chatwoot', operation_type: 'SEND_MESSAGE',
      status: 'SENDING', attempt_count: 1, lease_until: Math.floor(Date.now() / 1000) - 100, created_at: 0, updated_at: 0
    });

    const event = telegramMessageEvent('tg-evt-2', '301', '99', 'Fail reply');

    await handleQueueEvent(event, env);
    expect(db.tables.outbound_operations[0].status).toBe('AMBIGUOUS');
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('topic lifecycle events', async () => {
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99', operator_thread_status: 'OPEN', version: 1
    });

    const eventRes: SupportEvent = {
      version: 1, eventId: 'cw-evt-res', source: 'chatwoot', type: 'conversation_status_changed',
      payload: { accountRef: '1', conversationRef: '2', status: 'resolved' }
    };
    await handleQueueEvent(eventRes, env);
    expect(db.tables.outbound_operations.some(o => o.operation_type === 'CLOSE_TOPIC')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await handleQueueEvent({ ...eventRes, eventId: 'cw-evt-res-duplicate' }, env);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(db.tables.conversations[0].operator_thread_status).toBe('CLOSED');

    const eventOpen: SupportEvent = {
      version: 1, eventId: 'cw-evt-open', source: 'chatwoot', type: 'conversation_status_changed',
      payload: { accountRef: '1', conversationRef: '2', status: 'open' }
    };
    await handleQueueEvent(eventOpen, env);
    expect(db.tables.outbound_operations.some(o => o.operation_type === 'REOPEN_TOPIC')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await handleQueueEvent({ ...eventOpen, eventId: 'cw-evt-open-duplicate' }, env);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(db.tables.conversations[0].operator_thread_status).toBe('OPEN');

    await handleQueueEvent({ ...eventRes, eventId: 'cw-evt-res-next-cycle' }, env);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(db.tables.outbound_operations.filter(o => o.operation_type === 'CLOSE_TOPIC')).toHaveLength(2);
  });

  it('reuses an existing topic for later Chatwoot messages', async () => {
    const first = chatwootMessageEvent('cw-reuse-1', '51', 'First', 'CUSTOMER', 'Alice');
    const second = chatwootMessageEvent('cw-reuse-2', '52', 'Second', 'CUSTOMER', 'Alice Updated');

    await handleQueueEvent(first, env);
    await handleQueueEvent(second, env);

    const db = env.DB as MockD1;
    expect(db.tables.outbound_operations.filter(operation => operation.id.startsWith('create_topic_'))).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const createTopicBody = JSON.parse(String((global.fetch as any).mock.calls[0][1].body));
    expect(createTopicBody.name).toBe('Alice | Chatwoot #2');
  });

  it('does not suppress different provider messages with identical text', async () => {
    const first = chatwootMessageEvent('cw-identical-1', '61', 'Same text');
    const second = chatwootMessageEvent('cw-identical-2', '62', 'Same text');

    await handleQueueEvent(first, env);
    await handleQueueEvent(second, env);

    const db = env.DB as MockD1;
    expect(db.tables.messages.filter(message => message.text_content === 'Same text')).toHaveLength(2);
    expect(db.tables.outbound_operations.filter(operation => operation.id.startsWith('send_tg_'))).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects unsupported queue envelope versions', async () => {
    const event = { ...chatwootMessageEvent('cw-v2', '63', 'Future'), version: 2 };
    await expect(handleQueueEvent(event as any, env)).rejects.toThrow('Unsupported queue event version');
    const db = env.DB as MockD1;
    expect(db.tables.event_receipts).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  it('delivers a duplicate Telegram operator update to Chatwoot once with source_id', async () => {
    const db = env.DB as MockD1;
    db.tables.conversations.push({
      id: 'conv-1', helpdesk_provider: 'chatwoot', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2',
      operator_channel: 'telegram', operator_thread_ref: '99'
    });
    const event = telegramMessageEvent('tg_701', '301', '99', 'Reply');

    await handleQueueEvent(event, env);
    await handleQueueEvent(event, env);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((global.fetch as any).mock.calls[0][1].body));
    expect(body.source_id).toBe('cz2128:send_chatwoot_301');
  });

  describe('Chatwoot Handler logic', () => {
    it('message_type="incoming" -> Telegram exactly once', async () => {
      const event = chatwootMessageEvent('cw-evt-inc', '4', 'Hi');
      await handleQueueEvent(event, env);
      const db = env.DB as MockD1;
      expect(db.tables.messages.find(m => m.provider_message_ref === '4')).toBeTruthy();
      expect(global.fetch).toHaveBeenCalledTimes(2); // create topic + send tg
    });

    it('message_type="outgoing" human operator -> Telegram exactly once', async () => {
      const event = chatwootMessageEvent('cw-evt-out', '6', 'Reply', 'OPERATOR');
      await handleQueueEvent(event, env);
      await handleQueueEvent(event, env);
      const db = env.DB as MockD1;
      expect(db.tables.messages.find(m => m.provider_message_ref === '6')).toBeTruthy();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

  });
});
