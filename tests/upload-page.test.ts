import { createHash, randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { UPLOAD_PAGE_CLIENT_SCRIPT, UPLOAD_SHA256_SCRIPT, uploadPage } from '../src/uploads/page';

const TOKEN = 'a'.repeat(43);
const INVITE = '/uploads/' + 'b'.repeat(43);
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

class Element {
  textContent = '';
  children: Element[] = [];
  hidden = false;
  disabled = false;
  value: any = '';
  max = 1;
  href = '';
  files: File[] = [];
  listeners = new Map<string, (...args: any[]) => unknown>();
  attributes = new Map<string, string>();
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(key: string, listener: (...args: any[]) => unknown) { this.listeners.set(key, listener); }
  click() { return this.listeners.get('click')?.(); }
}

class Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index]; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

interface HarnessOptions {
  path?: string;
  storage?: Storage;
  handler?: (url: string, method: string, body: any) => Response | Promise<Response>;
  putFailure?: number | Array<number | { status: number; code?: unknown }>;
  pauseFirstPut?: boolean;
  immediateTimers?: boolean;
  onTimer?: (milliseconds: number, client: any) => void;
}

function harness(options: HarnessOptions = {}) {
  const elements = new Map(['files', 'start', 'notice', 'uploads', 'stored-files', 'refresh-files'].map(id => [id, new Element()]));
  const doc = { getElementById: (id: string) => elements.get(id), createElement: () => new Element() };
  const storage = options.storage ?? new Storage();
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const puts: Array<{ url: string; bytes: Uint8Array; headers: Record<string, string> }> = [];
  const progressSnapshots: number[] = [];
  const timers: Array<() => unknown> = [];
  const timerDurations: number[] = [];
  let createdSize = 0;
  let expectedHash = '';
  const handler = options.handler ?? ((_url: string, _method: string, body: any) => {
    if (_method === 'DELETE') return Response.json({ state: 'ABORTED' });
    if (_url.endsWith('/files')) return Response.json({ files: [] });
    if (_url.endsWith('/sessions')) {
      createdSize = body.sizeBytes;
      return Response.json({ sessionId: 'session-1', token: TOKEN, partSize: 4, partCount: Math.ceil(createdSize / 4), state: 'UPLOADING' });
    }
    if (_url.endsWith('/complete')) {
      expectedHash = body.sha256;
      return Response.json({ state: 'QUEUED', sha256: expectedHash, expiresAt: 1900000000, url: 'https://upload.example/attachments/synthetic/download' });
    }
    return Response.json({ sessionId: 'session-1', sizeBytes: createdSize, partSize: 4, partCount: Math.ceil(createdSize / 4), state: 'UPLOADING', parts: [] });
  });
  class Xhr {
    status = 0;
    responseText = '';
    timeout = 0;
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    onabort?: () => void;
    url = '';
    headers: Record<string, string> = {};
    progress?: (event: any) => void;
    upload = { addEventListener: (_event: string, fn: (event: any) => void) => { this.progress = fn; } };
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    async send(body: Blob) {
      // Network serialization does not call the page's hashing reader.
      puts.push({ url: this.url, bytes: new Uint8Array(await Blob.prototype.arrayBuffer.call(body)), headers: this.headers });
      this.progress?.({ loaded: Math.ceil(body.size / 2), lengthComputable: true });
      progressSnapshots.push(client.jobs.find((job: any) => job.xhr === this)?.progress.value ?? -1);
      if (options.pauseFirstPut && puts.length === 1) return;
      const result = Array.isArray(options.putFailure)
        ? options.putFailure[puts.length - 1] ?? 200
        : options.putFailure ?? 200;
      this.status = typeof result === 'number' ? result : result.status;
      this.responseText = typeof result === 'number' ? '' : JSON.stringify({ code: result.code });
      this.onload?.();
    }
    abort() { this.onabort?.(); }
  }
  const context = createContext({
    document: doc, localStorage: storage, location: { pathname: options.path ?? INVITE, origin: 'https://upload.example' },
    crypto: { randomUUID }, XMLHttpRequest: Xhr, Uint8Array, Uint32Array, DataView, TextEncoder, URL,
    fetch: async (url: string, init: any = {}) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ url, method: init.method ?? 'GET', body });
      return handler(url, init.method ?? 'GET', body);
    },
    setTimeout: (fn: () => unknown, ms: number) => {
      timerDurations.push(ms);
      options.onTimer?.(ms, client);
      if (ms === 2000 && !options.immediateTimers) timers.push(fn);
      else queueMicrotask(fn);
    }
  });
  runInContext(UPLOAD_SHA256_SCRIPT + '\n' + UPLOAD_PAGE_CLIENT_SCRIPT, context);
  const client = runInContext('createUploadClient(document)', context);
  return { client, elements, storage, calls, puts, context, timers, progressSnapshots, timerDurations };
}

describe('bounded incremental browser SHA-256', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 4097, 1048583])('matches independent Node SHA-256 for %i bytes across split blocks', length => {
    const h = harness();
    const value = Uint8Array.from({ length }, (_, i) => (i * 31 + 17) & 255);
    h.context.input = value;
    const actual = runInContext('const hash=new UploadSha256(); for(let p=0;p<input.length;p+=37)hash.update(input.subarray(p,p+37));hash.digest()', h.context);
    expect(actual).toBe(digest(value));
  });

  it('matches published empty, abc and million-a vectors without retaining the input', () => {
    const h = harness();
    expect(runInContext('new UploadSha256().digest()', h.context)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(runInContext('new UploadSha256().update(new TextEncoder().encode("abc")).digest()', h.context)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(runInContext('const h=new UploadSha256();const chunk=new Uint8Array(1000).fill(97);for(let i=0;i<1000;i++)h.update(chunk);h.digest()', h.context)).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    expect(runInContext('h.buffer.byteLength+h.words.byteLength+h.h.byteLength', h.context)).toBe(352);
  });
});

describe('customer multipart upload page', () => {
  it('serves a private accessible page with per-response script/style nonce and no third-party connection', async () => {
    const response = uploadPage();
    const html = await response.text();
    const nonce = /<script nonce="([^"]+)"/.exec(html)![1];
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(response.headers.get('Content-Security-Policy')).toContain(`style-src 'nonce-${nonce}'`);
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(html).toContain('type="file" multiple');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('72 小时');
    expect(html).toContain('7 天');
    expect(html).not.toContain('客服已收到通知');
    expect(html).not.toContain('最多上传');
    expect(html).not.toContain('20 MiB');
    expect(/<script nonce="([^"]+)"/.exec(await uploadPage().text())![1]).not.toBe(nonce);
  });

  it('uploads multiple files sequentially with real part hashes and complete-file SHA, showing queued rather than delivered', async () => {
    const h = harness();
    await h.client.initialize();
    const a = new File(['hello-world'], '<private>.txt', { lastModified: 100 });
    const b = new File(['second'], 'photo.png', { lastModified: 101 });
    h.client.addFiles([a, b]);
    await h.client.begin();
    expect(h.puts).toHaveLength(5);
    expect(h.progressSnapshots.slice(0, 3)).toEqual([2, 6, 10]);
    for (const part of h.puts) expect(part.headers['X-Part-SHA256']).toBe(digest(part.bytes));
    expect(h.calls.filter(call => call.url.endsWith('/complete')).map(call => call.body.sha256)).toEqual([digest('hello-world'), digest('second')]);
    expect(h.client.jobs.map((job: any) => job.status.textContent)).toEqual(['已排队，等待送达', '已排队，等待送达']);
    expect(h.client.jobs[0].progress.value).toBe(a.size);
    expect(h.client.jobs[0].refresh.hidden).toBe(false);
    expect(h.client.jobs[0].pause.hidden).toBe(true);
    expect(h.elements.get('uploads')!.children[0].children[0].children[0].textContent).toBe('<private>.txt');
    expect([...h.storage.values.keys()].every(key => !key.includes(TOKEN) && !key.includes('b'.repeat(43)))).toBe(true);
    expect([...h.storage.values.values()].some(value => value.includes('hello-world'))).toBe(false);
  });

  it('hashes a file larger than one read chunk without requesting the whole file buffer', async () => {
    const data = new Uint8Array(2 * 1024 * 1024 + 9).fill(77);
    const file = new File([data], 'bounded.bin', { lastModified: 110 });
    const readSizes: number[] = [];
    const originalSlice = file.slice.bind(file);
    Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('WHOLE_FILE_BUFFER_FORBIDDEN'); } });
    Object.defineProperty(file, 'slice', { value: (start: number, end: number) => {
      const blob = originalSlice(start, end);
      const slice = blob.slice.bind(blob);
      Object.defineProperty(blob, 'arrayBuffer', { value: () => { readSizes.push(blob.size); return Blob.prototype.arrayBuffer.call(blob); } });
      Object.defineProperty(blob, 'slice', { value: (a: number, b: number) => {
        const chunk = slice(a, b);
        const read = chunk.arrayBuffer.bind(chunk);
        Object.defineProperty(chunk, 'arrayBuffer', { value: () => { readSizes.push(chunk.size); return read(); } });
        return chunk;
      } });
      return blob;
    } });
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 8 * 1024 * 1024, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'STORED', sha256: body.sha256 });
      return Response.json({ partSize: 8 * 1024 * 1024, partCount: 1, sizeBytes: file.size, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([file]);
    await h.client.begin();
    expect(h.client.jobs[0].status.textContent).toBe('已存储，等待转发');
    expect(h.calls.find(call => call.url.endsWith('/complete'))!.body.sha256).toBe(digest(data));
    expect(Math.max(...readSizes)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('uploads a logical part larger than the direct-request boundary as checked 8 MiB network chunks before assembly', async () => {
    const size = 17 * 1024 * 1024 + 3;
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 17) % 251);
    const file = new File([data], 'nested-large.bin', { lastModified: 123 });
    const partSize = 65 * 1024 * 1024;
    Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('WHOLE_FILE_BUFFER_FORBIDDEN'); } });
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize, partCount: 1 });
      if (url.endsWith('/assemble')) return Response.json({ ok: true, sha256: body.sha256 });
      if (url.endsWith('/complete')) return Response.json({ state: 'STORED', sha256: body.sha256 });
      return Response.json({ partSize, partCount: 1, sizeBytes: size, state: 'UPLOADING', parts: [], chunks: [] });
    } });
    h.client.addFiles([file]);
    await h.client.begin();
    expect(h.puts.map(put => put.url)).toEqual([1, 2, 3].map(index => `/upload-sessions/${TOKEN}/parts/1/chunks/${index}`));
    expect(h.puts.map(put => put.bytes.length)).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024 + 3]);
    for (const put of h.puts) expect(put.headers['X-Part-SHA256']).toBe(digest(put.bytes));
    expect(h.calls.find(call => call.url.endsWith('/assemble'))!.body.sha256).toBe(digest(data));
    expect(h.calls.filter(call => call.url.endsWith('?part=1'))).toHaveLength(1);
    expect(h.calls.find(call => call.url.endsWith('/complete'))!.body.sha256).toBe(digest(data));
    expect(h.client.jobs[0].progress.value).toBe(size);
    expect(h.client.jobs[0].status.textContent).toBe('已存储，等待转发');
  });

  it('resumes a large logical part by verifying and skipping existing network chunks while keeping the 64 MiB direct path', async () => {
    const data = new Uint8Array(8 * 1024 * 1024 + 5).fill(91);
    for (const partSize of [64 * 1024 * 1024, 65 * 1024 * 1024]) {
      const h = harness({ handler: (url, _method, body) => {
        if (url.endsWith('/files')) return Response.json({ files: [] });
        if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize, partCount: 1 });
        if (url.endsWith('/assemble')) return Response.json({ ok: true });
        if (url.endsWith('/complete')) return Response.json({ state: 'STORED', sha256: body.sha256 });
        return Response.json({ partSize, partCount: 1, sizeBytes: data.length, state: 'UPLOADING', parts: [],
          chunks: partSize > 64 * 1024 * 1024 ? [{ number: 1, index: 1, sizeBytes: 8 * 1024 * 1024,
            sha256: digest(data.subarray(0, 8 * 1024 * 1024)) }] : [] });
      } });
      h.client.addFiles([new File([data], 'resume-chunks.bin')]);
      await h.client.begin();
      expect(h.puts).toHaveLength(1);
      expect(h.puts[0].url).toBe(`/upload-sessions/${TOKEN}/parts/1` + (partSize > 64 * 1024 * 1024 ? '/chunks/2' : ''));
      expect(h.puts[0].bytes.length).toBe(partSize > 64 * 1024 * 1024 ? 5 : data.length);
      expect(h.calls.filter(call => call.url.endsWith('/assemble'))).toHaveLength(partSize > 64 * 1024 * 1024 ? 1 : 0);
      expect(h.calls.filter(call => call.url.includes('?part='))).toHaveLength(partSize > 64 * 1024 * 1024 ? 1 : 0);
    }
  });

  it('refuses a mismatching resumed network chunk without assembling or completing the file', async () => {
    const data = new Uint8Array(4096).fill(92);
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 65 * 1024 * 1024, partCount: 1 });
      return Response.json({ partSize: 65 * 1024 * 1024, partCount: 1, sizeBytes: data.length, state: 'UPLOADING',
        parts: [], chunks: [{ number: 1, index: 1, sizeBytes: data.length, sha256: digest('different original bytes') }] });
    } });
    h.client.addFiles([new File([data], 'changed-chunk.bin')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(0);
    expect(h.calls.some(call => call.url.endsWith('/assemble') || call.url.endsWith('/complete'))).toBe(false);
    expect(h.client.jobs[0].status.textContent).toContain('完整性校验未通过');
  });

  it('resumes a saved session after reselecting the original file and skips only server-verified matching parts', async () => {
    const file = new File(['abcdefghij'], 'resume.txt', { lastModified: 200 });
    const storage = new Storage();
    const record = { id: randomUUID(), inviteHash: digest(INVITE), filename: file.name, sizeBytes: file.size,
      lastModified: file.lastModified, mimeType: 'text/plain', token: TOKEN, sha256: digest('abcdefghij'), state: 'PENDING' };
    storage.setItem('cz2128.upload.v1.file.' + record.id, JSON.stringify(record));
    const h = harness({ storage, handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/complete')) return Response.json({ state: 'DELIVERED', sha256: body.sha256 });
      return Response.json({ partSize: 4, partCount: 3, sizeBytes: 10, state: 'UPLOADING', parts: [{ number: 1, sha256: digest('abcd'), sizeBytes: 4 }] });
    } });
    await h.client.initialize();
    h.client.addFiles([file]);
    await h.client.begin();
    expect(h.calls.some(call => call.url.endsWith('/sessions'))).toBe(false);
    expect(h.puts.map(put => put.url)).toEqual(['/upload-sessions/' + TOKEN + '/parts/2', '/upload-sessions/' + TOKEN + '/parts/3']);
    expect(h.client.jobs[0].status.textContent).toBe('已送达');
  });

  it('rejects changed bytes even when filename, size and modification time match the resume manifest', async () => {
    const storage = new Storage();
    const record = { id: randomUUID(), inviteHash: digest(INVITE), filename: 'same.txt', sizeBytes: 4,
      lastModified: 200, token: TOKEN, sha256: digest('abcd'), state: 'PENDING' };
    storage.setItem('cz2128.upload.v1.file.' + record.id, JSON.stringify(record));
    const h = harness({ storage });
    await h.client.initialize();
    h.client.addFiles([new File(['evil'], 'same.txt', { lastModified: 200 })]);
    await h.client.begin();
    expect(h.puts).toHaveLength(0);
    expect(h.client.jobs[0].status.textContent).toContain('与原文件不同');
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
  });

  it('rejects inconsistent server part hashes and never completes a mismatching upload', async () => {
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [{ number: 1, sizeBytes: 4, sha256: digest('evil') }] });
    } });
    h.client.addFiles([new File(['abcd'], 'part.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(0);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
    expect(h.client.jobs[0].status.textContent).toContain('完整性校验未通过');
  });

  it('pauses an active request without finalizing and leaves the upload available to resume', async () => {
    const h = harness({ pauseFirstPut: true });
    h.client.addFiles([new File(['abcd'], 'pause.txt')]);
    const pending = h.client.begin();
    for (let i = 0; i < 100 && h.puts.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    expect(h.puts).toHaveLength(1);
    h.client.jobs[0].pause.click();
    await pending;
    expect(h.client.jobs[0].status.textContent).toContain('已暂停');
    expect(h.client.jobs[0].resume.hidden).toBe(false);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
  });

  it('retries a transient part failure with the same part identity and hash, completing once', async () => {
    const h = harness({ putFailure: [503, 200] });
    h.client.addFiles([new File(['abcd'], 'retry.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(2);
    expect(h.puts[0].url).toBe(h.puts[1].url);
    expect(h.puts[0].headers['X-Part-SHA256']).toBe(h.puts[1].headers['X-Part-SHA256']);
    expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('waits beyond three busy part responses and resumes the same part without mistaking its lease for a rate limit', async () => {
    const waiting: string[] = [];
    const h = harness({ immediateTimers: true, putFailure: [...Array(4).fill({ status: 429, code: 'UPLOAD_PART_BUSY' }), 200],
      onTimer: (_ms, client) => waiting.push(client.jobs[0].status.textContent) });
    h.client.addFiles([new File(['abcd'], 'leased.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(5);
    expect(new Set(h.puts.map(put => put.headers['X-Part-SHA256']))).toEqual(new Set([digest('abcd')]));
    expect(waiting.some(text => text.includes('服务器仍在处理'))).toBe(true);
    expect(waiting.every(text => !text.includes('过于频繁') && !text.includes('已送达'))).toBe(true);
    expect(h.timerDurations.filter(ms => ms !== 2000).reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(20000);
    expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
  });

  it('stops waiting for a busy part promptly when paused and never completes the unfinished file', async () => {
    let paused = false;
    const h = harness({ immediateTimers: true, putFailure: [{ status: 429, code: 'UPLOAD_PART_BUSY' }], onTimer: (_ms, client) => {
      if (!paused) { paused = true; client.jobs[0].pause.click(); }
    } });
    h.client.addFiles([new File(['abcd'], 'pause-lease.txt')]);
    await h.client.begin();
    expect(paused).toBe(true);
    expect(h.puts).toHaveLength(1);
    expect(h.timerDurations[0]).toBeLessThanOrEqual(250);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
    expect(h.client.jobs[0].status.textContent).toContain('已暂停');
    expect(h.client.jobs[0].record.state).not.toBe('DELIVERED');
  });

  it('does not PUT a busy part again if the original request is subsequently confirmed stored with the same hash and length', async () => {
    const h = harness({ immediateTimers: true, putFailure: [{ status: 429, code: 'UPLOAD_PART_BUSY' }], handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'QUEUED', sha256: body.sha256 });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING',
        parts: h.puts.length ? [{ number: 1, sizeBytes: 4, sha256: digest('abcd') }] : [] });
    } });
    h.client.addFiles([new File(['abcd'], 'late-stored.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(1);
    expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('rejects a conflicting late part manifest instead of trusting its stored state', async () => {
    const h = harness({ immediateTimers: true, putFailure: [{ status: 429, code: 'UPLOAD_PART_BUSY' }], handler: (url) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING',
        parts: h.puts.length ? [{ number: 1, sizeBytes: 3, sha256: digest('abcd') }] : [] });
    } });
    h.client.addFiles([new File(['abcd'], 'late-conflict.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(1);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
    expect(h.client.jobs[0].status.textContent).toContain('完整性校验未通过');
  });

  it('uses the confirmed chunk manifest after a busy response without PUTting that chunk again', async () => {
    const h = harness({ immediateTimers: true, putFailure: [{ status: 429, code: 'UPLOAD_CHUNK_BUSY' }], handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 65 * 1024 * 1024, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'QUEUED', sha256: body.sha256 });
      if (url.endsWith('/assemble')) return Response.json({ ok: true });
      return Response.json({ partSize: 65 * 1024 * 1024, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [],
        chunks: h.puts.length ? [{ number: 1, index: 1, sizeBytes: 4, sha256: digest('abcd') }] : [] });
    } });
    h.client.addFiles([new File(['abcd'], 'late-chunk.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].url).toContain('/parts/1/chunks/1');
    expect(h.calls.filter(call => call.url.includes('?part=1'))).toHaveLength(2);
    expect(h.calls.filter(call => call.url.endsWith('/assemble'))).toHaveLength(1);
    expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
  });

  it('waits through a busy completion lease without presenting storage or delivery before verified completion', async () => {
    let completions = 0;
    const waiting: string[] = [];
    const h = harness({ immediateTimers: true, onTimer: (_ms, client) => waiting.push(client.jobs[0].status.textContent), handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return ++completions <= 4
        ? Response.json({ code: 'UPLOAD_COMPLETION_BUSY' }, { status: 429 })
        : Response.json({ state: 'QUEUED', sha256: body.sha256 });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'completion-lease.txt')]);
    await h.client.begin();
    expect(completions).toBe(5);
    expect(h.puts).toHaveLength(1);
    expect(waiting.some(text => text.includes('服务器仍在处理'))).toBe(true);
    expect(waiting.every(text => !text.includes('过于频繁') && !text.includes('已存储') && !text.includes('已送达'))).toBe(true);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('waits a minute for an actual rate limit and shows rate-limit copy rather than a storage claim', async () => {
    const waiting: string[] = [];
    const h = harness({ immediateTimers: true, putFailure: [{ status: 429, code: 'UPLOAD_RATE_LIMITED' }, 200],
      onTimer: (_ms, client) => waiting.push(client.jobs[0].status.textContent) });
    h.client.addFiles([new File(['abcd'], 'rate-window.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(2);
    expect(h.timerDurations.filter(ms => ms !== 2000).reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(60000);
    expect(waiting.some(text => text.includes('请求过于频繁'))).toBe(true);
    expect(waiting.every(text => !text.includes('已送达'))).toBe(true);
    expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
  });

  it('bounds an unresolved busy lease without completing or claiming that the unfinished file was delivered', async () => {
    const h = harness({ immediateTimers: true, putFailure: Array(90).fill({ status: 429, code: 'UPLOAD_PART_BUSY' }) });
    h.client.addFiles([new File(['abcd'], 'lease-exhausted.txt')]);
    await h.client.begin();
    expect(h.puts.length).toBeGreaterThan(60);
    expect(h.puts.length).toBeLessThanOrEqual(74);
    expect(h.timerDurations.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(360000);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
    expect(h.client.jobs[0].status.textContent).toContain('服务器仍在处理');
    expect(h.client.jobs[0].record.state).not.toBe('DELIVERED');
  });

  it('cancels during a busy wait without another PUT or completing the file', async () => {
    let cancellation: any;
    const h = harness({ immediateTimers: true, putFailure: [{ status: 429, code: 'UPLOAD_PART_BUSY' }],
      onTimer: (_ms, client) => { if (!cancellation) cancellation = client.jobs[0].cancel.click(); } });
    h.client.addFiles([new File(['abcd'], 'cancel-lease.txt')]);
    await h.client.begin();
    await cancellation;
    expect(h.puts).toHaveLength(1);
    expect(h.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
    expect(h.client.jobs[0].status.textContent).toBe('已取消上传');
    expect(h.storage.length).toBe(0);
  });

  it('uses a verified stored attachment after a completion lease finishes without issuing another completion request', async () => {
    let completions = 0;
    const h = harness({ immediateTimers: true, handler: (url) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) { completions++; return Response.json({ code: 'UPLOAD_COMPLETION_BUSY' }, { status: 429 }); }
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: completions ? 'QUEUED' : 'UPLOADING', parts: [],
        ...(completions ? { attachment: { state: 'QUEUED', sha256: digest('abcd') } } : {}) });
    } });
    h.client.addFiles([new File(['abcd'], 'late-completion.txt')]);
    await h.client.begin();
    expect(completions).toBe(1);
    expect(h.puts).toHaveLength(1);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it.each(['part', 'complete'])('does not render or interpret an unsafe %s HTTP error code as a busy lease', async stage => {
    let completions = 0;
    const waiting: string[] = [];
    const code = 'UPLOAD_PART_BUSY<script>private-value</script>';
    const h = harness({ immediateTimers: true,
      putFailure: stage === 'part' ? [{ status: 429, code }, 200] : undefined,
      onTimer: (_ms, client) => waiting.push(client.jobs[0].status.textContent), handler: (url, _method, body) => {
        if (url.endsWith('/files')) return Response.json({ files: [] });
        if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
        if (url.endsWith('/complete')) return stage === 'complete' && ++completions === 1
          ? Response.json({ code }, { status: 429 }) : Response.json({ state: 'QUEUED', sha256: body.sha256 });
        return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
      } });
    h.client.addFiles([new File(['abcd'], 'safe-error.txt')]);
    await h.client.begin();
    expect(waiting.some(text => text.includes('请求过于频繁'))).toBe(true);
    expect(waiting.every(text => !text.includes('private-value') && !text.includes('<script>') && !text.includes('服务器仍在处理'))).toBe(true);
    expect(h.timerDurations.filter(ms => ms !== 2000).reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(60000);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('waits for a busy assembly and trusts only its later confirmed part hash and length', async () => {
    let assemblies = 0;
    const h = harness({ immediateTimers: true, handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 65 * 1024 * 1024, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'QUEUED', sha256: body.sha256 });
      if (url.endsWith('/assemble')) { assemblies++; return Response.json({ code: 'UPLOAD_PART_BUSY' }, { status: 429 }); }
      return Response.json({ partSize: 65 * 1024 * 1024, partCount: 1, sizeBytes: 4, state: 'UPLOADING',
        parts: assemblies ? [{ number: 1, sizeBytes: 4, sha256: digest('abcd') }] : [], chunks: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'late-assembly.txt')]);
    await h.client.begin();
    expect(assemblies).toBe(1);
    expect(h.puts).toHaveLength(1);
    expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('cancels the upload session and removes its resume manifest without completing the file', async () => {
    const h = harness({ pauseFirstPut: true });
    h.client.addFiles([new File(['abcd'], 'cancel.txt')]);
    const pending = h.client.begin();
    for (let i = 0; i < 100 && h.puts.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    await h.client.jobs[0].cancel.click();
    await pending;
    expect(h.calls.some(call => call.url === '/upload-sessions/' + TOKEN && call.method === 'DELETE')).toBe(true);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
    expect(h.storage.length).toBe(0);
    expect(h.client.jobs[0].status.textContent).toBe('已取消上传');
  });

  it('keeps ABORTING visible until the server confirms cleanup and preserves its recovery record', async () => {
    let abortRequested = false;
    let cleanupComplete = false;
    const h = harness({ pauseFirstPut: true, handler: (url, method) => {
      if (method === 'DELETE') { abortRequested = true; return Response.json({ state: 'ABORTING' }); }
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (abortRequested) return Response.json({ state: cleanupComplete ? 'ABORTED' : 'ABORTING' });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'cancel-pending.txt')]);
    const pending = h.client.begin();
    for (let i = 0; i < 100 && h.puts.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    await h.client.jobs[0].cancel.click();
    await pending;
    expect(h.client.jobs[0].status.textContent).toBe('正在取消，后台清理中');
    expect(h.client.jobs[0].record.state).toBe('ABORTING');
    expect(h.client.jobs[0].resume.hidden).toBe(true);
    expect(h.client.jobs[0].dispatch.hidden).toBe(true);
    expect(h.client.jobs[0].refresh.hidden).toBe(false);
    expect(h.storage.length).toBe(2);
    cleanupComplete = true;
    await h.client.jobs[0].refresh.click();
    expect(h.client.jobs[0].status.textContent).toBe('已取消上传');
    expect(h.storage.length).toBe(0);
    expect(h.calls.some(call => call.url.endsWith('/complete'))).toBe(false);
  });

  it('does not show completion when the server final checksum differs from the original file', async () => {
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'DELIVERED', sha256: digest('evil') });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'integrity.txt')]);
    await h.client.begin();
    expect(h.client.jobs[0].status.textContent).toContain('完整性校验未通过');
    expect(h.client.jobs[0].record.state).not.toBe('DELIVERED');
  });

  it('requires a valid same-origin download URL instead of inventing a link when it is absent', async () => {
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'STORED', sha256: body.sha256 });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'no-link.txt')]);
    await h.client.begin();
    expect(h.client.jobs[0].details.children.every((node: Element) => !node.href)).toBe(true);
  });

  it('accepts the real completion endpoint nested attachment response and its confirmed checksum', async () => {
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ sessionId: 'server-session', state: 'QUEUED',
        attachment: { state: 'QUEUED', sha256: body.sha256, expiresAt: 1900000000,
          url: 'https://upload.example/attachments/synthetic/download' } }, { status: 202 });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'nested.txt')]);
    await h.client.begin();
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
    expect(h.client.jobs[0].record.sha256).toBe(digest('abcd'));
    expect(h.client.jobs[0].details.children.some((node: Element) => node.href.endsWith('/attachments/synthetic/download'))).toBe(true);
  });

  it('continues checkpoint verification with the same whole-file hash and shows storage only after the final verified response', async () => {
    let checkpoints = 0;
    const snapshots: Array<{ text: string; progress: number; state: string }> = [];
    const h = harness({ onTimer: (ms, client) => {
      if (ms === 50) snapshots.push({ text: client.jobs[0].status.textContent, progress: client.jobs[0].progress.value, state: client.jobs[0].record.state });
    }, handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) {
        checkpoints++;
        return checkpoints <= 2 ? Response.json({ state: 'VERIFYING', verification: { verifiedBytes: checkpoints, totalBytes: 4 } }, { status: 202 })
          : Response.json({ state: 'QUEUED', attachment: { state: 'QUEUED', sha256: body.sha256 } }, { status: 202 });
      }
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'checkpoints.txt')]);
    await h.client.begin();
    expect(snapshots.map(row => row.progress)).toEqual([1, 2]);
    expect(snapshots.every(row => row.state === 'VERIFYING' && row.text.includes('正在校验完整性') && !row.text.includes('已存储'))).toBe(true);
    expect(h.calls.filter(call => call.url.endsWith('/complete')).map(call => call.body.sha256)).toEqual(Array(3).fill(digest('abcd')));
    expect(h.puts).toHaveLength(1);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('pauses between verification checkpoints, retains the manifest and resumes the same verification without uploading again', async () => {
    let checkpoints = 0;
    let shouldPause = true;
    const h = harness({ onTimer: (ms, client) => {
      if (ms === 50 && shouldPause) { shouldPause = false; client.jobs[0].pause.click(); }
    }, handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) {
        checkpoints++;
        return checkpoints === 1 ? Response.json({ state: 'VERIFYING', verification: { verifiedBytes: 2, totalBytes: 4 } }, { status: 202 })
          : Response.json({ state: 'QUEUED', attachment: { state: 'QUEUED', sha256: body.sha256 } }, { status: 202 });
      }
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: checkpoints ? 'VERIFYING' : 'UPLOADING', parts: [],
        ...(checkpoints ? { verification: { verifiedBytes: 2, totalBytes: 4 } } : {}) });
    } });
    h.client.addFiles([new File(['abcd'], 'pause-verification.txt')]);
    await h.client.begin();
    expect(checkpoints).toBe(1);
    expect(h.client.jobs[0].record.state).toBe('VERIFYING');
    expect(h.client.jobs[0].status.textContent).toContain('已暂停');
    expect(h.storage.length).toBe(2);
    expect(h.client.jobs[0].resume.hidden).toBe(false);
    await h.client.jobs[0].resume.click();
    expect(checkpoints).toBe(2);
    expect(h.puts).toHaveLength(1);
    expect(h.client.jobs[0].status.textContent).toBe('已排队，等待送达');
  });

  it('shows durable stored bytes and a download link after FAILED transfer without offering a resend', async () => {
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [{ filename: 'failed.txt', sizeBytes: 4, state: 'FAILED',
        url: 'https://upload.example/attachments/failed/download' }] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'FAILED', attachment: { state: 'FAILED',
        sha256: body.sha256, expiresAt: 1900000000, url: 'https://upload.example/attachments/failed/download' } });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    h.client.addFiles([new File(['abcd'], 'failed.txt')]);
    await h.client.begin();
    const job = h.client.jobs[0];
    expect(job.status.textContent).toBe('文件已存储，转发失败，请联系人工客服');
    expect(job.progress.value).toBe(4);
    expect(job.resume.hidden).toBe(true);
    expect(job.cancel.hidden).toBe(true);
    expect(job.dispatch.hidden).toBe(true);
    expect(job.details.children.some((node: Element) => node.href.endsWith('/attachments/failed/download'))).toBe(true);
    expect(h.elements.get('stored-files')!.children[0].children[1].textContent).toContain('转发失败');
    expect(h.calls.some(call => call.url.endsWith('/dispatch'))).toBe(false);
  });

  it('recovers by session capability without needing a live invitation or starting a replacement upload', async () => {
    const h = harness({ path: '/upload-sessions/' + TOKEN + '/page', handler: (_url, _method, body) =>
      Response.json(body?.sha256 ? { state: 'STORED', sha256: body.sha256 } :
        { filename: 'recover.txt', sizeBytes: 4, partSize: 4, partCount: 1, state: 'UPLOADING', parts: [] }) });
    await h.client.initialize();
    h.client.addFiles([new File(['abcd'], 'recover.txt')]);
    await h.client.begin();
    expect(h.puts).toHaveLength(1);
    expect(h.calls.every(call => call.url.startsWith('/upload-sessions/'))).toBe(true);
    expect(h.client.jobs[0].status.textContent).toBe('已存储，等待转发');
  });

  it('keeps expired recovery errors visible and never exposes raw provider error details', async () => {
    const h = harness({ path: '/upload-sessions/' + TOKEN + '/page', handler: () =>
      Response.json({ message: 'private-capability-' + TOKEN }, { status: 410 }) });
    await h.client.initialize();
    expect(h.elements.get('notice')!.textContent).toContain('已过期');
    expect(h.elements.get('notice')!.textContent).not.toContain(TOKEN);
    expect(h.elements.get('files')!.disabled).toBe(true);
  });

  it('renders only same-origin download links and distinguishes uncertain delivery without offering a resend', async () => {
    const h = harness({ handler: (url, _method, body) => {
      if (url.endsWith('/files')) return Response.json({ files: [{ filename: 'safe.txt', sizeBytes: 4, state: 'STORED', url: 'https://other.example/token' }] });
      if (url.endsWith('/sessions')) return Response.json({ token: TOKEN, partSize: 4, partCount: 1 });
      if (url.endsWith('/complete')) return Response.json({ state: 'AMBIGUOUS', sha256: body.sha256, url: 'javascript:alert(1)' });
      return Response.json({ partSize: 4, partCount: 1, sizeBytes: 4, state: 'UPLOADING', parts: [] });
    } });
    await h.client.initialize();
    h.client.addFiles([new File(['abcd'], 'uncertain.txt')]);
    await h.client.begin();
    expect(h.client.jobs[0].status.textContent).toContain('交付结果不确定');
    expect(h.client.jobs[0].dispatch.hidden).toBe(true);
    expect(h.client.jobs[0].details.children.every((node: Element) => !node.href)).toBe(true);
    expect(h.elements.get('stored-files')!.children[0].children.every(node => !node.href)).toBe(true);
  });
});
