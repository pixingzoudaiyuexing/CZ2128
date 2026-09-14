import { describe, expect, it, vi } from 'vitest';
import { executeOutboundOperation } from '../src/core/outbound-operations';
import { ProviderDeliveryError, RetryableProcessingError } from '../src/core/errors';

interface OperationRow {
  id: string;
  conversation_id: string;
  destination_provider: string;
  operation_type: string;
  status: string;
  provider_message_ref: string | null;
  attempt_count: number;
  lease_until: number | null;
  lease_token?: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  request_started_at?: number | null;
  response_observed_at?: number | null;
  response_http_status?: number | null;
  reconciliation_status?: string | null;
  retry_after_seconds?: number | null;
  next_retry_at?: number | null;
}

class OperationDb {
  rows = new Map<string, OperationRow>();
  failSentUpdates = false;
  failResponseObservedUpdates = false;

  prepare(query: string) {
    let params: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        params = values;
        return statement;
      },
      first: async () => {
        if (!query.includes('FROM outbound_operations')) return null;
        const row = this.rows.get(String(params[0]));
        return row ? { ...row } : null;
      },
      run: async () => this.run(query, params)
    };
    return statement;
  }

  private run(query: string, params: unknown[]) {
    let changes = 0;
    if (query.includes('INSERT INTO outbound_operations')) {
      const [id, conversationId, destinationProvider, operationType, , createdAt, updatedAt] = params;
      const key = String(id);
      if (!this.rows.has(key)) {
        this.rows.set(key, {
          id: key,
          conversation_id: String(conversationId),
          destination_provider: String(destinationProvider),
          operation_type: String(operationType),
          status: 'PENDING',
          provider_message_ref: null,
          attempt_count: 0,
          lease_until: null,
          lease_token: null,
          last_error: null,
          created_at: Number(createdAt),
          updated_at: Number(updatedAt),
          request_started_at: null,
          response_observed_at: null,
          response_http_status: null,
          reconciliation_status: null,
          retry_after_seconds: null,
          next_retry_at: null
        });
        changes = 1;
      }
    } else if (query.includes("status = 'SENDING', lease_until = ?")) {
      const [leaseUntil, leaseToken, updatedAt, id] = params;
      const row = this.rows.get(String(id));
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'SENDING';
        row.lease_until = Number(leaseUntil);
        row.lease_token = String(leaseToken);
        row.updated_at = Number(updatedAt);
        row.request_started_at = null;
        changes = 1;
      }
    } else if (query.includes("request_started_at = ?, attempt_count = attempt_count + 1")) {
      const [ts, , id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && row.lease_token === leaseToken && row.request_started_at === null) {
        row.request_started_at = Number(ts);
        row.attempt_count += 1;
        row.last_error = null;
        row.updated_at = Number(ts);
        changes = 1;
      }
    } else if (query.includes("response_observed_at = ?")) {
      const [ts, httpStatus, , id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && !this.failResponseObservedUpdates && row.status === 'SENDING' && row.lease_token === leaseToken && row.request_started_at !== null) {
        row.response_observed_at = Number(ts);
        row.response_http_status = Number(httpStatus);
        row.last_error = null;
        row.updated_at = Number(ts);
        changes = 1;
      }
    } else if (query.includes("status = 'PENDING', lease_until = NULL, lease_token = NULL,") && query.includes("request_started_at IS NULL")) {
      const [updatedAt, id, leaseUntilThreshold, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && (row.lease_until || 0) <= Number(leaseUntilThreshold) && row.lease_token === leaseToken && row.request_started_at === null) {
        row.status = 'PENDING';
        row.lease_until = null;
        row.lease_token = null;
        row.request_started_at = null;
        row.response_observed_at = null;
        row.response_http_status = null;
        row.retry_after_seconds = null;
        row.next_retry_at = null;
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("status = 'AMBIGUOUS', reconciliation_status = 'PENDING'") && query.includes("lease_until IS NULL OR lease_token IS NULL")) {
      const [updatedAt, id] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && (row.lease_until === null || row.lease_token === null)) {
        row.status = 'AMBIGUOUS';
        row.reconciliation_status = 'PENDING';
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("status = 'AMBIGUOUS', reconciliation_status = 'PENDING'") && query.includes("lease_until <=")) {
      const [updatedAt, id, leaseUntilThreshold, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && (row.lease_until || 0) <= Number(leaseUntilThreshold) && row.lease_token === leaseToken) {
        row.status = 'AMBIGUOUS';
        row.reconciliation_status = 'PENDING';
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("status = 'FAILED_FINAL', last_error = 'OUTBOUND_RETRY_EXHAUSTED'")) {
      const row = this.rows.get(String(params[1]));
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'FAILED_FINAL';
        row.last_error = 'OUTBOUND_RETRY_EXHAUSTED';
        row.updated_at = Number(params[0]);
        changes = 1;
      }
    } else if (query.includes("SET status = ?, last_error = ?, lease_until = NULL")) {
      const [status, lastError, reconciliationStatus, retryAfterSecs, nextRetryAt, updatedAt, id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = String(status);
        row.last_error = String(lastError);
        row.lease_until = null;
        row.lease_token = null;
        row.reconciliation_status = String(reconciliationStatus);
        row.retry_after_seconds = retryAfterSecs === null ? null : Number(retryAfterSecs);
        row.next_retry_at = nextRetryAt === null ? null : Number(nextRetryAt);
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("status = 'AMBIGUOUS', last_error = 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED'")) {
      const [updatedAt, id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = 'AMBIGUOUS';
        row.last_error = 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED';
        row.lease_until = null;
        row.lease_token = null;
        row.reconciliation_status = 'PENDING';
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("status = 'SENT'") && query.includes("provider_message_ref = ?")) {
      const [providerRef, updatedAt, id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (!this.failSentUpdates && row?.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = 'SENT';
        row.provider_message_ref = providerRef === null ? null : String(providerRef);
        row.lease_until = null;
        row.lease_token = null;
        row.reconciliation_status = 'NOT_REQUIRED';
        row.last_error = null;
        row.retry_after_seconds = null;
        row.next_retry_at = null;
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("status = 'FAILED_FINAL', last_error = ?")) {
      const row = this.rows.get(String(params[2]));
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'FAILED_FINAL';
        row.last_error = String(params[0]);
        row.lease_until = null;
        row.lease_token = null;
        row.updated_at = Number(params[1]);
        changes = 1;
      }
    } else {
      throw new Error('UNMATCHED QUERY: ' + query);
    }
    return { meta: { changes } };
  }
}

function makeEnv(db: OperationDb) {
  return { DB: db } as any;
}

// Add our tests here
describe('outbound operation attempt lifecycle', () => {

  it('Identity Collision: prevents identical operation id across different contexts', async () => {
    const db = new OperationDb();
    
    const action1 = vi.fn(async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(200);
      return { providerMessageRef: 'ok' };
    });

    await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action1, 'op-collision-id');

    const action2 = vi.fn();
    
    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'chatwoot', 'SEND_MESSAGE', action2, 'op-collision-id'))
      .rejects.toThrowError(/Outbound operation identity collision/);
      
    expect(action2).not.toHaveBeenCalled();
  });

  it('Real Simultaneous Worker Test: only one worker owns lease and succeeds', async () => {
    const db = new OperationDb();

    let resolveAPause: any;
    const aPause = new Promise(r => resolveAPause = r);
    const visibleEffect = vi.fn();

    const actionA = async (opId: string, lifecycle: any) => {
      await aPause; // wait for B to try to claim
      await lifecycle.requestStarted();
      visibleEffect();
      await lifecycle.responseObserved(200);
      return { providerMessageRef: 'ok-a' };
    };

    const actionB = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      visibleEffect();
      await lifecycle.responseObserved(200);
      return { providerMessageRef: 'ok-b' };
    };

    // A starts and will pause inside its action
    const pA = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', actionA, 'op-simul-race');
    
    // Give A a moment to start and claim the lease
    await new Promise(r => setTimeout(r, 50));

    // B starts concurrently while A is holding the lease
    const pB = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', actionB, 'op-simul-race');

    // B should immediately fail with CONCURRENCY_LEASE_HELD
    await expect(pB).rejects.toThrowError(RetryableProcessingError);
    try {
      await pB;
    } catch (e: any) {
      expect(e.code).toBe('CONCURRENCY_LEASE_HELD');
    }

    // Now A can continue
    resolveAPause();
    const resA = await pA;
    expect(resA).toEqual({ status: 'SENT', providerMessageRef: 'ok-a' });

    expect(visibleEffect).toHaveBeenCalledTimes(1);

    const row = db.rows.get('op-simul-race')!;
    expect(row.status).toBe('SENT');
  });

  it('True Stale Owner Race: throws CONCURRENCY_CAS_CONFLICT without mutating B state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      const aVisibleEffect = vi.fn();

      let lifecycleA: any;
      let resolveA_HAS_CLAIMED: any;
      const aHasClaimed = new Promise(r => resolveA_HAS_CLAIMED = r);

      let resolveAResume: any;
      const aResume = new Promise(r => resolveAResume = r);

      const actionA = async (opId: string, lifecycle: any) => {
        lifecycleA = lifecycle;
        resolveA_HAS_CLAIMED();
        await aResume;
        
        await lifecycleA.requestStarted();
        aVisibleEffect();
        await lifecycleA.responseObserved(200);
        return { providerMessageRef: 'ok-a' };
      };

      const pA = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', actionA, 'op-true-race');

      await aHasClaimed;

      // Verify DB state for A
      const rowA = db.rows.get('op-true-race')!;
      expect(rowA.status).toBe('SENDING');
      expect(rowA.request_started_at).toBeNull();
      expect(rowA.attempt_count).toBe(0);

      // Expire A
      vi.advanceTimersByTime(35 * 1000); // > 30s

      const actionB = async (opId: string, lifecycle: any) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(200);
        return { providerMessageRef: 'ok-b' };
      };

      const pB = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', actionB, 'op-true-race');
      const resultB = await pB;
      expect(resultB.status).toBe('SENT');
      expect(resultB.providerMessageRef).toBe('ok-b');

      // Now B is done. Let's resume A
      resolveAResume();
      
      // A should throw CONCURRENCY_CAS_CONFLICT
      await expect(pA).rejects.toThrowError(RetryableProcessingError);
      
      try {
        await pA;
      } catch (e: any) {
        expect(e.code).toBe('CONCURRENCY_CAS_CONFLICT');
      }

      // Assert visible side effects
      expect(aVisibleEffect).not.toHaveBeenCalled();

      // Assert B's state remains intact
      const rowFinal = db.rows.get('op-true-race')!;
      expect(rowFinal.status).toBe('SENT');
      expect(rowFinal.provider_message_ref).toBe('ok-b');
      expect(rowFinal.attempt_count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Active NULL Token: future lease_until but NULL token must be treated as malformed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.rows.set('op-active-null', {
        id: 'op-active-null', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 0,
        lease_until: Math.floor(Date.now() / 1000) + 30, lease_token: null, last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      const action = vi.fn();
      const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-active-null');
      
      expect(res).toEqual({ status: 'AMBIGUOUS' });
      expect(action).not.toHaveBeenCalled();

      const row = db.rows.get('op-active-null')!;
      expect(row.status).toBe('AMBIGUOUS');
      expect(row.reconciliation_status).toBe('PENDING');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Malformed SENDING must fail safe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.rows.set('op-malformed', {
        id: 'op-malformed', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 0,
        lease_until: null, lease_token: null, last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', vi.fn(), 'op-malformed')).resolves.toEqual({ status: 'AMBIGUOUS' });
      const row = db.rows.get('op-malformed')!;
      expect(row.status).toBe('AMBIGUOUS');
      expect(row.reconciliation_status).toBe('PENDING');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Legacy SENDING with valid lease blocks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.rows.set('op-legacy-active', {
        id: 'op-legacy-active', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 0,
        lease_until: Math.floor(Date.now() / 1000) + 30, lease_token: 'old-token', last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', vi.fn(), 'op-legacy-active')).rejects.toThrow(/lease/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Safe Pre-Request Expiry: reclaims lease if it expires before request started', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      // Setup a row that was claimed but request never started
      db.rows.set('op-pre-req', {
        id: 'op-pre-req', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 0,
        lease_until: Math.floor(Date.now() / 1000) - 1, lease_token: 'v2:stale-token', last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      // It should successfully reclaim and then try to send
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', async (opId, lifecycle) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(200);
        return { providerMessageRef: 'ok' };
      }, 'op-pre-req')).resolves.toEqual({ status: 'SENT', providerMessageRef: 'ok' });
      
      const row = db.rows.get('op-pre-req')!;
      expect(row.status).toBe('SENT');
      expect(row.attempt_count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Started Lease Expiry: marks as AMBIGUOUS if lease expires after request started', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      // Setup a row that started request but then lease expired (crash during network I/O)
      db.rows.set('op-started-exp', {
        id: 'op-started-exp', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 1,
        lease_until: Math.floor(Date.now() / 1000) - 1, lease_token: 'v2:stale-token', last_error: null, created_at: 0, updated_at: 0,
        request_started_at: Math.floor(Date.now() / 1000) - 10, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', vi.fn(), 'op-started-exp'))
        .resolves.toEqual({ status: 'AMBIGUOUS' });
      
      const row = db.rows.get('op-started-exp')!;
      expect(row.status).toBe('AMBIGUOUS');
      expect(row.reconciliation_status).toBe('PENDING');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Legacy Lease Compatibility: marks as AMBIGUOUS if legacy v1 lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      // Legacy lease does not start with v2:
      db.rows.set('op-legacy', {
        id: 'op-legacy', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 1,
        lease_until: Math.floor(Date.now() / 1000) - 1, lease_token: 'stale-token-no-v2', last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', vi.fn(), 'op-legacy'))
        .resolves.toEqual({ status: 'AMBIGUOUS' });
      
      const row = db.rows.get('op-legacy')!;
      expect(row.status).toBe('AMBIGUOUS');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Stale Owner Race: rejects executeOutboundOperation if lease is held by someone else and active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.rows.set('op-race', {
        id: 'op-race', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 0,
        lease_until: Math.floor(Date.now() / 1000) + 30, lease_token: 'v2:active-token', last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', vi.fn(), 'op-race'))
        .rejects.toThrow(RetryableProcessingError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestStarted Idempotency/CAS: does not increment attempt count if requestStarted is called twice on same attempt', async () => {
    const db = new OperationDb();
    const action = vi.fn(async (opId, lifecycle) => {
      await lifecycle.requestStarted();
      await lifecycle.requestStarted(); 
      return { providerMessageRef: 'ok' };
    });

    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-cas')).rejects.toThrow(/CONCURRENCY_CAS_CONFLICT/);
    const row = db.rows.get('op-cas')!;
    expect(row.attempt_count).toBe(1); // attempt_count should be 1 from the first successful call
    expect(row.status).toBe('SENDING'); // Status remains SENDING because outer failure is skipped
  });

  it('Response Evidence Tests: 2xx success', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(200);
      return { providerMessageRef: 'msg-id' };
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-2xx');
    expect(res).toEqual({ status: 'SENT', providerMessageRef: 'msg-id' });

    const row = db.rows.get('op-2xx')!;
    expect(row.status).toBe('SENT');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.response_observed_at).toBeGreaterThan(0);
    expect(row.response_http_status).toBe(200);
    expect(row.last_error).toBeNull();
    expect(row.retry_after_seconds).toBeNull();
    expect(row.next_retry_at).toBeNull();
    expect(row.reconciliation_status).toBe('NOT_REQUIRED');
  });
  it('Response Evidence Tests: 429 retryable', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(429);
      throw new ProviderDeliveryError('RETRYABLE', 'OUTBOUND_RATE_LIMITED', { provider: 'TELEGRAM', retryAfterSeconds: 30, httpStatus: 429 });
    };

    const promise = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-429');
    await expect(promise).rejects.toThrow(RetryableProcessingError);
    
    const row = db.rows.get('op-429')!;
    expect(row.status).toBe('FAILED_RETRYABLE');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.response_observed_at).toBeGreaterThan(0);
    expect(row.response_http_status).toBe(429);
    expect(row.last_error).toBe('OUTBOUND_RATE_LIMITED');
    expect(row.retry_after_seconds).toBeGreaterThanOrEqual(30);
    expect(row.next_retry_at).toBeGreaterThan(0);
    expect(row.reconciliation_status).toBe('NOT_REQUIRED');
  });
  it('requestStarted Clears Previous Error', async () => {
    const db = new OperationDb();
    db.rows.set('op-clear-err', {
      id: 'op-clear-err', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
      status: 'FAILED_RETRYABLE',
      provider_message_ref: null,
      attempt_count: 1,
      lease_until: null,
      lease_token: null,
      last_error: 'OUTBOUND_RATE_LIMITED',
      created_at: 1000,
      updated_at: 1000,
      retry_after_seconds: 30,
      next_retry_at: 999, // ready for retry
      reconciliation_status: 'NOT_REQUIRED'
    });

    let observedLastErrorBefore = undefined;
    let observedAttemptCountBefore = undefined;

    const action = async (opId: string, lifecycle: any) => {
      const rowBefore = db.rows.get('op-clear-err')!;
      observedLastErrorBefore = rowBefore.last_error;
      observedAttemptCountBefore = rowBefore.attempt_count;

      await lifecycle.requestStarted();
      
      const rowAfter = db.rows.get('op-clear-err')!;
      expect(rowAfter.last_error).toBeNull();
      expect(rowAfter.attempt_count).toBe(observedAttemptCountBefore + 1);

      return { providerMessageRef: 'ok' };
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-clear-err');
    expect(res.status).toBe('SENT');
    expect(observedLastErrorBefore).toBe('OUTBOUND_RATE_LIMITED');
  });

  it('Response Evidence Tests: Explicit 4xx final', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(400);
      throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PROVIDER_4XX_FINAL', { provider: 'TELEGRAM', httpStatus: 400 });
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-400');
    expect(res).toEqual({ status: 'FAILED_FINAL' });

    const row = db.rows.get('op-400')!;
    expect(row.status).toBe('FAILED_FINAL');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.response_observed_at).toBeGreaterThan(0);
    expect(row.response_http_status).toBe(400);
    expect(row.last_error).toBe('OUTBOUND_PROVIDER_4XX_FINAL');
    expect(row.reconciliation_status).toBe('NOT_REQUIRED');
  });

it('Response Evidence Tests: 408 timeout', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(408);
      throw new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_TIMEOUT_AMBIGUOUS', { provider: 'TELEGRAM', httpStatus: 408 });
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-408');
    expect(res).toEqual({ status: 'AMBIGUOUS' });

    const row = db.rows.get('op-408')!;
    expect(row.status).toBe('AMBIGUOUS');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.response_observed_at).toBeGreaterThan(0);
    expect(row.response_http_status).toBe(408);
    expect(row.last_error).toBe('OUTBOUND_TIMEOUT_AMBIGUOUS');
    expect(row.reconciliation_status).toBe('PENDING');
  });

it('Response Evidence Tests: 5xx ambiguous', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(503);
      throw new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_PROVIDER_5XX_AMBIGUOUS', { provider: 'TELEGRAM', httpStatus: 503 });
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-5xx');
    expect(res).toEqual({ status: 'AMBIGUOUS' });

    const row = db.rows.get('op-5xx')!;
    expect(row.status).toBe('AMBIGUOUS');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.response_observed_at).toBeGreaterThan(0);
    expect(row.response_http_status).toBe(503);
    expect(row.last_error).toBe('OUTBOUND_PROVIDER_5XX_AMBIGUOUS');
    expect(row.reconciliation_status).toBe('PENDING');
  });

it('Response Evidence Tests: transport exception', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      throw new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_TRANSPORT_AMBIGUOUS', { provider: 'TELEGRAM' });
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-transport');
    expect(res).toEqual({ status: 'AMBIGUOUS' });

    const row = db.rows.get('op-transport')!;
    expect(row.status).toBe('AMBIGUOUS');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.last_error).toBe('OUTBOUND_TRANSPORT_AMBIGUOUS');
    expect(row.reconciliation_status).toBe('PENDING');
  });

it('Response Evidence Tests: invalid 2xx', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(200);
      throw new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_INVALID_SUCCESS_AMBIGUOUS', { provider: 'TELEGRAM', httpStatus: 200 });
    };

    const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-inv2xx');
    expect(res).toEqual({ status: 'AMBIGUOUS' });

    const row = db.rows.get('op-inv2xx')!;
    expect(row.status).toBe('AMBIGUOUS');
    expect(row.attempt_count).toBe(1);
    expect(row.request_started_at).toBeGreaterThan(0);
    expect(row.response_observed_at).toBeGreaterThan(0);
    expect(row.response_http_status).toBe(200);
    expect(row.last_error).toBe('OUTBOUND_INVALID_SUCCESS_AMBIGUOUS');
    expect(row.reconciliation_status).toBe('PENDING');
  });

  it('Retry Timing: blocks early retry without provider action, allows after deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      const action1 = vi.fn(async (opId: string, lifecycle: any) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(429);
        throw new ProviderDeliveryError('RETRYABLE', 'OUTBOUND_RATE_LIMITED', { provider: 'TELEGRAM', retryAfterSeconds: 30, httpStatus: 429 });
      });

      // Attempt 1: 429 Retry-After 30
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action1, 'op-retry-timing')).rejects.toThrow();
      expect(action1).toHaveBeenCalledTimes(1);
      
      const row = db.rows.get('op-retry-timing')!;
      expect(row.status).toBe('FAILED_RETRYABLE');
      expect(row.retry_after_seconds).toBeGreaterThanOrEqual(30);

      // Attempt 2: Early retry blocked
      vi.advanceTimersByTime(10_000); // only 10s passed
      const action2 = vi.fn();
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action2, 'op-retry-timing')).rejects.toThrowError(/OUTBOUND_RATE_LIMITED/);
      expect(action2).not.toHaveBeenCalled();

      // Attempt 3: Retry after deadline allowed
      vi.advanceTimersByTime(30_000); // 40s total passed
      const action3 = vi.fn(async (opId: string, lifecycle: any) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(200);
        return { providerMessageRef: 'ok-3' };
      });
      const res3 = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action3, 'op-retry-timing');
      expect(res3).toEqual({ status: 'SENT', providerMessageRef: 'ok-3' });
      expect(action3).toHaveBeenCalledTimes(1);

      // Verify clean final evidence
      const finalRow = db.rows.get('op-retry-timing')!;
      expect(finalRow.status).toBe('SENT');
      expect(finalRow.last_error).toBeNull();
      expect(finalRow.retry_after_seconds).toBeNull();
      expect(finalRow.next_retry_at).toBeNull();
      expect(finalRow.reconciliation_status).toBe('NOT_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Attempt Exhaustion Test: fails permanently after 3 attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      const action = async (opId: string, lifecycle: any) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(429);
        throw new ProviderDeliveryError('RETRYABLE', 'OUTBOUND_RATE_LIMITED', { provider: 'TELEGRAM', retryAfterSeconds: 0, httpStatus: 429 });
      };

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-exhaust')).rejects.toThrow();
      expect(db.rows.get('op-exhaust')!.attempt_count).toBe(1);

      vi.advanceTimersByTime(10_000);
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-exhaust')).rejects.toThrow();
      expect(db.rows.get('op-exhaust')!.attempt_count).toBe(2);

      vi.advanceTimersByTime(10_000);
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-exhaust')).resolves.toEqual({ status: 'FAILED_FINAL' });
      expect(db.rows.get('op-exhaust')!.attempt_count).toBe(3);
      
      const row = db.rows.get('op-exhaust')!;
      expect(row.status).toBe('FAILED_FINAL');
      expect(row.last_error).toBe('OUTBOUND_RETRY_EXHAUSTED');

      // 4th invocation provider action NO
      const action4 = vi.fn(action);
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action4, 'op-exhaust')).resolves.toEqual({ status: 'FAILED_FINAL' });
      expect(action4).not.toHaveBeenCalled();
      expect(db.rows.get('op-exhaust')!.attempt_count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Persistence Failure: responseObserved persistence error after provider response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.failResponseObservedUpdates = true;

      const action = vi.fn(async (opId: string, lifecycle: any) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(200); // this will throw internally in our fake DB due to failResponseObservedUpdates
        return { providerMessageRef: 'ok' };
      });

      const promise = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-persist-obs-fail');
      await expect(promise).rejects.toThrowError(RetryableProcessingError);
      
      try {
        await promise;
      } catch (e: any) {
        expect(e.code).toBe('CONCURRENCY_CAS_CONFLICT'); // Since changes=0 in the mock
      }

      const row = db.rows.get('op-persist-obs-fail')!;
      expect(row.status).toBe('SENDING'); // Still SENDING
      
      // Advance timers to let lease expire
      vi.advanceTimersByTime(35_000);
      
      const action2 = vi.fn();
      const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action2, 'op-persist-obs-fail');
      
      expect(res.status).toBe('AMBIGUOUS');
      expect(action).toHaveBeenCalledTimes(1);
      expect(action2).not.toHaveBeenCalled(); // Automatic resend MUST NOT HAPPEN
      
      const finalRow = db.rows.get('op-persist-obs-fail')!;
      expect(finalRow.status).toBe('AMBIGUOUS');
      expect(finalRow.reconciliation_status).toBe('PENDING');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Persistence Failure: SENT persistence failure does not resend, eventual status is AMBIGUOUS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.failSentUpdates = true;

      const action = vi.fn(async (opId: string, lifecycle: any) => {
        await lifecycle.requestStarted();
        await lifecycle.responseObserved(200);
        return { providerMessageRef: 'ok' };
      });

      const promise = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-persist-fail');
      await expect(promise).rejects.toThrowError(RetryableProcessingError);
      
      const row = db.rows.get('op-persist-fail')!;
      expect(row.status).toBe('SENDING'); // Still SENDING for now
      
      vi.advanceTimersByTime(35_000); // Wait for lease to expire
      
      const action2 = vi.fn();
      const res = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action2, 'op-persist-fail');
      expect(res.status).toBe('AMBIGUOUS');
      
      const finalRow = db.rows.get('op-persist-fail')!;
      expect(finalRow.status).toBe('AMBIGUOUS');
      expect(action).toHaveBeenCalledTimes(1);
      expect(action2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Pre-Request Failures: errors before requestStarted are final or retryable without using attempt_count', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM' });
    };

    const result = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-pre-fail');
    expect(result).toEqual({ status: 'FAILED_FINAL' });
    const row = db.rows.get('op-pre-fail')!;
    expect(row.status).toBe('FAILED_FINAL');
    expect(row.attempt_count).toBe(0); // Attempt count was not incremented
  });
});
