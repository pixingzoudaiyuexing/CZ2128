import { beforeEach, describe, expect, it, vi } from 'vitest';
import Worker from '../src/index';
import * as consumer from '../src/queue/consumer';
import { RuntimeDb } from './helpers/runtime-db';

vi.mock('../src/queue/consumer', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/queue/consumer')>();
  return { ...actual, handleQueueEvent: vi.fn() };
});

describe('runtime config Worker boundary', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads one coherent snapshot per Queue event and sees the next revision', async () => {
    const db = new RuntimeDb();
    db.runtime.push({
      key: 'AI_MODEL', value_kind: 'PLAIN', value_text: 'model-v1', ciphertext: null, nonce: null,
      version: 1, updated_by: '1', updated_at: 1
    });
    const env = { DB: db, AI_MODEL: 'env-model' } as any;
    const message = (id: string) => ({
      body: { version: 1, source: 'internal', type: 'ai_trigger', eventId: id, payload: { convId: 'c', messageId: id } },
      ack: vi.fn(), retry: vi.fn()
    });

    await Worker.queue!({ queue: 'cz2128-queue', messages: [message('1')] } as any, env, {} as any);
    expect(vi.mocked(consumer.handleQueueEvent).mock.calls[0][1]).toMatchObject({ AI_MODEL: 'model-v1' });
    expect(db.runtimeListReads).toBe(1);

    db.runtime[0].value_text = 'model-v2';
    db.runtime[0].version = 2;
    await Worker.queue!({ queue: 'cz2128-queue', messages: [message('2')] } as any, env, {} as any);
    expect(vi.mocked(consumer.handleQueueEvent).mock.calls[1][1]).toMatchObject({ AI_MODEL: 'model-v2' });
    expect(db.runtimeListReads).toBe(2);
  });
});
