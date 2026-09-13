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
          updated_at: Number(updatedAt)
        });
        changes = 1;
      }
    } else if (query.includes("attempt_count = attempt_count + 1")) {
      const [leaseUntil, leaseToken, updatedAt, id] = params;
      const row = this.rows.get(String(id));
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'SENDING';
        row.lease_until = Number(leaseUntil);
        row.lease_token = String(leaseToken);
        row.updated_at = Number(updatedAt);
        row.attempt_count += 1;
        changes = 1;
      }
    } else if (query.includes("SET status = 'SENT'")) {
      const [providerRef, updatedAt, id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (!this.failSentUpdates && row?.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = 'SENT';
        row.provider_message_ref = providerRef === null ? null : String(providerRef);
        row.lease_until = null;
        row.lease_token = null;
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes('SET status = ?, last_error = ?')) {
      const [status, lastError, updatedAt, id, leaseToken] = params;
      const row = this.rows.get(String(id));
      if (row?.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = String(status);
        row.last_error = String(lastError);
        row.lease_until = null;
        row.lease_token = null;
        row.updated_at = Number(updatedAt);
        changes = 1;
      }
    } else if (query.includes("SET status = 'FAILED_FINAL'")) {
      const row = this.rows.get(String(params[1]));
      if (row) {
        row.status = 'FAILED_FINAL';
        changes = 1;
      }
    } else if (query.includes("SET status = 'AMBIGUOUS'")) {
      const row = this.rows.get(String(params[1]));
      if (row?.status === 'SENDING') {
        row.status = 'AMBIGUOUS';
        changes = 1;
      }
    }
    return { meta: { changes } };
  }
}

function makeEnv(db: OperationDb) {
  return { DB: db } as any;
}

describe('outbound operation safety', () => {
  it('marks an unknown post-claim failure AMBIGUOUS instead of retryable', async () => {
    const db = new OperationDb();
    const action = vi.fn(async () => {
      throw new Error('connection reset after request started');
    });

    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-1')).resolves.toEqual({ status: 'AMBIGUOUS' });
    expect(db.rows.get('op-1')?.status).toBe('AMBIGUOUS');

    await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-1');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not report success while another worker owns an active lease', async () => {
    const db = new OperationDb();
    db.rows.set('op-2', {
      id: 'op-2', conversation_id: 'conv-1', destination_provider: 'telegram', operation_type: 'SEND_MESSAGE',
      status: 'SENDING', provider_message_ref: null, attempt_count: 1,
      lease_until: Math.floor(Date.now() / 1000) + 30, lease_token: 'other-owner', last_error: null, created_at: 0, updated_at: 0
    });

    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', vi.fn(), 'op-2')).rejects.toThrow(/lease/i);
  });

  it('allows only one action to cross the atomic claim', async () => {
    const db = new OperationDb();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const action = vi.fn(async () => {
      await held;
      return { providerMessageRef: 'provider-1' };
    });

    const first = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-3');
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const second = executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-3');
    await expect(second).rejects.toThrow(/lease|worker/i);
    release();
    await expect(first).resolves.toEqual({ status: 'SENT', providerMessageRef: 'provider-1' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('bounds retryable provider failures and then marks them final', async () => {
    const db = new OperationDb();
    const action = vi.fn(async () => {
      throw new ProviderDeliveryError('RETRYABLE', 'TELEGRAM_HTTP_503');
    });

    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-4')).rejects.toBeInstanceOf(RetryableProcessingError);
    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-4')).rejects.toBeInstanceOf(RetryableProcessingError);
    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-4')).resolves.toEqual({ status: 'FAILED_FINAL' });
    expect(db.rows.get('op-4')?.attempt_count).toBe(3);
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('does not resend after provider success could not be persisted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    try {
      const db = new OperationDb();
      db.failSentUpdates = true;
      const action = vi.fn(async () => ({ providerMessageRef: 'provider-2' }));

      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-5')).rejects.toBeInstanceOf(RetryableProcessingError);
      expect(db.rows.get('op-5')?.status).toBe('SENDING');

      vi.advanceTimersByTime(31_000);
      await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', action, 'op-5')).resolves.toEqual({ status: 'AMBIGUOUS' });
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a deterministic operation id collision across destinations', async () => {
    const db = new OperationDb();
    await executeOutboundOperation(makeEnv(db), 'conv-1', 'telegram', 'SEND_MESSAGE', async () => ({ providerMessageRef: '1' }), 'shared-id');

    await expect(executeOutboundOperation(makeEnv(db), 'conv-1', 'chatwoot', 'SEND_MESSAGE', vi.fn(), 'shared-id')).rejects.toThrow('identity collision');
  });
});
