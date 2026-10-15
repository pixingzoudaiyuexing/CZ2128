export interface Sha256Checkpoint {
  readonly h: readonly number[];
  readonly buffer: readonly number[];
  readonly bytesTotal: number;
}

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

function validNumbers(value: unknown, length: number, maximum: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > maximum) return false;
  }
  return true;
}

function validateCheckpoint(value: unknown): Sha256Checkpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SHA256_CHECKPOINT_INVALID');
  const state = value as Record<string, unknown>;
  if (Object.keys(state).length !== 3 || !Object.hasOwn(state, 'h') || !Object.hasOwn(state, 'buffer') ||
      !Object.hasOwn(state, 'bytesTotal') || !validNumbers(state.h, 8, 0xffffffff) ||
      !Array.isArray(state.buffer) || state.buffer.length > 63 || !validNumbers(state.buffer, state.buffer.length, 255) ||
      typeof state.bytesTotal !== 'number' || !Number.isSafeInteger(state.bytesTotal) || state.bytesTotal < 0 ||
      state.bytesTotal % 64 !== state.buffer.length) throw new Error('SHA256_CHECKPOINT_INVALID');
  return { h: state.h, buffer: state.buffer, bytesTotal: state.bytesTotal };
}

/** File integrity only. Checkpoints are trusted server state, not authentication proofs. */
export class CheckpointSha256 {
  private readonly h = new Uint32Array(INITIAL);
  private readonly buffer = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private used = 0;
  private bytesTotal = 0;

  constructor(checkpoint?: unknown) {
    if (checkpoint === undefined) return;
    const state = validateCheckpoint(checkpoint);
    this.h.set(state.h);
    this.buffer.set(state.buffer);
    this.used = state.buffer.length;
    this.bytesTotal = state.bytesTotal;
  }

  private block(data: Uint8Array, offset: number): void {
    const w = this.words;
    for (let index = 0; index < 16; index += 1) {
      const p = offset + index * 4;
      w[index] = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15], y = w[index - 2];
      w[index] = (w[index - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        w[index - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
    let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
    for (let index = 0; index < 64; index += 1) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) + ROUND[index] + w[index]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0; this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0; this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0; this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0; this.h[7] = (this.h[7] + h) >>> 0;
  }

  update(data: Uint8Array): this {
    if (!(data instanceof Uint8Array)) throw new Error('SHA256_INPUT_INVALID');
    const next = this.bytesTotal + data.byteLength;
    if (!Number.isSafeInteger(next)) throw new Error('SHA256_LENGTH_INVALID');
    this.bytesTotal = next;
    let offset = 0;
    if (this.used > 0) {
      const length = Math.min(64 - this.used, data.byteLength);
      this.buffer.set(data.subarray(0, length), this.used);
      this.used += length; offset = length;
      if (this.used === 64) { this.block(this.buffer, 0); this.used = 0; }
    }
    while (offset + 64 <= data.byteLength) { this.block(data, offset); offset += 64; }
    if (offset < data.byteLength) {
      this.buffer.set(data.subarray(offset), this.used);
      this.used += data.byteLength - offset;
    }
    return this;
  }

  snapshot(): Sha256Checkpoint {
    return Object.freeze({ h: Object.freeze(Array.from(this.h)),
      buffer: Object.freeze(Array.from(this.buffer.subarray(0, this.used))), bytesTotal: this.bytesTotal });
  }

  /** Non-mutating: callers can inspect a digest and still continue or restore this stream. */
  digest(): string {
    const copy = new CheckpointSha256(this.snapshot());
    copy.buffer[copy.used++] = 0x80;
    if (copy.used > 56) { copy.buffer.fill(0, copy.used); copy.block(copy.buffer, 0); copy.used = 0; }
    copy.buffer.fill(0, copy.used, 56);
    const view = new DataView(copy.buffer.buffer);
    view.setUint32(56, Math.floor(copy.bytesTotal / 0x20000000));
    // Compute the low word before multiplying to preserve exact bits near MAX_SAFE_INTEGER.
    view.setUint32(60, (copy.bytesTotal % 0x20000000) * 8);
    copy.block(copy.buffer, 0);
    return Array.from(copy.h, value => value.toString(16).padStart(8, '0')).join('');
  }
}
