import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestFixedLengthStream } from './fixtures/fixed-length-stream';
import { SqliteD1 } from './helpers/sqlite-d1';
import { buildTelegramTargetEvidence } from '../src/core/outbound-evidence';
import { manualRetryOutboundOperation } from '../src/core/outbound-manual-retry';

const databases: SqliteD1[] = [];
beforeEach(() => vi.stubGlobal('FixedLengthStream', TestFixedLengthStream));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });

async function setup(size: number, method = 'sendDocument') {
  const db = new SqliteD1(); db.migrate(); databases.push(db);
  db.exec("INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,operator_thread_ref,created_at,updated_at) VALUES('conv','crisp','website','session','synthetic','telegram','77',1,1)");
  await db.prepare(`INSERT INTO attachments(id,conversation_id,source_provider,source_message_ref,source_attachment_ref,attachment_type,
    original_filename,safe_filename,mime_type,size_bytes,stored_size_bytes,storage_key,access_token_hash,status,destination_provider,
    attempt_count,expires_at,retention_expires_at,created_at,updated_at,transfer_version)
    VALUES('att','conv','crisp','source','file','document','large.bin','large.bin','application/octet-stream',NULL,?,
    'attachments-v2/att','hash','STORED','telegram',1,9999999999,9999999999,1,1,2)`).bind(size).run();
  const buffer = vi.fn(() => { throw new Error('whole file buffering forbidden'); });
  const env = { DB: db, BOT_GROUP_ID: '-1001', TELEGRAM_BOT_TOKEN: 'synthetic-token', ATTACHMENTS_BUCKET: {
    get: vi.fn(async () => {
      let remaining = size;
      return { size, arrayBuffer: buffer, body: new ReadableStream<Uint8Array>({ pull(controller) {
        if (!remaining) { controller.close(); return; }
        const chunk = new Uint8Array(Math.min(remaining, 1024 * 1024)); remaining -= chunk.length; controller.enqueue(chunk);
      } }) };
    })
  } } as any;
  const target = buildTelegramTargetEvidence(env, '-1001', '77', method as any);
  await db.prepare(`INSERT INTO outbound_operations(id,conversation_id,destination_provider,operation_type,status,attempt_count,
    request_started_at,reconciliation_status,subject_type,subject_ref,target_evidence_json,created_at,updated_at)
    VALUES('parent','conv','telegram','SEND_ATTACHMENT','AMBIGUOUS',1,1,'PENDING','ATTACHMENT','att',?,1,1)`)
    .bind(JSON.stringify(target)).run();
  return { db, env, buffer };
}

describe('large attachment manual retry', () => {
  it('streams a 30 MiB attachment through one deterministic child without whole-file buffering', async () => {
    const item = await setup(30 * 1024 * 1024);
    let read = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      while (true) { const chunk = await reader.read(); if (chunk.done) break; read += chunk.value.length; }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 90 } }), { status: 200 });
    });
    const result = await manualRetryOutboundOperation(item.env, 'parent', { type: 'ADMIN', ref: 'synthetic-admin' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK');
    expect(result.childStatus).toBe('SENT');
    expect(read).toBeGreaterThan(30 * 1024 * 1024);
    expect(item.buffer).not.toHaveBeenCalled();
    await manualRetryOutboundOperation(item.env, 'parent', { type: 'ADMIN', ref: 'synthetic-admin' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await item.db.prepare("SELECT status,reconciliation_status FROM outbound_operations WHERE id='parent'").first()).toEqual({ status: 'AMBIGUOUS', reconciliation_status: 'MANUAL_RETRY_CREATED' });
  });

  it('does not change a historical native-send method into a download-link send', async () => {
    const item = await setup(60 * 1024 * 1024, 'sendDocument');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(manualRetryOutboundOperation(item.env, 'parent', { type: 'ADMIN', ref: 'synthetic-admin' }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK'))
      .rejects.toMatchObject({ code: 'OUTBOUND_MANUAL_RETRY_TARGET_CHANGED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await item.db.prepare("SELECT COUNT(*) AS count FROM outbound_operations WHERE parent_operation_id='parent'").first()).toEqual({ count: 0 });
  });
});
