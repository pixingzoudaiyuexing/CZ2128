import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const configPath = 'tests/fixtures/wrangler.dlq-harness.toml';
const privateSentinels = [
  'PRIVATE_DLQ_MESSAGE_BODY_123',
  'SUPER_SECRET_DLQ_TOKEN_456',
  'PRIVATE_CHATWOOT_URL_789',
  'PRIVATE_ATTACHMENT_ACCESS_TOKEN_ABC',
  'PRIVATE_AI_TEXT_DEF'
];

function validEvent(eventId: string) {
  return {
    version: 1,
    source: 'chatwoot',
    type: 'message_created',
    eventId,
    payload: {
      accountRef: 'account-1',
      conversationRef: 'conversation-1',
      content: privateSentinels[0],
      token: privateSentinels[1],
      privateUrl: privateSentinels[2],
      accessToken: privateSentinels[3],
      aiText: privateSentinels[4]
    }
  };
}

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

describe('real local D1/R2 DLQ service behavior', () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'cz2128-dlq-harness-'));
  let child: ChildProcess;
  let baseUrl: string;
  let output = '';

  async function request(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text}`);
    return JSON.parse(text);
  }

  beforeAll(async () => {
    execFileSync('npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir,
      '--config', configPath
    ], { stdio: 'pipe', env: { ...process.env, CI: '1' } });
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
  }, 60_000);

  beforeEach(async () => {
    await request('/reset', {});
    await request('/seed-conversation', {});
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(persistDir, { recursive: true, force: true });
  });

  it('runs two complete concurrent captureDlqMessage calls against one real D1 binding', async () => {
    const event = validEvent('concurrent-event');
    const [first, second] = await Promise.all([
      request('/capture', { id: 'cf-a', body: event, now: 100 }),
      request('/capture', { id: 'cf-b', body: event, now: 200 })
    ]);
    expect(first.id).toBe(second.id);
    const snapshot = await request('/snapshot');
    expect(snapshot.dlq).toHaveLength(1);
    expect(snapshot.dlq[0]).toMatchObject({
      id: first.id,
      status: 'OPEN',
      delivery_count: 2,
      last_seen_at: 200
    });
    expect([100, 200]).toContain(snapshot.dlq[0].first_seen_at);
    const durable = JSON.stringify(snapshot.dlq);
    for (const sentinel of privateSentinels) expect(durable).not.toContain(sentinel);
  }, 30_000);

  it('records RESOLVED when canonical PROCESSED commits before capture', async () => {
    await request('/seed-event', {
      source: 'chatwoot', eventId: 'processed-first', status: 'PROCESSED', now: 90
    });
    await request('/capture', { id: 'cf-processed-first', body: validEvent('processed-first'), now: 100 });
    const snapshot = await request('/snapshot');
    expect(snapshot.dlq[0]).toMatchObject({ status: 'RESOLVED', resolved_at: 100 });
  });

  it('canonical completion converges an existing OPEN receipt to RESOLVED', async () => {
    await request('/seed-event', {
      source: 'chatwoot', eventId: 'capture-first', status: 'PROCESSING', claimToken: 'claim-1'
    });
    await request('/capture', { id: 'cf-capture-first', body: validEvent('capture-first'), now: 100 });
    expect((await request('/snapshot')).dlq[0].status).toBe('OPEN');
    expect(await request('/complete', {
      source: 'chatwoot', eventId: 'capture-first', claimToken: 'claim-1', now: 200
    })).toEqual({ completed: true });
    expect((await request('/snapshot')).dlq[0]).toMatchObject({ status: 'RESOLVED', resolved_at: 200 });
  });

  it('concurrent capture and canonical completion converge to RESOLVED', async () => {
    await request('/seed-event', {
      source: 'chatwoot', eventId: 'interleaved', status: 'PROCESSING', claimToken: 'claim-2'
    });
    await Promise.all([
      request('/capture', { id: 'cf-interleaved', body: validEvent('interleaved'), now: 300 }),
      request('/complete', {
        source: 'chatwoot', eventId: 'interleaved', claimToken: 'claim-2', now: 400
      })
    ]);
    const snapshot = await request('/snapshot');
    expect(snapshot.events[0].status).toBe('PROCESSED');
    expect(snapshot.dlq[0].status).toBe('RESOLVED');
    expect(snapshot.dlq[0].resolved_at).not.toBeNull();
  });

  it('uses deterministic sanitized R2 quarantine objects with no raw payload', async () => {
    const input = {
      id: 'cf-quarantine', body: validEvent('quarantine-event'), attempts: 4, timestamp: 500
    };
    const first = await request('/quarantine', input);
    const second = await request('/quarantine', input);
    expect(second.quarantineId).toBe(first.quarantineId);
    const snapshot = await request('/snapshot');
    expect(snapshot.quarantine.visibleCount).toBe(1);
    expect(snapshot.quarantine.entries[0]).toMatchObject({
      quarantineId: first.quarantineId,
      eventSource: 'chatwoot',
      eventType: 'message_created',
      queueAttempts: 4,
      messageTimestamp: 500,
      reason: 'D1_DLQ_RECEIPT_PERSIST_FAILED',
      state: 'QUARANTINED'
    });
    const durable = JSON.stringify(snapshot);
    for (const sentinel of privateSentinels) expect(durable).not.toContain(sentinel);
  });

  it('quarantines malformed bodies using only trusted Queue metadata', async () => {
    const receipt = await request('/quarantine', {
      id: 'cf-malformed', body: { arbitrary: privateSentinels.join('|') }, attempts: 3, timestamp: 600
    });
    const snapshot = await request('/snapshot');
    expect(snapshot.quarantine.entries[0]).toMatchObject({
      quarantineId: receipt.quarantineId,
      eventSource: null,
      eventType: null,
      queueAttempts: 3,
      messageTimestamp: 600
    });
    for (const sentinel of privateSentinels) expect(JSON.stringify(snapshot)).not.toContain(sentinel);
  });

  it('deduplicates two complete concurrent same-command redrive requests on real D1', async () => {
    const seeded = await request('/seed-ai-redrive', {});
    const eligibility = await request('/redrive-eligibility', { now: 1_800_000_000 });
    expect(eligibility).toMatchObject({
      eligible: true,
      event: {
        eventId: seeded.eventId,
        payload: { convId: 'conv-redrive', messageId: 'message-redrive' }
      }
    });

    const results = await Promise.all([
      request('/redrive-request', { commandId: '7001', now: 1_800_000_000 }),
      request('/redrive-request', { commandId: '7001', now: 1_800_000_000 })
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['ALREADY_REQUESTED', 'ENQUEUED']);
    const snapshot = await request('/snapshot');
    expect(snapshot.audits).toHaveLength(1);
    expect(snapshot.audits[0]).toMatchObject({
      entity_type: 'DLQ_RECEIPT',
      entity_id: seeded.receiptId,
      action: 'DLQ_REDRIVE_REQUESTED',
      reason_code: 'OPERATOR_REQUESTED_REDRIVE'
    });
    expect(snapshot.redriveQueueBodies).toHaveLength(1);
    expect(snapshot.redriveQueueBodies[0].eventId).toBe(seeded.eventId);
  }, 30_000);

  it('allows distinct commands to enqueue the exact same logical event on real D1', async () => {
    const seeded = await request('/seed-ai-redrive', {});
    await request('/redrive-request', { commandId: '7101', now: 1_800_000_000 });
    await request('/redrive-request', { commandId: '7102', now: 1_800_000_000 });
    const snapshot = await request('/snapshot');
    expect(snapshot.audits).toHaveLength(2);
    expect(snapshot.redriveQueueBodies).toHaveLength(2);
    expect(snapshot.redriveQueueBodies[1]).toEqual(snapshot.redriveQueueBodies[0]);
    expect(snapshot.redriveQueueBodies[0].eventId).toBe(seeded.eventId);
  });

  it('blocks the Primary handoff race in the real processing service path', async () => {
    await request('/seed-ai-redrive', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 }))
      .toMatchObject({ eligible: true });
    await request('/advance-handoff', {});
    await request('/process-redrive', {});
    const snapshot = await request('/snapshot');
    expect(snapshot.runs[0]).toMatchObject({
      status: 'CANCELLED_BY_HANDOFF',
      handoff_epoch: 0,
      attempt_count: 1
    });
    expect(snapshot.outbound[0]).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'CANCELLED_BY_HANDOFF'
    });
    expect(snapshot.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity_id: snapshot.outbound[0].id,
        action: 'AI_HANDOFF_CANCELLED',
        reason_code: 'CANCELLED_BY_HANDOFF'
      })
    ]));
    expect(snapshot.dlq[0].status).toBe('RESOLVED');
    expect(snapshot.redriveQueueBodies).toHaveLength(0);
  });

  it('blocks real-D1 redrive eligibility when historical Chatwoot evidence is missing', async () => {
    await request('/seed-ai-redrive', {});
    await request('/delete-redrive-chatwoot-operation', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 })).toMatchObject({
      eligible: false,
      reason: 'OUTBOUND_EVIDENCE_MISSING'
    });
  });

  it('rechecks prepared Chatwoot target evidence before a real-D1 retry generation', async () => {
    await request('/seed-ai-redrive', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 }))
      .toMatchObject({ eligible: true });
    expect(await request('/process-redrive', {
      chatwootApiUrl: 'https://changed-chatwoot.example/api/v1'
    })).toEqual({ ok: false, error: 'OUTBOUND_PRECONDITION_FAILED' });
    const snapshot = await request('/snapshot');
    expect(snapshot.runs[0]).toMatchObject({ attempt_count: 1, status: 'PENDING' });
    expect(snapshot.outbound[0]).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'TARGET_IDENTITY_CHANGED'
    });
  });

  it('rechecks latest customer text in the real-D1 processing path', async () => {
    await request('/seed-ai-redrive', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 }))
      .toMatchObject({ eligible: true });
    await request('/seed-newer-customer', {});
    expect(await request('/process-redrive', {})).toEqual({ ok: true });
    const snapshot = await request('/snapshot');
    expect(snapshot.runs[0]).toMatchObject({
      status: 'DISCARDED_STALE',
      attempt_count: 1
    });
    expect(snapshot.outbound[0]).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'DISCARDED_STALE'
    });
    expect(snapshot.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity_id: snapshot.outbound[0].id,
        action: 'HISTORICAL_AI_STALE_DISCARDED',
        reason_code: 'DISCARDED_STALE'
      })
    ]));
  });

  it('converges real-D1 SENT Chatwoot and PENDING mirror after freshness becomes stale', async () => {
    await request('/seed-ai-redrive', {});
    await request('/seed-success-with-mirror', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 }))
      .toMatchObject({ eligible: true });
    await request('/seed-newer-customer', {});
    expect(await request('/process-redrive', {})).toEqual({ ok: true });
    const snapshot = await request('/snapshot');
    const chatwoot = snapshot.outbound.find((row: any) => row.destination_provider === 'chatwoot');
    const telegram = snapshot.outbound.find((row: any) => row.destination_provider === 'telegram');
    expect(chatwoot).toMatchObject({ status: 'SENT', provider_message_ref: 'chatwoot-sent' });
    expect(telegram).toMatchObject({ status: 'FAILED_FINAL', last_error: 'DISCARDED_STALE' });
    expect(snapshot.messages.filter((row: any) => row.actor_role === 'AI')).toHaveLength(1);
    expect(snapshot.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity_id: telegram.id,
        action: 'HISTORICAL_AI_STALE_DISCARDED',
        reason_code: 'DISCARDED_STALE'
      })
    ]));
  });

  it('deduplicates concurrent real-D1 stale convergence and its audit', async () => {
    await request('/seed-ai-redrive', {});
    const results = await Promise.all([
      request('/converge-stale', {}),
      request('/converge-stale', {})
    ]);
    expect(results.reduce((sum, result) => sum + Number(result.changed), 0)).toBe(1);
    const snapshot = await request('/snapshot');
    expect(snapshot.outbound[0]).toMatchObject({
      status: 'FAILED_FINAL', last_error: 'DISCARDED_STALE'
    });
    expect(snapshot.audits.filter((row: any) =>
      row.action === 'HISTORICAL_AI_STALE_DISCARDED'
    )).toHaveLength(1);
  });

  it('converges real-D1 SENT Chatwoot and PENDING mirror after handoff', async () => {
    await request('/seed-ai-redrive', {});
    await request('/seed-success-with-mirror', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 }))
      .toMatchObject({ eligible: true });
    await request('/advance-handoff', {});
    expect(await request('/process-redrive', {})).toEqual({ ok: true });
    const snapshot = await request('/snapshot');
    const chatwoot = snapshot.outbound.find((row: any) => row.destination_provider === 'chatwoot');
    const telegram = snapshot.outbound.find((row: any) => row.destination_provider === 'telegram');
    expect(snapshot.runs[0].status).toBe('SUCCESS');
    expect(chatwoot).toMatchObject({ status: 'SENT', provider_message_ref: 'chatwoot-sent' });
    expect(telegram).toMatchObject({ status: 'FAILED_FINAL', last_error: 'CANCELLED_BY_HANDOFF' });
    expect(snapshot.messages.filter((row: any) => row.actor_role === 'AI')).toHaveLength(1);
    expect(snapshot.dlq[0].status).toBe('RESOLVED');
  });

  it('allows real-D1 no-send handoff cleanup across conversation mapping drift', async () => {
    await request('/seed-ai-redrive', {});
    const before = await request('/snapshot');
    const historicalEvidence = before.outbound[0].target_evidence_json;
    await request('/change-redrive-conversation-mapping', {});
    await request('/advance-handoff', {});
    expect(await request('/process-redrive', {})).toEqual({ ok: true });
    const snapshot = await request('/snapshot');
    expect(snapshot.outbound[0]).toMatchObject({
      status: 'FAILED_FINAL',
      last_error: 'CANCELLED_BY_HANDOFF',
      target_evidence_json: historicalEvidence
    });
    expect(snapshot.dlq[0].status).toBe('RESOLVED');
  });

  it('fails closed on real-D1 malformed Chatwoot SENT provider evidence', async () => {
    await request('/seed-ai-redrive', {});
    await request('/seed-success-with-mirror', {});
    expect(await request('/redrive-eligibility', { now: 1_800_000_000 }))
      .toMatchObject({ eligible: true });
    await request('/malform-redrive-chatwoot-sent', {});
    await request('/seed-newer-customer', {});
    expect(await request('/process-redrive', {})).toEqual({
      ok: false, error: 'OUTBOUND_PRECONDITION_FAILED'
    });
    const snapshot = await request('/snapshot');
    const chatwoot = snapshot.outbound.find((row: any) => row.destination_provider === 'chatwoot');
    expect(chatwoot).toMatchObject({ status: 'SENT', provider_message_ref: null });
    expect(snapshot.events[0].status).toBe('FAILED');
    expect(snapshot.dlq[0].status).toBe('OPEN');
    expect(snapshot.audits.filter((row: any) =>
      row.action === 'HISTORICAL_AI_STALE_DISCARDED'
    )).toHaveLength(0);
  });
});
