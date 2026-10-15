import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CheckpointSha256 } from '../src/core/sha256-checkpoint';

const encode = (value: string) => new TextEncoder().encode(value);
const oracle = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function generator(seed: number) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
}

describe('checkpointed incremental SHA-256 file integrity', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1']
  ])('matches the published vector for %j', (text, expected) => {
    const hash = new CheckpointSha256().update(encode(text));
    expect(hash.digest()).toBe(expected);
    expect(hash.digest()).toBe(oracle(encode(text)));
  });

  it('matches Node across deterministic random chunk and padding boundaries', () => {
    const random = generator(0x2128);
    for (const length of [0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1023, 4097]) {
      const bytes = Uint8Array.from({ length }, () => random() & 255);
      let hash = new CheckpointSha256();
      for (let offset = 0; offset < bytes.length;) {
        const end = Math.min(bytes.length, offset + 1 + random() % 93);
        hash.update(bytes.subarray(offset, end));
        hash = new CheckpointSha256(JSON.parse(JSON.stringify(hash.snapshot())));
        offset = end;
      }
      expect(hash.digest(), `length ${length}`).toBe(oracle(bytes));
    }
  });

  it('restores at every odd prefix length, including all partial block positions', () => {
    const bytes = Uint8Array.from({ length: 513 }, (_, index) => index * 19 & 255);
    for (let split = 1; split < bytes.length; split += 2) {
      const checkpoint = new CheckpointSha256().update(bytes.subarray(0, split)).snapshot();
      expect(checkpoint.buffer.length).toBe(split % 64);
      const restored = new CheckpointSha256(JSON.parse(JSON.stringify(checkpoint)));
      expect(restored.update(bytes.subarray(split)).digest(), `split ${split}`).toBe(oracle(bytes));
    }
  });

  it('owns its input/state and returns immutable snapshots while digest remains non-mutating', () => {
    const input = encode('abc');
    const hash = new CheckpointSha256().update(input);
    input.fill(0);
    const snapshot = hash.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.h)).toBe(true);
    expect(Object.isFrozen(snapshot.buffer)).toBe(true);
    expect(hash.digest()).toBe(oracle(encode('abc')));
    expect(hash.snapshot()).toEqual(snapshot);
    const raw = JSON.parse(JSON.stringify(snapshot));
    const restored = new CheckpointSha256(raw);
    raw.h.fill(0); raw.buffer.fill(0);
    expect(restored.digest()).toBe(oracle(encode('abc')));
    expect(hash.update(encode('def')).digest()).toBe(oracle(encode('abcdef')));
  });

  it('hashes 32 MiB with one reusable small chunk and bounded checkpoints', () => {
    const chunk = Uint8Array.from({ length: 65537 }, (_, index) => index * 31 & 255);
    const expected = createHash('sha256');
    let hash = new CheckpointSha256();
    let remaining = 32 * 1024 * 1024;
    let chunks = 0;
    while (remaining > 0) {
      const bytes = chunk.subarray(0, Math.min(remaining, chunk.length));
      hash.update(bytes); expected.update(bytes); remaining -= bytes.length;
      const checkpoint = hash.snapshot();
      expect(checkpoint.buffer.length).toBeLessThanOrEqual(63);
      expect(JSON.stringify(checkpoint).length).toBeLessThan(512);
      if (++chunks % 17 === 0) hash = new CheckpointSha256(JSON.parse(JSON.stringify(checkpoint)));
    }
    expect(hash.snapshot().bytesTotal).toBe(33554432);
    expect(hash.digest()).toBe(expected.digest('hex'));
  });

  it('rejects malformed checkpoints, sparse arrays and mismatched byte counters', () => {
    const valid = new CheckpointSha256().snapshot();
    for (const state of [null, [], {}, { ...valid, h: [] }, { ...valid, h: Array(8) },
      { ...valid, h: [NaN, ...valid.h.slice(1)] }, { ...valid, h: [0x100000000, ...valid.h.slice(1)] },
      { ...valid, h: [-1, ...valid.h.slice(1)] }, { ...valid, buffer: Array(1), bytesTotal: 1 },
      { ...valid, buffer: [256], bytesTotal: 1 }, { ...valid, buffer: [-1], bytesTotal: 1 },
      { ...valid, buffer: [1.5], bytesTotal: 1 }, { ...valid, buffer: new Uint8Array(0) },
      { ...valid, buffer: Array(64).fill(0), bytesTotal: 64 }, { ...valid, bytesTotal: 1 },
      { ...valid, bytesTotal: -64 }, { ...valid, bytesTotal: 1.5 }, { ...valid, bytesTotal: Infinity },
      { ...valid, bytesTotal: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, extra: true }]) {
      expect(() => new CheckpointSha256(state)).toThrow('SHA256_CHECKPOINT_INVALID');
    }
  });

  it('rejects counter overflow without changing state and keeps 64-bit length arithmetic exact', () => {
    const empty = new CheckpointSha256().snapshot();
    const huge = { h: [...empty.h], buffer: Array(63).fill(0), bytesTotal: Number.MAX_SAFE_INTEGER };
    const hash = new CheckpointSha256(huge);
    expect(() => hash.update(new Uint8Array(1))).toThrow('SHA256_LENGTH_INVALID');
    expect(hash.snapshot()).toEqual(huge);
    expect(hash.digest()).toMatch(/^[a-f0-9]{64}$/);
    expect(hash.snapshot()).toEqual(huge);
    expect(() => hash.update([] as unknown as Uint8Array)).toThrow('SHA256_INPUT_INVALID');
  });
});
