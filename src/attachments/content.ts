import { createHash } from 'node:crypto';
import { SafeError } from '../core/errors';

export interface StoredAttachmentInspection {
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  retentionClass: 'IMAGE' | 'FILE';
}

export function verifiedPartStream(
  body: ReadableStream<Uint8Array>, expectedLength: number, expectedSha256: string
): { readable: ReadableStream<Uint8Array>; done: Promise<void>; abort(reason?: unknown): Promise<void> } {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new SafeError('ATTACHMENT_SOURCE_INVALID');
  }
  const fixed = new FixedLengthStream(expectedLength);
  const writer = fixed.writable.getWriter();
  const reader = body.getReader();
  const hash = createHash('sha256');
  let total = 0;
  let finished = false;
  const abort = async (reason: unknown = new Error('ATTACHMENT_PART_ABORTED')): Promise<void> => {
    if (finished) return;
    finished = true;
    await Promise.allSettled([reader.cancel(reason), writer.abort(reason)]);
  };
  const done = (async () => {
    try {
      while (true) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        total += value.byteLength;
        if (!Number.isSafeInteger(total) || total > expectedLength) throw new SafeError('ATTACHMENT_SOURCE_INVALID');
        hash.update(value);
        await writer.write(value);
      }
      if (total !== expectedLength || hash.digest('hex') !== expectedSha256) throw new SafeError('ATTACHMENT_SOURCE_INVALID');
      await writer.close();
      finished = true;
    } catch (error) {
      await abort(error);
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* abort may already release the source */ }
      try { writer.releaseLock(); } catch { /* destination may still be failing */ }
    }
  })();
  // Consumers start the R2 read immediately, then await both promises. Attach a
  // rejection handler now so an early bad source cannot become unhandled.
  void done.catch(() => undefined);
  return { readable: fixed.readable as ReadableStream<Uint8Array>, done, abort };
}

const HEADER_BYTES = 64 * 1024;
const TAIL_BYTES = 32;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

/** Validate PNG framing and every chunk CRC while retaining at most its small header. */
class PngStructure {
  private offset = 0;
  private state: 'signature' | 'length' | 'type' | 'data' | 'crc' | 'done' = 'signature';
  private value = 0;
  private fieldBytes = 0;
  private remaining = 0;
  private chunkType = '';
  private crc = 0xffffffff;
  private chunkCrc = 0;
  private chunkCount = 0;
  private seenData = false;
  valid = true;

  update(bytes: Uint8Array): void {
    if (!this.valid) return;
    for (const byte of bytes) {
      if (this.state === 'signature') {
        if (byte !== [137, 80, 78, 71, 13, 10, 26, 10][this.offset++]) { this.valid = false; return; }
        if (this.offset === 8) this.state = 'length';
      } else if (this.state === 'done') { this.valid = false; return; }
      else if (this.state === 'length') {
        this.value = this.value * 256 + byte;
        if (++this.fieldBytes === 4) {
          this.remaining = this.value; this.value = 0; this.fieldBytes = 0;
          this.chunkType = ''; this.crc = 0xffffffff; this.state = 'type';
        }
      } else if (this.state === 'type') {
        if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) { this.valid = false; return; }
        this.chunkType += String.fromCharCode(byte);
        this.crc = CRC_TABLE[(this.crc ^ byte) & 255] ^ (this.crc >>> 8);
        if (++this.fieldBytes === 4) {
          if ((this.chunkCount === 0 && (this.chunkType !== 'IHDR' || this.remaining !== 13)) ||
              (this.chunkType === 'IHDR' && this.chunkCount !== 0) ||
              (this.chunkType === 'IEND' && (this.remaining !== 0 || !this.seenData))) { this.valid = false; return; }
          if (this.chunkType === 'IDAT') this.seenData = true;
          this.fieldBytes = 0; this.state = this.remaining ? 'data' : 'crc';
        }
      } else if (this.state === 'data') {
        this.crc = CRC_TABLE[(this.crc ^ byte) & 255] ^ (this.crc >>> 8);
        if (--this.remaining === 0) this.state = 'crc';
      } else {
        this.chunkCrc = this.chunkCrc * 256 + byte;
        if (++this.fieldBytes === 4) {
          if ((this.crc ^ 0xffffffff) >>> 0 !== this.chunkCrc) { this.valid = false; return; }
          this.chunkCrc = 0; this.fieldBytes = 0; this.chunkCount++;
          this.state = this.chunkType === 'IEND' ? 'done' : 'length';
        }
      }
    }
  }

  complete(): boolean { return this.valid && this.state === 'done'; }
}

class JpegStructure {
  private state: 'signature' | 'prefix' | 'marker' | 'length' | 'segment' | 'entropy' | 'entropy-marker' | 'done' = 'signature';
  private signatureBytes = 0;
  private marker = 0;
  private length = 0;
  private lengthBytes = 0;
  private remaining = 0;
  private segmentStart: number[] = [];
  private seenFrame = false;
  private seenScan = false;
  private entropyBytes = 0;
  valid = true;

  update(bytes: Uint8Array): void {
    if (!this.valid) return;
    for (const byte of bytes) {
      if (this.state === 'signature') {
        if (byte !== [0xff, 0xd8][this.signatureBytes++]) { this.valid = false; return; }
        if (this.signatureBytes === 2) this.state = 'prefix';
      } else if (this.state === 'prefix') {
        if (byte !== 0xff) { this.valid = false; return; } this.state = 'marker';
      } else if (this.state === 'marker' || this.state === 'entropy-marker') {
        const inScan = this.state === 'entropy-marker';
        if (byte === 0xff) continue;
        if (inScan && (byte === 0 || (byte >= 0xd0 && byte <= 0xd7))) { this.entropyBytes++; this.state = 'entropy'; continue; }
        if (byte === 0xd9 && this.seenScan && this.entropyBytes > 0) { this.state = 'done'; continue; }
        if (byte === 0 || byte === 0xd8 || byte === 0xd9) { this.valid = false; return; }
        if (byte === 1) { this.state = inScan ? 'entropy' : 'prefix'; continue; }
        this.marker = byte; this.length = 0; this.lengthBytes = 0; this.segmentStart = []; this.state = 'length';
      } else if (this.state === 'length') {
        this.length = this.length * 256 + byte;
        if (++this.lengthBytes === 2) {
          if (this.length < 2) { this.valid = false; return; }
          this.remaining = this.length - 2; this.state = this.remaining ? 'segment' : 'prefix';
        }
      } else if (this.state === 'segment') {
        if (this.segmentStart.length < 7) this.segmentStart.push(byte);
        if (--this.remaining === 0) {
          if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(this.marker)) {
            const s = this.segmentStart;
            if (this.length < 8 || !s[0] || !(s[1] || s[2]) || !(s[3] || s[4]) || !s[5]) { this.valid = false; return; }
            this.seenFrame = true;
          }
          if (this.marker === 0xda) {
            if (!this.seenFrame || this.length < 6) { this.valid = false; return; }
            this.seenScan = true; this.state = 'entropy';
          } else this.state = 'prefix';
        }
      } else if (this.state === 'entropy') {
        if (byte === 0xff) this.state = 'entropy-marker'; else this.entropyBytes++;
      } else { this.valid = false; return; }
    }
  }
  complete(): boolean { return this.valid && this.state === 'done' && this.seenFrame && this.seenScan; }
}

function matches(bytes: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  if (offset + 4 > bytes.length) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function jpegHasFrameAndScan(header: Uint8Array): boolean {
  let offset = 2;
  let frame = false;
  while (offset + 4 <= header.length) {
    if (header[offset++] !== 0xff) return false;
    while (header[offset] === 0xff) offset++;
    const marker = header[offset++];
    if (marker === 0xda) return frame;
    if (marker === 0xd9 || marker === 0 || marker === 0xd8) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = header[offset] * 256 + header[offset + 1];
    if (length < 2 || offset + length > header.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !header[offset + 2] || !(header[offset + 3] || header[offset + 4]) ||
          !(header[offset + 5] || header[offset + 6])) return false;
      frame = true;
    }
    offset += length;
  }
  return false;
}

/** Only bounded container bytes, never client MIME/name, select image retention/inline MIME. */
export function classifyAttachmentContent(header: Uint8Array, tail: Uint8Array, size: number): Pick<StoredAttachmentInspection, 'mimeType' | 'retentionClass'> {
  let mimeType: string | undefined;
  if (size >= 45 && matches(header, [137, 80, 78, 71, 13, 10, 26, 10]) &&
      u32(header, 8) === 13 && ascii(header, 12, 4) === 'IHDR' &&
      u32(header, 16) > 0 && u32(header, 20) > 0 &&
      matches(tail, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], tail.length - 12)) mimeType = 'image/png';
  else if (size >= 12 && matches(header, [255, 216, 255]) &&
           jpegHasFrameAndScan(header) && matches(tail, [255, 217], tail.length - 2)) mimeType = 'image/jpeg';
  else if (size >= 35 && ['GIF87a', 'GIF89a'].includes(ascii(header, 0, 6)) &&
           (header[6] || header[7]) && (header[8] || header[9]) && tail[tail.length - 1] === 0x3b &&
           header.indexOf(0x2c, 13 + ((header[10] & 128) ? 3 * 2 ** ((header[10] & 7) + 1) : 0)) >= 0) mimeType = 'image/gif';
  else if (size >= 30 && ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'WEBP' &&
           u32(header, 4, true) + 8 === size && u32(header, 16, true) <= size - 20) {
    const format = ascii(header, 12, 4);
    if ((format === 'VP8 ' && u32(header, 16, true) >= 10 && matches(header, [0x9d, 0x01, 0x2a], 23)) ||
        (format === 'VP8L' && u32(header, 16, true) >= 5 && header[20] === 0x2f) ||
        (format === 'VP8X' && u32(header, 16, true) === 10 && header[21] === 0 && header[22] === 0 && header[23] === 0 &&
         (ascii(header, 30, 4) === 'VP8 ' || ascii(header, 30, 4) === 'VP8L' || ascii(header, 30, 4) === 'ANIM' || ascii(header, 30, 4) === 'ICCP'))) mimeType = 'image/webp';
  }
  else if (size >= 54 && ascii(header, 0, 2) === 'BM' && u32(header, 2, true) === size &&
           u32(header, 14, true) >= 40 && u32(header, 18, true) > 0 && u32(header, 22, true) > 0 &&
           header[26] === 1 && header[27] === 0 && [1, 4, 8, 16, 24, 32].includes(header[28]) &&
           u32(header, 10, true) >= 54 && u32(header, 10, true) < size) mimeType = 'image/bmp';
  else if (size >= 48 && ascii(header, 4, 4) === 'ftyp' && u32(header, 0) >= 16 &&
           u32(header, 0) <= header.length && ['avif', 'avis'].includes(ascii(header, 8, 4))) {
    let offset = u32(header, 0); let meta = false; let data = false;
    while (offset + 8 <= header.length) {
      const length = u32(header, offset); const type = ascii(header, offset + 4, 4);
      if (length < 8 || offset + length > size) break;
      if (type === 'meta' && length >= 20) meta = true;
      if (type === 'mdat' && length > 8) data = true;
      offset += length;
    }
    if (meta && data) mimeType = 'image/avif';
  }
  if (mimeType) return { mimeType, retentionClass: 'IMAGE' };
  // Unsafe active content and malformed image containers are always downloads.
  if (ascii(header, 0, 5) === '%PDF-') mimeType = 'application/pdf';
  else if (matches(header, [0x50, 0x4b, 3, 4]) || matches(header, [0x50, 0x4b, 5, 6])) mimeType = 'application/zip';
  else mimeType = 'application/octet-stream';
  return { mimeType, retentionClass: 'FILE' };
}

export async function inspectStoredAttachment(bucket: R2Bucket, key: string): Promise<StoredAttachmentInspection> {
  let object: R2ObjectBody | null;
  try { object = await bucket.get(key); } catch { throw new SafeError('R2_READ_TRANSIENT'); }
  if (!object?.body) throw new SafeError('R2_OBJECT_MISSING');
  const hash = createHash('sha256');
  const pngStructure = new PngStructure();
  const jpegStructure = new JpegStructure();
  const header = new Uint8Array(HEADER_BYTES);
  let headerUsed = 0;
  let tail = new Uint8Array(0);
  let sizeBytes = 0;
  const reader = object.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!Number.isSafeInteger(sizeBytes + value.byteLength)) throw new SafeError('R2_OBJECT_TOO_LARGE');
      sizeBytes += value.byteLength;
      hash.update(value);
      pngStructure.update(value);
      jpegStructure.update(value);
      const copied = Math.min(HEADER_BYTES - headerUsed, value.byteLength);
      if (copied > 0) { header.set(value.subarray(0, copied), headerUsed); headerUsed += copied; }
      const combined = new Uint8Array(Math.min(TAIL_BYTES, tail.length + value.length));
      const fromChunk = Math.min(combined.length, value.length);
      const fromTail = combined.length - fromChunk;
      if (fromTail) combined.set(tail.subarray(tail.length - fromTail));
      combined.set(value.subarray(value.length - fromChunk), fromTail);
      tail = combined;
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('R2_READ_TRANSIENT');
  } finally { reader.releaseLock(); }
  if (sizeBytes === 0 || (Number.isSafeInteger(object.size) && object.size !== sizeBytes)) {
    throw new SafeError('ATTACHMENT_SOURCE_INVALID');
  }
  let classification = classifyAttachmentContent(header.subarray(0, headerUsed), tail, sizeBytes);
  if (classification.mimeType === 'image/png' && !pngStructure.complete()) {
    classification = { mimeType: 'application/octet-stream', retentionClass: 'FILE' };
  }
  if (matches(header, [255, 216, 255])) {
    classification = jpegStructure.complete()
      ? { mimeType: 'image/jpeg', retentionClass: 'IMAGE' }
      : { mimeType: 'application/octet-stream', retentionClass: 'FILE' };
  }
  return { sizeBytes, sha256: hash.digest('hex'), ...classification };
}

export interface AttachmentContentCheckpoint {
  version: 1;
  sizeBytes: number;
  header: string;
  tail: string;
  png: Record<string, unknown>;
  jpeg: Record<string, unknown>;
}
function encodeBytes(bytes:Uint8Array):string {
  let binary='';for(const value of bytes)binary+=String.fromCharCode(value);return btoa(binary);
}
function decodeBytes(value:unknown,maximum:number):Uint8Array {
  if(typeof value!=='string' || value.length>Math.ceil(maximum/3)*4)throw new Error('CONTENT_CHECKPOINT_INVALID');
  const binary=atob(value);if(binary.length>maximum)throw new Error('CONTENT_CHECKPOINT_INVALID');
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function restoreStructure<T extends object>(target:T,raw:Record<string,unknown>):T {
  const baseline=JSON.parse(JSON.stringify(target)) as Record<string,unknown>;
  if(!raw || Object.keys(raw).sort().join()!==Object.keys(baseline).sort().join())throw new Error('CONTENT_CHECKPOINT_INVALID');
  for(const key of Object.keys(baseline)) {
    const value=raw[key],original=baseline[key];
    if(typeof value!==typeof original || typeof value==='number' && (!Number.isSafeInteger(value) || Math.abs(value)>Number.MAX_SAFE_INTEGER) ||
      Array.isArray(original) && (!Array.isArray(value) || value.length>16 || value.some(v=>!Number.isInteger(v)||v<0||v>255)))throw new Error('CONTENT_CHECKPOINT_INVALID');
  }
  Object.assign(target,raw);return target;
}
/** Serializable server-only content parser state for bounded range verification. */
export class AttachmentContentInspector {
  private header=new Uint8Array(HEADER_BYTES);
  private used=0;
  private tail=new Uint8Array(0);
  private png=new PngStructure();
  private jpeg=new JpegStructure();
  private sizeBytes=0;
  constructor(snapshot?:AttachmentContentCheckpoint) {
    if(!snapshot)return;
    if(snapshot.version!==1 || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes<0)throw new Error('CONTENT_CHECKPOINT_INVALID');
    const header=decodeBytes(snapshot.header,HEADER_BYTES);this.header.set(header);this.used=header.length;
    this.tail=Uint8Array.from(decodeBytes(snapshot.tail,TAIL_BYTES));this.sizeBytes=snapshot.sizeBytes;
    if(this.used!==Math.min(this.sizeBytes,HEADER_BYTES)||this.tail.length!==Math.min(this.sizeBytes,TAIL_BYTES))throw new Error('CONTENT_CHECKPOINT_INVALID');
    this.png=restoreStructure(this.png,snapshot.png);this.jpeg=restoreStructure(this.jpeg,snapshot.jpeg);
  }
  update(bytes:Uint8Array):void {
    if(!Number.isSafeInteger(this.sizeBytes+bytes.length))throw new Error('CONTENT_SIZE_INVALID');this.sizeBytes+=bytes.length;
    this.png.update(bytes);this.jpeg.update(bytes);
    const copied=Math.min(HEADER_BYTES-this.used,bytes.length);if(copied){this.header.set(bytes.subarray(0,copied),this.used);this.used+=copied;}
    const tail=new Uint8Array(Math.min(TAIL_BYTES,this.tail.length+bytes.length));
    const fromChunk=Math.min(tail.length,bytes.length),fromOld=tail.length-fromChunk;
    if(fromOld)tail.set(this.tail.subarray(this.tail.length-fromOld));tail.set(bytes.subarray(bytes.length-fromChunk),fromOld);this.tail=tail;
  }
  snapshot():AttachmentContentCheckpoint {return {version:1,sizeBytes:this.sizeBytes,header:encodeBytes(this.header.subarray(0,this.used)),tail:encodeBytes(this.tail),
    png:JSON.parse(JSON.stringify(this.png)),jpeg:JSON.parse(JSON.stringify(this.jpeg))};}
  finish(sizeBytes:number):Pick<StoredAttachmentInspection,'mimeType'|'retentionClass'> {
    if(sizeBytes!==this.sizeBytes)throw new Error('CONTENT_SIZE_INVALID');
    let classification=classifyAttachmentContent(this.header.subarray(0,this.used),this.tail,sizeBytes);
    if(classification.mimeType==='image/png' && !this.png.complete())classification={mimeType:'application/octet-stream',retentionClass:'FILE'};
    if(classification.mimeType==='image/jpeg')classification=this.jpeg.complete()?classification:{mimeType:'application/octet-stream',retentionClass:'FILE'};
    return classification;
  }
}
