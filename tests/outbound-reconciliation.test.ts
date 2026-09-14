import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHATWOOT_RECONCILIATION_LIMITS,
  manualCancel,
  manualMarkDelivered,
  reconcileOutboundOperation
} from '../src/core/outbound-reconciliation';
import { OutboundOperation } from '../src/core/domain';
import { OutboundTargetEvidence } from '../src/core/outbound-evidence';

class ReconciliationDb {
  operations = new Map<string, OutboundOperation>();
  audits: any[] = [];
  private previousChanges = 0;
  private batchTail: Promise<void> = Promise.resolve();

  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      first: async () => {
        if (!query.includes('FROM outbound_operations')) return null;
        const row = this.operations.get(String(params[0]));
        if (!row) return null;
        if (query.includes("status = 'AMBIGUOUS'") && row.status !== 'AMBIGUOUS') return null;
        return structuredClone(row);
      },
      run: async () => {
        let changes = 0;
        if (query.includes('SET reconciliation_status = ?')) {
          const [next, providerRef, resolvedBy, resolvedAt, reason, updatedAt, id, old] = params;
          const row = this.operations.get(String(id));
          if (row?.status === 'AMBIGUOUS' && row.reconciliation_status === old) {
            row.reconciliation_status = next;
            if (providerRef !== null) row.provider_message_ref = String(providerRef);
            row.resolved_by = resolvedBy;
            row.resolved_at = resolvedAt;
            row.resolution_reason = reason;
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (query.includes('INSERT INTO reliability_audit')) {
          if (this.previousChanges === 1) {
            this.audits.push({
              id: params[0], entity_type: params[1], entity_id: params[2], action: params[3],
              actor_type: params[4], actor_ref: params[5], old_state: params[6], new_state: params[7],
              reason_code: params[8], created_at: params[9]
            });
            changes = 1;
          }
        } else {
          throw new Error(`UNMATCHED QUERY: ${query}`);
        }
        this.previousChanges = changes;
        return { meta: { changes } };
      }
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<any> }>) {
    const previousBatch = this.batchTail;
    let release!: () => void;
    this.batchTail = new Promise<void>(resolve => { release = resolve; });
    await previousBatch;
    const snapshot = structuredClone({
      operations: [...this.operations.entries()],
      audits: this.audits
    });
    this.previousChanges = 0;
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.operations = new Map(snapshot.operations);
      this.audits = snapshot.audits;
      throw error;
    } finally {
      release();
    }
  }
}

const chatwootEvidence: OutboundTargetEvidence = {
  version: 1,
  provider: 'chatwoot',
  accountRef: '1',
  conversationRef: '2',
  sourceId: 'cz2128:op-1',
  apiUrlSource: 'ENV',
  apiOriginFingerprint: 'a'.repeat(64)
};

const telegramEvidence: OutboundTargetEvidence = {
  version: 1,
  provider: 'telegram',
  supportProfileSource: 'ENV',
  botGroupIdSource: 'ENV',
  groupRef: '-1001',
  threadRef: '7',
  method: 'sendMessage'
};

function operation(evidence: OutboundTargetEvidence, overrides: Partial<OutboundOperation> = {}): OutboundOperation {
  return {
    id: 'op-1', conversation_id: 'conv-1', destination_provider: evidence.provider,
    operation_type: 'SEND_MESSAGE', status: 'AMBIGUOUS', provider_message_ref: null,
    attempt_count: 1, lease_until: null, lease_token: null,
    last_error: 'OUTBOUND_TRANSPORT_AMBIGUOUS', created_at: 1, updated_at: 1,
    request_started_at: 1, response_observed_at: null, response_http_status: null,
    next_retry_at: null, retry_after_seconds: null, reconciliation_status: 'PENDING',
    resolved_by: null, resolved_at: null, resolution_reason: null, parent_operation_id: null,
    subject_type: 'MESSAGE', subject_ref: 'message:1', target_evidence_json: JSON.stringify(evidence),
    ...overrides
  };
}

function env(db: ReconciliationDb) {
  return {
    DB: db,
    CHATWOOT_API_URL: 'https://chatwoot.example',
    CHATWOOT_API_TOKEN: 'chatwoot-secret'
  } as any;
}

describe('outbound reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('confirms a unique exact Chatwoot source_id and persists the provider message id', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ payload: [{ id: 91, source_id: 'cz2128:op-1' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ payload: [] }), { status: 200 }));

    const response = await reconcileOutboundOperation(env(db), 'op-1', chatwootEvidence);

    expect(response).toMatchObject({
      operationStatus: 'AMBIGUOUS', reconciliationStatus: 'CONFIRMED_SENT', providerMessageRef: '91'
    });
    expect(db.operations.get('op-1')?.status).toBe('AMBIGUOUS');
    expect(db.operations.get('op-1')?.resolved_by).toBe('system:chatwoot-source-id');
    expect(db.audits).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([
    ['zero matches', [{ id: 1, source_id: 'other' }], 'CHATWOOT_SOURCE_ID_NOT_FOUND_BOUNDED'],
    ['multiple exact matches', [
      { id: 1, source_id: 'cz2128:op-1' }, { id: 2, source_id: 'cz2128:op-1' }
    ], 'CHATWOOT_SOURCE_ID_DUPLICATE'],
    ['wrong source_id', [{ id: 1, source_id: 'cz2128:other' }], 'CHATWOOT_SOURCE_ID_NOT_FOUND_BOUNDED']
  ] as const)('keeps %s STILL_AMBIGUOUS', async (_label, messages, reason) => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ payload: messages }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ payload: [] }), { status: 200 }));

    const response = await reconcileOutboundOperation(env(db), 'op-1', chatwootEvidence);
    expect(response.reconciliationStatus).toBe('STILL_AMBIGUOUS');
    expect(db.operations.get('op-1')?.resolution_reason).toBe(reason);
    expect(db.operations.get('op-1')?.reconciliation_status).not.toBe('CONFIRMED_NOT_SENT');
  });

  it('bounds Chatwoot pagination without inferring CONFIRMED_NOT_SENT', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));
    const page = Array.from({ length: 100 }, (_, index) => ({ id: index, source_id: 'other' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ payload: page }), { status: 200 })
    );

    const response = await reconcileOutboundOperation(env(db), 'op-1', chatwootEvidence);
    expect(fetchMock).toHaveBeenCalledTimes(CHATWOOT_RECONCILIATION_LIMITS.pages);
    expect(response.reconciliationStatus).toBe('STILL_AMBIGUOUS');
  });

  it.each([
    ['429', () => new Response('', { status: 429, headers: { 'Retry-After': '10' } })],
    ['4xx', () => new Response('', { status: 403 })],
    ['5xx', () => new Response('', { status: 503 })],
    ['invalid JSON', () => new Response('{', { status: 200 })]
  ])('keeps reconciliation PENDING on Chatwoot %s failure and never sends', async (_label, response) => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());

    await expect(reconcileOutboundOperation(env(db), 'op-1', chatwootEvidence)).rejects.toBeTruthy();
    expect(db.operations.get('op-1')?.reconciliation_status).toBe('PENDING');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('keeps reconciliation PENDING on transport failure', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private provider failure'));

    await expect(reconcileOutboundOperation(env(db), 'op-1', chatwootEvidence)).rejects.toMatchObject({
      code: 'RECONCILIATION_PROVIDER_UNAVAILABLE'
    });
    expect(db.operations.get('op-1')?.reconciliation_status).toBe('PENDING');
  });

  it('does not query a changed Chatwoot target', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const changed = { ...chatwootEvidence, conversationRef: 'changed' };

    const response = await reconcileOutboundOperation(env(db), 'op-1', changed);
    expect(response.reconciliationStatus).toBe('STILL_AMBIGUOUS');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits[0].action).toBe('TARGET_IDENTITY_REJECTED');
  });

  it('keeps Telegram ambiguity manual without provider lookup', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(telegramEvidence));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await reconcileOutboundOperation(env(db), 'op-1', telegramEvidence);
    expect(response.reconciliationStatus).toBe('STILL_AMBIGUOUS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists manual mark-delivered and cancel resolutions without provider action', async () => {
    const deliveredDb = new ReconciliationDb();
    deliveredDb.operations.set('op-1', operation(chatwootEvidence));
    const cancelledDb = new ReconciliationDb();
    cancelledDb.operations.set('op-1', operation(chatwootEvidence));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const delivered = await manualMarkDelivered(
      env(deliveredDb), 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', 'provider-1'
    );
    const cancelled = await manualCancel(
      env(cancelledDb), 'op-1', { type: 'ADMIN', ref: '43' }, 'OPERATOR_CANCELLED'
    );

    expect(delivered).toMatchObject({ reconciliationStatus: 'MANUAL_MARK_DELIVERED', providerMessageRef: 'provider-1' });
    expect(cancelled.reconciliationStatus).toBe('MANUAL_CANCELLED');
    expect(deliveredDb.audits).toHaveLength(1);
    expect(cancelledDb.audits).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a topic reference before manually marking CREATE_TOPIC delivered', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(telegramEvidence, { operation_type: 'CREATE_TOPIC' }));
    await expect(manualMarkDelivered(
      env(db), 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY'
    )).rejects.toMatchObject({ code: 'OUTBOUND_RECONCILIATION_NOT_ELIGIBLE' });
    expect(db.audits).toHaveLength(0);
  });

  it('rejects manual resolution for a non-AMBIGUOUS delivery row', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence, {
      status: 'SENT', reconciliation_status: 'NOT_REQUIRED'
    }));
    await expect(manualCancel(
      env(db), 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CANCELLED'
    )).rejects.toMatchObject({ code: 'OUTBOUND_RECONCILIATION_NOT_ELIGIBLE' });
    expect(db.audits).toHaveLength(0);
  });

  it('allows only one competing manual resolution CAS to win and audit', async () => {
    const db = new ReconciliationDb();
    db.operations.set('op-1', operation(chatwootEvidence));

    await Promise.all([
      manualMarkDelivered(
        env(db), 'op-1', { type: 'ADMIN', ref: '42' }, 'OPERATOR_CONFIRMED_DELIVERY', 'provider-1'
      ),
      manualCancel(env(db), 'op-1', { type: 'ADMIN', ref: '43' }, 'OPERATOR_CANCELLED')
    ]);

    expect(['MANUAL_MARK_DELIVERED', 'MANUAL_CANCELLED']).toContain(
      db.operations.get('op-1')?.reconciliation_status
    );
    expect(db.audits).toHaveLength(1);
  });
});
