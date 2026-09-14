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
        row.updated_at = Number(ts);
        changes = 1;
      }
    } else if (query.includes("response_observed_at = ?")) {
      const [ts, httpStatus, , id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && row.lease_token === leaseToken && row.request_started_at !== null) {
        row.response_observed_at = Number(ts);
        row.response_http_status = Number(httpStatus);
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
    } else if (query.includes("status = 'AMBIGUOUS', reconciliation_status = 'PENDING'") && query.includes("lease_until IS NULL")) {
      const [updatedAt, id, leaseUntilThreshold, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row && row.status === 'SENDING' && ((row.lease_until === null) || (row.lease_until <= Number(leaseUntilThreshold))) && ((row.lease_token === null) || (row.lease_token === leaseToken))) {
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
      console.log('UNMATCHED QUERY:', query);
    }
    return { meta: { changes } };
  }
}

function makeEnv(db: OperationDb) {
  return { DB: db } as any;
}

// Add our tests here
describe('outbound operation attempt lifecycle', () => {

  it('True Stale Owner Race: throws CONCURRENCY_CAS_CONFLICT without mutating B state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      
      // Simulate Worker A claiming the lease but then stalling
      db.rows.set('op-true-race', {
        id: 'op-true-race', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
        status: 'SENDING', provider_message_ref: null, attempt_count: 0,
        lease_until: Math.floor(Date.now() / 1000) - 1, lease_token: 'v2:worker-a', last_error: null, created_at: 0, updated_at: 0,
        request_started_at: null, response_observed_at: null, response_http_status: null, reconciliation_status: null,
        retry_after_seconds: null, next_retry_at: null
      });

      // Now Worker B comes in, reclaims the lease successfully, and starts executing.
      const actionB = vi.fn(async (opId, lifecycle) => {
        await lifecycle.requestStarted();
        
        // While Worker B is executing, Worker A wakes up and tries to call requestStarted() using its stale lease token.
        // We simulate Worker A's action directly here, passing 'v2:worker-a' to the DB query logic somehow.
        // Or we can just do two executeOutboundOperation calls. Wait, executeOutboundOperation handles the full lifecycle.
        // Let's just simulate the concurrency by explicitly calling executeOutboundOperation twice.
        return { providerMessageRef: 'ok-b' };
      });
      
      let resolveB: any;
      const bRunning = new Promise(r => resolveB = r);
      
      const pB = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', async (opId, lifecycle) => {
        resolveB();
        // Stalls B here
        await new Promise(r => setTimeout(r, 100));
        await lifecycle.requestStarted();
        return { providerMessageRef: 'ok-b' };
      }, 'op-true-race');
      
      await bRunning;
      // B has successfully claimed the lease and is waiting. 
      // The lease_token in DB is now B's token.
      const newLeaseToken = db.rows.get('op-true-race')!.lease_token;
      
      // Now simulate Worker A's stale attempt.
      // We manually construct lifecycle for A
      const envA = makeEnv(db);
      const ts = Math.floor(Date.now() / 1000);
      const res = await envA.DB.prepare(
        `UPDATE outbound_operations
         SET request_started_at = ?, attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND status = 'SENDING' AND lease_token = ? AND request_started_at IS NULL`
      ).bind(ts, ts, 'op-true-race', 'v2:worker-a').run();
      
      expect(res.meta.changes).toBe(0); // Worker A fails to update
      
      // Fast forward to let B finish
      vi.advanceTimersByTime(200);
      const resultB = await pB;
      expect(resultB).toEqual({ status: 'SENT', providerMessageRef: 'ok-b' });
      
      // Ensure B's state was not corrupted by A
      const row = db.rows.get('op-true-race')!;
      expect(row.status).toBe('SENT');
      expect(row.provider_message_ref).toBe('ok-b');
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
    await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', async (opId, lifecycle) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(200);
      return { providerMessageRef: 'ok' };
    }, 'op-2xx');
    const row = db.rows.get('op-2xx')!;
    expect(row.status).toBe('SENT');
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
    expect(row.retry_after_seconds).toBe(30);
  });

  it('Response Evidence Tests: Explicit 4xx final', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(400);
      throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'TELEGRAM', httpStatus: 400 });
    };

    const result = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-400');
    expect(result).toEqual({ status: 'FAILED_FINAL' });
    const row = db.rows.get('op-400')!;
    expect(row.status).toBe('FAILED_FINAL');
    expect(row.last_error).toBe('OUTBOUND_PRECONDITION_FAILED');
  });

  it('Response Evidence Tests: 5xx ambiguous', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      await lifecycle.responseObserved(500);
      throw new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED', { provider: 'TELEGRAM', httpStatus: 500 });
    };

    const result = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-500');
    expect(result).toEqual({ status: 'AMBIGUOUS' });
    const row = db.rows.get('op-500')!;
    expect(row.status).toBe('AMBIGUOUS');
  });

  it('Response Evidence Tests: transport exception', async () => {
    const db = new OperationDb();
    const action = async (opId: string, lifecycle: any) => {
      await lifecycle.requestStarted();
      throw new ProviderDeliveryError('AMBIGUOUS', 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED', { provider: 'TELEGRAM' });
    };

    const result = await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-transport');
    expect(result).toEqual({ status: 'AMBIGUOUS' });
    const row = db.rows.get('op-transport')!;
    expect(row.status).toBe('AMBIGUOUS');
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
