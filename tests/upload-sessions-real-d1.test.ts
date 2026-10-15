import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONFIG = 'tests/fixtures/wrangler.multipart-harness.toml';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No local port allocated'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('multipart HTTP transport with real Wrangler local D1, R2 and FixedLengthStream', () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'cz2128-multipart-runtime-'));
  let child: ChildProcess | undefined;
  let baseUrl: string;
  let output = '';

  async function startWorker() {
    const port = await freePort();
    const inspector = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    output = '';
    child = spawn('npx', ['wrangler', 'dev', '--config', CONFIG, '--local', '--persist-to', persistDir,
      '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
      '--log-level', 'error', '--show-interactive-dev-session=false'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Local multipart Worker exited: ${output}`);
      try { if ((await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Local multipart Worker was not ready: ${output}`);
  }

  async function stopWorker() {
    if (!child?.pid || child.exitCode !== null) return;
    const pid = child.pid;
    const ended = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) { try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 1000))]);
  }

  async function json(path: string, body?: unknown, expected = 200): Promise<any> {
    const response = await fetch(baseUrl + path, body === undefined ? { signal: AbortSignal.timeout(45_000) } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000)
    });
    const text = await response.text();
    expect(response.status, `Local request status; response=${text.slice(0, 1200)}`).toBe(expected);
    return JSON.parse(text);
  }

  async function seed() { return json('/seed', {}); }
  async function init(invite: any, bytes: Uint8Array, id = randomUUID(), expected = 200) {
    return json('/uploads/' + invite.token + '/sessions', { id, filename: 'synthetic.bin', sizeBytes: bytes.length, mimeType: 'image/png' }, expected);
  }
  async function put(session: any, bytes: Uint8Array, number = 1, hash = sha256(bytes)) {
    return fetch(`${baseUrl}/upload-sessions/${session.token}/parts/${number}`, {
      method: 'PUT', headers: { 'X-Part-SHA256': hash, 'Content-Length': String(bytes.length) },
      body: Uint8Array.from(bytes).buffer, signal: AbortSignal.timeout(45_000)
    });
  }

  beforeAll(async () => {
    const config = readFileSync(CONFIG, 'utf8');
    expect(config).toContain('database_id = "local-dev-only"');
    expect(config).toContain('remote = false');
    expect(config).not.toContain('cz2128-4c-staging');
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir, '--config', CONFIG],
      { stdio: 'pipe', timeout: 45_000, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
    await startWorker();
  }, 60_000);

  afterAll(async () => { await stopWorker(); rmSync(persistDir, { recursive: true, force: true }); });

  it('persists and downloads 32 MiB across four 8 MiB parts with exact SHA-256, Range and 72-hour retention', async () => {
    const bytes = Uint8Array.from({ length: 32 * 1024 * 1024 }, (_, i) => i % 251);
    const invite = await seed();
    const session = await init(invite, bytes);
    expect(session.partSize).toBe(8 * 1024 * 1024);
    expect(session.partCount).toBe(4);
    for (let number = 1; number <= 4; number++) {
      const response = await put(session, bytes.subarray((number - 1) * session.partSize, number * session.partSize), number);
      expect(response.status, await response.text()).toBe(200);
    }
    const completed = await json('/upload-sessions/' + session.token + '/complete', { sha256: sha256(bytes) }, 202);
    expect(completed.state).toBe('QUEUED');
    expect(completed.attachment.sha256).toBe(sha256(bytes));
    expect(completed.attachment.url).toMatch(/^https:\/\/multipart\.local\.example\/attachments\//);
    const snapshot = await json('/snapshot/' + session.sessionId);
    expect(snapshot.stored_size_bytes).toBe(bytes.length);
    expect(snapshot.size_bytes).toBeNull();
    expect(snapshot.sha256).toBe(sha256(bytes));
    expect(snapshot.retention_class).toBe('FILE');
    expect(snapshot.retention_expires_at - snapshot.stored_at).toBe(72 * 3600);
    expect(snapshot.stored_parts).toBe(4);
    expect(snapshot.dispatch_count).toBe(1);
    const path = new URL(completed.attachment.url).pathname;
    const downloaded = await fetch(baseUrl + path);
    expect(downloaded.status).toBe(200);
    expect(sha256(new Uint8Array(await downloaded.arrayBuffer()))).toBe(sha256(bytes));
    const range = await fetch(baseUrl + path, { headers: { Range: 'bytes=1048575-1049600' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('Content-Range')).toBe(`bytes 1048575-1049600/${bytes.length}`);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(1048575, 1049601));
    const head = await fetch(baseUrl + path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(bytes.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  }, 60_000);

  it('resumes the same real R2 multipart upload after workerd restart and invitation expiry', async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 4096).fill(42);
    const invite = await seed();
    const session = await init(invite, bytes);
    expect((await put(session, bytes.subarray(0, session.partSize))).status).toBe(200);
    await json('/control', { inviteId: invite.inviteId, action: 'expire-invite' });
    await stopWorker(); await startWorker();
    const resumed = await json('/upload-sessions/' + session.token);
    expect(resumed.sessionId).toBe(session.sessionId);
    expect(resumed.parts).toEqual([{ number: 1, sizeBytes: session.partSize, sha256: sha256(bytes.subarray(0, session.partSize)) }]);
    expect((await put(session, bytes.subarray(session.partSize), 2)).status).toBe(200);
    const completed = await json('/upload-sessions/' + session.token + '/complete', { sha256: sha256(bytes) }, 202);
    expect(completed.attachment.sha256).toBe(sha256(bytes));
    const download = await fetch(baseUrl + new URL(completed.attachment.url).pathname);
    expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(bytes));
    expect((await json('/snapshot/' + session.sessionId)).dispatch_count).toBe(1);
    await init(invite, new Uint8Array(4), randomUUID(), 410);
  }, 60_000);

  it('verifies an 80 MiB file in bounded persisted ranges and resumes verification after restart', async()=>{
    const bytes=new Uint8Array(80*1024*1024).fill(61);
    const invite=await seed();const session=await init(invite,bytes);
    for(let number=1;number<=session.partCount;number++){
      const response=await put(session,bytes.subarray((number-1)*session.partSize,Math.min(number*session.partSize,bytes.length)),number);
      expect(response.status,await response.text()).toBe(200);
    }
    let result=await json('/upload-sessions/'+session.token+'/complete',{sha256:sha256(bytes)},202);
    expect(result.state).toBe('VERIFYING');expect(result.attachment).toBeUndefined();expect(result.verification.verifiedBytes).toBe(16*1024*1024);
    await stopWorker();await startWorker();
    const resumed=await json('/upload-sessions/'+session.token);expect(resumed.state).toBe('VERIFYING');expect(resumed.verification.verifiedBytes).toBe(result.verification.verifiedBytes);
    let calls=1;
    while(result.state==='VERIFYING'&&calls<8){result=await json('/upload-sessions/'+session.token+'/complete',{sha256:sha256(bytes)},202);calls++;}
    expect(calls).toBe(5);expect(result.state).toBe('QUEUED');expect(result.attachment.sha256).toBe(sha256(bytes));
    const downloaded=await fetch(baseUrl+new URL(result.attachment.url).pathname);expect(sha256(new Uint8Array(await downloaded.arrayBuffer()))).toBe(sha256(bytes));
  },60_000);

  it('assembles network chunks through actual local R2 into one larger logical part',async()=>{
    const bytes=new Uint8Array(17*1024*1024).fill(83);const invite=await seed();const session=await init(invite,bytes);
    await json('/control',{inviteId:invite.inviteId,sessionId:session.sessionId,action:'logical-part-size',partSize:65*1024*1024});
    for(let index=1;index<=3;index++){
      const chunk=bytes.subarray((index-1)*8*1024*1024,Math.min(index*8*1024*1024,bytes.length));
      const response=await fetch(baseUrl+`/upload-sessions/${session.token}/parts/1/chunks/${index}`,{method:'PUT',
        headers:{'Content-Length':String(chunk.length),'X-Part-SHA256':sha256(chunk)},body:chunk});
      expect(response.status,await response.text()).toBe(200);
    }
    const manifest=await json('/upload-sessions/'+session.token+'?part=1');expect(manifest.chunks).toHaveLength(3);
    await json('/upload-sessions/'+session.token+'/parts/1/assemble',{sha256:sha256(bytes)});
    const completed=await json('/upload-sessions/'+session.token+'/complete',{sha256:sha256(bytes)},202);
    expect(completed.attachment.sha256).toBe(sha256(bytes));const response=await fetch(baseUrl+new URL(completed.attachment.url).pathname);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(bytes));
  },60_000);

  it('converges identical concurrent parts and rejects a conflicting manifest without changing the confirmed hash', async () => {
    const bytes = new Uint8Array(4096).fill(11);
    const session = await init(await seed(), bytes);
    const concurrent = await Promise.all([put(session, bytes), put(session, bytes)]);
    expect(concurrent.map(response => response.status).every(status => status === 200 || status === 429)).toBe(true);
    expect(concurrent.some(response => response.status === 200)).toBe(true);
    expect((await put(session, bytes)).status).toBe(200);
    expect((await put(session, bytes, 1, sha256(new Uint8Array(4096).fill(12)))).status).toBe(409);
    const current = await json('/upload-sessions/' + session.token);
    expect(current.parts).toEqual([{ number: 1, sizeBytes: bytes.length, sha256: sha256(bytes) }]);
    expect((await json('/snapshot/' + session.sessionId)).stored_parts).toBe(1);
  }, 30_000);

  it('rejects corrupt bytes in the real FixedLengthStream and lets the same declared hash retry safely', async () => {
    const good = new Uint8Array(4096).fill(13);
    const bad = new Uint8Array(4096).fill(14);
    const session = await init(await seed(), good);
    expect((await put(session, bad, 1, sha256(good))).status).toBe(422);
    expect((await json('/upload-sessions/' + session.token)).parts).toEqual([]);
    expect((await put(session, good)).status).toBe(200);
    const completed = await json('/upload-sessions/' + session.token + '/complete', { sha256: sha256(good) }, 202);
    expect(completed.attachment.sha256).toBe(sha256(good));
  }, 30_000);

  it('denies revoked invitations, expired sessions and unknown capabilities before accepting more bytes', async () => {
    const bytes = new Uint8Array(32).fill(15);
    const revoked = await seed(); const session = await init(revoked, bytes);
    await json('/control', { inviteId: revoked.inviteId, action: 'revoke-invite' });
    expect((await put(session, bytes)).status).toBe(410);
    await init(revoked, bytes, randomUUID(), 410);
    const expired = await seed(); const old = await init(expired, bytes);
    await json('/control', { inviteId: expired.inviteId, sessionId: old.sessionId, action: 'expire-session' });
    expect((await put(old, bytes)).status).toBe(410);
    await json('/upload-sessions/' + 'z'.repeat(43), undefined, 404);
    expect((await json('/snapshot/' + old.sessionId)).stored_parts).toBe(0);
  });
});
