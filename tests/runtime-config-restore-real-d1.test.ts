import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const configPath = 'tests/fixtures/wrangler.runtime-config-restore-harness.toml';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port allocated'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('Runtime Config Restore ENV and Crisp quiet state against real local D1', () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'cz2128-runtime-restore-'));
  let child: ChildProcess;
  let baseUrl: string;
  let output = '';

  async function request(path: string, payload?: unknown, expectedStatus = 200): Promise<any> {
    const response = await fetch(`${baseUrl}${path}`, payload === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(`${path} expected ${expectedStatus}, got ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  }

  async function startWorker() {
    const port = await freePort();
    const inspectorPort = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn('npx', [
      'wrangler', 'dev', '--config', configPath, '--local', '--persist-to', persistDir,
      '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort),
      '--log-level', 'error', '--show-interactive-dev-session=false'
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Wrangler harness did not become ready:\n${output}`);
  }

  async function stopWorker() {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }

  beforeAll(async () => {
    execFileSync('npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir,
      '--config', configPath
    ], { stdio: 'pipe', env: { ...process.env, CI: '1' } });
    await startWorker();
  }, 60_000);

  beforeEach(async () => {
    await request('/reset', {});
  });

  afterAll(async () => {
    await stopWorker();
    rmSync(persistDir, { recursive: true, force: true });
  });

  it('converges concurrent replies and freezes missing and duplicate timestamps through real D1 batch', async () => {
    const now = Date.now();
    await request('/quiet-record', { ref: 'missing' });
    await Promise.all([
      request('/quiet-record', { ref: 'newer', timestamp: now - 2000 }),
      request('/quiet-record', { ref: 'older', timestamp: now - 100000 })
    ]);
    await request('/quiet-record', { ref: 'older', timestamp: now });
    await request('/quiet-record', { ref: 'missing', timestamp: now });
    const snapshot = await request('/quiet-snapshot');
    expect(snapshot.clock).toEqual({ last_crisp_human_reply_at: Math.floor((now - 2000) / 1000) });
    expect(snapshot.receipts).toHaveLength(3);
    expect(snapshot.receipts.find((value: any) => value.provider_message_ref === 'missing').reply_at).toBeNull();
  });

  it('allows only one concurrent config CAS and rejects an old absent-row ABA after restore', async () => {
    const results = await Promise.all(['30', '60'].map(async (value, i) => {
      const response = await fetch(`${baseUrl}/quiet-set`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value,
          expectedVersion: 0, historyVersion: 0, actor: String(i), update: `race-${i}` }) });
      return response.status;
    }));
    expect(results.sort()).toEqual([200, 409]);
    await request('/quiet-restore', { expectedVersion: 1, update: 'restore' });
    expect(await request('/quiet-set', { value: '5', expectedVersion: 0,
      historyVersion: 0, update: 'stale' }, 409)).toEqual({ error: 'RUNTIME_CONFIG_VERSION_CONFLICT' });
    const snapshot = await request('/quiet-snapshot');
    expect(snapshot.minutes).toBe(15);
    expect(snapshot.history).toEqual([{ version: 1, action: 'SET' }, { version: 2, action: 'RESTORE_ENV' }]);
  });

  it('keeps both minute setting and per-conversation clock after a real Worker process restart', async () => {
    const timestamp = Date.now() - 1000;
    await request('/quiet-record', { ref: 'restart', timestamp });
    await request('/quiet-set', { value: '10', expectedVersion: 0, historyVersion: 0, update: 'restart-set' });
    await stopWorker();
    await startWorker();
    const snapshot = await request('/quiet-snapshot');
    expect(snapshot.minutes).toBe(10);
    expect(snapshot.clock).toEqual({ last_crisp_human_reply_at: Math.floor(timestamp / 1000) });
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.history).toEqual([{ version: 1, action: 'SET' }]);
  }, 60_000);

  it('restores an empty D1 keyword override to the original non-empty ENV rules with RESTORE_ENV history', async () => {
    const initial = await request('/snapshot');
    expect(initial.source).toBe('ENV');
    expect(initial.active).toBeNull();
    expect(initial.rules).toEqual([
      { id: 'kw_3333333333333333', keyword: 'env-original', reply: 'env-reply', enabled: true }
    ]);

    const empty = JSON.stringify({ version: 1, rules: [] });
    expect(await request('/set', {
      value: empty, expectedVersion: 0, actor: '1001', update: 'real-set-1'
    })).toEqual({ version: 1 });

    const overridden = await request('/snapshot');
    expect(overridden.source).toBe('D1');
    expect(overridden.active).toMatchObject({ key: 'CRISP_KEYWORD_RULES', version: 1, value_text: empty });
    expect(overridden.rules).toEqual([]);

    expect(await request('/restore', {
      expectedVersion: 1, actor: '1001', update: 'real-restore-2'
    })).toEqual({ version: 2 });

    const restored = await request('/snapshot');
    expect(restored.source).toBe('ENV');
    expect(restored.active).toBeNull();
    expect(restored.rules).toEqual([
      { id: 'kw_3333333333333333', keyword: 'env-original', reply: 'env-reply', enabled: true }
    ]);
    expect(restored.history).toHaveLength(2);
    expect(restored.history[0]).toMatchObject({
      version: 1, action: 'SET', is_deleted: 0, actor_user_id: '1001', source_update_id: 'real-set-1'
    });
    expect(restored.history[1]).toMatchObject({
      version: 2, action: 'RESTORE_ENV', is_deleted: 1, actor_user_id: '1001', source_update_id: 'real-restore-2'
    });
  }, 30_000);

  it('rejects a stale Restore ENV CAS and preserves the newer D1 version', async () => {
    const v1 = JSON.stringify({
      version: 1,
      rules: [{ id: 'kw_1111111111111111', keyword: 'one', reply: 'one-reply', enabled: true }]
    });
    const v2 = JSON.stringify({
      version: 1,
      rules: [{ id: 'kw_2222222222222222', keyword: 'two', reply: 'two-reply', enabled: true }]
    });
    await request('/set', { value: v1, expectedVersion: 0, actor: '1001', update: 'stale-set-1' });
    await request('/set', { value: v2, expectedVersion: 1, actor: '1002', update: 'stale-set-2' });

    const conflict = await request('/restore', {
      expectedVersion: 1, actor: '1001', update: 'stale-restore'
    }, 409);
    expect(conflict).toEqual({ error: 'RUNTIME_CONFIG_VERSION_CONFLICT' });

    const snapshot = await request('/snapshot');
    expect(snapshot.source).toBe('D1');
    expect(snapshot.active).toMatchObject({ version: 2, value_text: v2, updated_by: '1002' });
    expect(snapshot.history.map((row: any) => row.action)).toEqual(['SET', 'SET']);
  }, 30_000);
});
