/** Explicit Node test double; deployed code always uses the real Worker class. */
export class TestFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor(expected: number) {
    let total = 0;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.length;
        if (total > expected) throw new Error('FIXED_LENGTH_EXCEEDED');
        controller.enqueue(chunk);
      },
      flush() { if (total !== expected) throw new Error('FIXED_LENGTH_INCOMPLETE'); }
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
}
