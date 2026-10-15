import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const configPath = 'tests/fixtures/wrangler.knowledge-repository-harness.toml';
const localEnv = { ...process.env, CI: '1', CLOUDFLARE_API_TOKEN: 'synthetic-local-only-unused', WRANGLER_SEND_METRICS: 'false' };
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No local test port'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('knowledge repository with real local workerd D1 and FTS trigger metadata', () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'cz2128-knowledge-repository-'));
  let child: ChildProcess;
  let baseUrl: string;
  let output = '';

  async function request(path: string, payload?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(baseUrl + path, payload === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir,
      '--config', configPath, '--file', 'migrations/0009_knowledge_base.sql'], { stdio: 'pipe', env: localEnv });
    const port = await freePort(); const inspector = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn('npx', ['wrangler', 'dev', '--config', configPath, '--local', '--persist-to', persistDir,
      '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
      '--log-level', 'error', '--show-interactive-dev-session=false'], { stdio: ['ignore', 'pipe', 'pipe'], env: localEnv });
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Local worker exited:\n${output}`);
      try { if ((await fetch(baseUrl + '/health')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Local worker startup timed out:\n${output}`);
  }, 60_000);
  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(persistDir, { recursive: true, force: true });
  });

  it('proves D1 meta.changes includes FTS side effects while SQLite changes() reports one direct row', async () => {
    const { status, body } = await request('/trigger-metadata', {});
    expect(status).toBe(200);
    expect(body[0].changes).toBeGreaterThan(1);
    expect(body[1].changes).toBeGreaterThan(1);
    expect(body[2].results).toEqual([{ direct_changes: 1 }]);
    expect(body[3].changes).toBeGreaterThan(1);
    expect(body[4].results).toEqual([{ direct_changes: 1 }]);
    const historyProbe = await request('/history-metadata', {});
    expect(historyProbe.body[2].changes).toBeGreaterThan(1);
    expect(historyProbe.body[3].results).toEqual([{ direct_changes: 1 }]);
  });

  it('reports success for create, body/title edit, disable, enable and delete with exact history and FTS', async () => {
    const created = await request('/create', { title: 'Synthetic whale4317', body: 'First support window', update: 'create' });
    expect(created.status).toBe(200); const id = created.body.id;
    const edited = await request('/update', { id, version: 1, title: 'Synthetic whale4317', body: 'Updated support window', update: 'edit-body' });
    expect(edited.status, JSON.stringify(edited)).toBe(200);
    expect(edited.body).toMatchObject({ id, version: 2, title: 'Synthetic whale4317', body: 'Updated support window' });
    const titleEdited = await request('/update', { id, version: 2, title: 'Synthetic dolphin8642', body: 'Updated support window', update: 'edit-title' });
    expect(titleEdited.status).toBe(200);
    expect(titleEdited.body).toMatchObject({ id, version: 3, title: 'Synthetic dolphin8642', body: 'Updated support window' });
    expect((await request('/search', { query: 'whale4317' })).body).toEqual([]);
    expect((await request('/search', { query: 'dolphin8642' })).body).toMatchObject([{ id, version: 3 }]);
    expect((await request('/toggle', { id, version: 3, enabled: false, update: 'disable' })).status).toBe(200);
    expect((await request('/search', { query: 'dolphin8642' })).body).toEqual([]);
    expect((await request('/toggle', { id, version: 4, enabled: true, update: 'enable' })).status).toBe(200);
    expect((await request('/search', { query: 'dolphin8642' })).body).toMatchObject([{ id, version: 5 }]);
    expect((await request('/delete', { id, version: 5, update: 'delete' })).status).toBe(200);
    expect((await request('/search', { query: 'dolphin8642' })).body).toEqual([]);
    const snapshot = (await request('/snapshot')).body;
    expect(snapshot.entries.filter((row: any) => row.id === id)).toEqual([]);
    expect(snapshot.history.filter((row: any) => row.entry_id === id)).toEqual([
      { entry_id: id, version: 1, action: 'CREATE', source_update_id: 'create' },
      { entry_id: id, version: 2, action: 'UPDATE', source_update_id: 'edit-body' },
      { entry_id: id, version: 3, action: 'UPDATE', source_update_id: 'edit-title' },
      { entry_id: id, version: 4, action: 'DISABLE', source_update_id: 'disable' },
      { entry_id: id, version: 5, action: 'ENABLE', source_update_id: 'enable' },
      { entry_id: id, version: 6, action: 'DELETE', source_update_id: 'delete' }
    ]);
  });

  it('allows one concurrent CAS winner and rejects stale edit/delete without losing history or the current entry', async () => {
    const created = await request('/create', { title: 'Synthetic CAS policy', body: 'Original body', update: 'race-create' });
    const id = created.body.id;
    const contenders = await Promise.all(['A', 'B'].map(value => request('/update', {
      id, version: 1, title: 'Synthetic CAS policy', body: `Winner ${value}`, update: `race-${value}`
    })));
    expect(contenders.map(result => result.status).sort()).toEqual([200, 409]);
    expect(contenders.find(result => result.status === 409)?.body).toEqual({ error: 'KNOWLEDGE_VERSION_CONFLICT' });
    expect(await request('/lost-cas-history', { id })).toEqual({ status: 200, body: [[], []] });
    expect((await request('/delete', { id, version: 1, update: 'stale-delete' }))).toEqual({
      status: 409, body: { error: 'KNOWLEDGE_VERSION_CONFLICT' }
    });
    const snapshot = (await request('/snapshot')).body;
    expect(snapshot.entries.find((row: any) => row.id === id)).toMatchObject({ version: 2 });
    const history = snapshot.history.filter((row: any) => row.entry_id === id);
    expect(history).toHaveLength(2);
    expect(history[1].source_update_id).toMatch(/^race-[AB]$/);
  });
});
