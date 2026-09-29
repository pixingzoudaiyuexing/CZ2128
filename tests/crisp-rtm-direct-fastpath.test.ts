import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { insertReliabilityAuditOnce } from '../src/core/reliability-audit';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';

vi.mock('../src/queue/consumer', () => ({
  handleQueueEvent: vi.fn()
}));
vi.mock('../src/runtime-config/resolver', () => ({
  resolveEffectiveEnv: vi.fn()
}));
vi.mock('../src/core/reliability-audit', () => ({
  insertReliabilityAuditOnce: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('socket.io-client', () => ({
  io: vi.fn()
}));

import { CrispRtmBridge } from '../src/rtm/crisp-rtm';

function customerText() {
  return {
    website_id: 'website-1',
    session_id: 'session-1',
    type: 'text',
    content: 'Fast hello',
    fingerprint: 179070800000001,
    from: 'user',
    user: { nickname: 'Visitor', user_id: 'visitor-1' }
  };
}

describe('Crisp RTM direct fast processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(insertReliabilityAuditOnce).mockResolvedValue(undefined as any);
  });

  it('durably enqueues before attempting the shared event processor', async () => {
    const order: string[] = [];
    const queueSend = vi.fn(async () => { order.push('queue'); });
    vi.mocked(resolveEffectiveEnv).mockImplementation(async (env: any) => {
      order.push('resolve');
      return env;
    });
    vi.mocked(handleQueueEvent).mockImplementation(async () => {
      order.push('process');
    });
    const waitUntil = vi.fn();
    const env = {
      CRISP_WEBSITE_ID: 'website-1',
      QUEUE: { send: queueSend }
    } as any;
    const bridge = new CrispRtmBridge({
      waitUntil,
      storage: { setAlarm: vi.fn() }
    } as any, env);

    await (bridge as any).handleRtmCustomerMessage(customerText());
    await Promise.all(waitUntil.mock.calls.map(call => call[0]));

    expect(order).toEqual(['queue', 'resolve', 'process']);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(handleQueueEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertReliabilityAuditOnce).mock.calls.map(call => call[1]?.action))
      .toEqual(expect.arrayContaining(['RTM_EVENT_ENQUEUED', 'RTM_FAST_COMPLETED']));
  });

  it('leaves the durable Queue copy to recover when direct processing fails', async () => {
    const queueSend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(resolveEffectiveEnv).mockImplementation(async (env: any) => env);
    vi.mocked(handleQueueEvent).mockRejectedValue(new Error('direct processing failed'));
    const waitUntil = vi.fn();
    const env = {
      CRISP_WEBSITE_ID: 'website-1',
      QUEUE: { send: queueSend }
    } as any;
    const bridge = new CrispRtmBridge({
      waitUntil,
      storage: { setAlarm: vi.fn() }
    } as any, env);

    await expect((bridge as any).handleRtmCustomerMessage(customerText()))
      .resolves.toBeUndefined();
    await Promise.all(waitUntil.mock.calls.map(call => call[0]));

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(handleQueueEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertReliabilityAuditOnce).mock.calls.map(call => call[1]?.action))
      .toEqual(expect.arrayContaining(['RTM_EVENT_ENQUEUED', 'RTM_FAST_DEFERRED']));
  });

  it('does not direct-process when the durable Queue enqueue itself fails', async () => {
    const queueSend = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const env = {
      CRISP_WEBSITE_ID: 'website-1',
      QUEUE: { send: queueSend }
    } as any;
    const bridge = new CrispRtmBridge({
      waitUntil: vi.fn(),
      storage: { setAlarm: vi.fn() }
    } as any, env);

    await expect((bridge as any).handleRtmCustomerMessage(customerText()))
      .rejects.toThrow('queue unavailable');

    expect(resolveEffectiveEnv).not.toHaveBeenCalled();
    expect(handleQueueEvent).not.toHaveBeenCalled();
  });
});
