import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';
import * as consumer from '../src/queue/consumer';
import { RetryLaterError } from '../src/core/events';

describe('Worker Queue Consumer Runtime', () => {
  it('translates RetryLaterError to message.retry with delay', async () => {
    vi.spyOn(consumer, 'handleQueueEvent').mockRejectedValue(new RetryLaterError('Locked', 37));
    
    const message = {
      body: { source: 'internal', type: 'ai_trigger', eventId: '1', payload: {} },
      ack: vi.fn(),
      retry: vi.fn()
    };
    
    const batch = {
      messages: [message],
      queue: 'test-queue',
      retryAll: vi.fn(),
      ackAll: vi.fn()
    };
    
    const env = {};
    const ctx = { waitUntil: vi.fn() };
    
    if (worker.queue) {
      await worker.queue(batch as any, env as any, ctx as any);
    }
    
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 37 });
    expect(message.ack).toHaveBeenCalledTimes(0);
  });
});
