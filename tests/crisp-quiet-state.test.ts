import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCrispHumanReply } from '../src/core/crisp-quiet';
import { processCrispEvent } from '../src/queue/crisp-handler';
import { applyTelegramOperatorAction, checkAutoResume } from '../src/core/ai-state';
import { customerNotificationMode } from '../src/config/telegram-customer-ux';
import { SqliteD1 } from './helpers/sqlite-d1';
import { processAttachmentTransfer } from '../src/attachments/handler';

const NOW = 1792000000;

function seed(db: SqliteD1, id: string, session: string, thread = '77') {
  db.exec(`INSERT INTO conversations
    (id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref, customer_ref,
     operator_channel, operator_thread_ref, created_at, updated_at)
    VALUES ('${id}', 'crisp', 'website-a', '${session}', 'visitor-a', 'telegram', '${thread}', 1, 1)`);
}

function event(ref: string, actorRole: 'CUSTOMER' | 'OPERATOR', timestamp = NOW * 1000, extras: object = {}) {
  return {
    version: 1 as const, source: 'crisp' as const, type: 'message_created' as const,
    eventId: `crisp:event:${ref}`,
    payload: { websiteRef: 'website-a', sessionRef: 'session-a', customerRef: 'visitor-a',
      messageRef: ref, actorRole, content: `text-${ref}`, providerTimestamp: timestamp, ...extras }
  };
}

describe('durable independent Crisp human notification clock', () => {
  let db: SqliteD1;
  let env: any;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    db = new SqliteD1();
    db.migrateThroughHumanLearning();
    seed(db, 'conv-a', 'session-a');
    env = { DB: db, QUEUE: { send: vi.fn() }, BOT_GROUP_ID: '-10099',
      TELEGRAM_BOT_TOKEN: 'synthetic-token', ATTACHMENTS_BUCKET: {}, DLQ_QUARANTINE: {} };
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const clock = (database: SqliteD1, id = 'conv-a') => database.prepare(
    'SELECT last_crisp_human_reply_at FROM conversations WHERE id = ?'
  ).bind(id).first<{ last_crisp_human_reply_at: number | null }>();

  it('adds nullable state without backfilling or changing historical AI state and Topic mapping', async () => {
    expect(await db.prepare('SELECT last_crisp_human_reply_at, ai_mode, operator_thread_ref FROM conversations WHERE id = ?')
      .bind('conv-a').first()).toEqual({ last_crisp_human_reply_at: null, ai_mode: 'ENABLED', operator_thread_ref: '77' });
  });

  it('freezes original message time across duplicate deliveries with changed metadata', async () => {
    await recordCrispHumanReply(env, 'conv-a', 'human-1', (NOW - 30) * 1000);
    vi.setSystemTime((NOW + 300) * 1000);
    await recordCrispHumanReply(env, 'conv-a', 'human-1', (NOW + 300) * 1000);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: NOW - 30 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crisp_human_reply_receipts').first()).toEqual({ count: 1 });
  });

  it('converges concurrent and out-of-order distinct replies to the newest original time', async () => {
    await Promise.all([
      recordCrispHumanReply(env, 'conv-a', 'newer', (NOW - 2) * 1000),
      recordCrispHumanReply(env, 'conv-a', 'older', (NOW - 200) * 1000)
    ]);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: NOW - 2 });
  });

  it('accepts small clock skew once without refreshing a duplicate during later processing', async () => {
    await recordCrispHumanReply(env, 'conv-a', 'skew', NOW * 1000 + 200);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: NOW });
    vi.setSystemTime((NOW + 30) * 1000);
    await recordCrispHumanReply(env, 'conv-a', 'skew', (NOW + 30) * 1000 + 5000);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: NOW });
  });

  it('does not revive an old reply when delivered by a fresh webhook today', async () => {
    await recordCrispHumanReply(env, 'conv-a', 'old-import', (NOW - 86400) * 1000);
    const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind('conv-a').first<any>();
    expect(customerNotificationMode(env, conversation)).toBe('normal');
  });

  it('does not reinterpret a historical canonical message as a new human reply', async () => {
    db.exec(`INSERT INTO messages (id,conversation_id,provider,provider_message_ref,direction,actor_role,message_type,text_content,created_at)
      VALUES ('old-msg','conv-a','crisp','old-fingerprint','OUTBOUND','OPERATOR','TEXT','historical',1)`);
    await recordCrispHumanReply(env, 'conv-a', 'old-fingerprint', NOW * 1000);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: null });
  });

  it('does not later upgrade the time of an invalid future observation on replay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordCrispHumanReply(env, 'conv-a', 'future', (NOW + 120) * 1000);
    await recordCrispHumanReply(env, 'conv-a', 'future', NOW * 1000);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: null });
  });

  it('freezes missing original time even for media-only replies replayed with new metadata', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordCrispHumanReply(env, 'conv-a', 'missing-media', undefined);
    await recordCrispHumanReply(env, 'conv-a', 'missing-media', NOW * 1000);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: null });
    expect(await db.prepare('SELECT reply_at FROM crisp_human_reply_receipts WHERE provider_message_ref=?')
      .bind('missing-media').first()).toEqual({ reply_at: null });
  });

  it('does not reinterpret historical media without a canonical text message on upgrade', async () => {
    db.exec(`INSERT INTO attachments (id,conversation_id,source_provider,source_message_ref,source_attachment_ref,
      attachment_type,original_filename,safe_filename,mime_type,storage_key,access_token_hash,status,
      destination_provider,created_at,updated_at)
      VALUES('old-media','conv-a','crisp','old-media-fp','old-src','photo','old.png','old.png','image/png',
      'old-key','old-hash','DELIVERED','telegram',1,1)`);
    await recordCrispHumanReply(env, 'conv-a', 'old-media-fp', NOW * 1000);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: null });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crisp_human_reply_receipts').first()).toEqual({ count: 0 });
  });

  it.each(['photo', 'document'] as const)('keeps quiet %s discovery frozen until its multipart send after expiry', async type => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 501 } }));
    await recordCrispHumanReply(env, 'conv-a', 'human-media', NOW * 1000);
    await processCrispEvent(event(`customer-${type}`, 'CUSTOMER', NOW * 1000, { content: '', attachments: [{
      sourceAttachmentRef: `src-${type}`, attachmentType: type,
      originalFilename: type === 'photo' ? 'small.png' : 'small.txt', mimeType: type === 'photo' ? 'image/png' : 'text/plain',
      sizeBytes: 3, locator: { provider: 'crisp', dataUrl: 'https://storage.crisp.chat/synthetic' }
    }] }), env);
    const job = env.QUEUE.send.mock.calls[0][0];
    const row = await db.prepare('SELECT id,request_options_json FROM attachments WHERE id=?').bind(job.payload.attachmentId).first<any>();
    expect(JSON.parse(row.request_options_json).disableNotification).toBe(true);
    db.exec(`UPDATE attachments SET status='STORED',size_bytes=3 WHERE id='${row.id}'`);
    env.ATTACHMENTS_BUCKET = { get: vi.fn().mockResolvedValue({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) };
    vi.setSystemTime((NOW + 901) * 1000);
    await processAttachmentTransfer(job, env);
    expect(String(fetchMock.mock.calls[0][0])).toContain(type === 'photo' ? '/sendPhoto' : '/sendDocument');
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get('disable_notification')).toBe('true');
    expect(form.get('message_thread_id')).toBe('77');
    expect(await db.prepare('SELECT status FROM attachments WHERE id=?').bind(row.id).first()).toEqual({ status: 'DELIVERED' });
    expect(JSON.parse((await db.prepare('SELECT request_options_json FROM outbound_operations WHERE subject_ref=?').bind(row.id).first<any>()).request_options_json).disableNotification).toBe(true);
  });

  it('isolates clocks between conversations', async () => {
    seed(db, 'conv-b', 'session-b', '78');
    await recordCrispHumanReply(env, 'conv-a', 'human-a', NOW * 1000);
    expect(await clock(db, 'conv-b')).toEqual({ last_crisp_human_reply_at: null });
  });

  it('records genuine human replies before mirroring and preserves silent human provenance', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 501 } }));
    await processCrispEvent(event('human', 'OPERATOR', (NOW - 5) * 1000), env);
    const row = await db.prepare('SELECT last_crisp_human_reply_at, last_operator_reply_at, ai_mode FROM conversations WHERE id = ?')
      .bind('conv-a').first<any>();
    expect(row).toEqual({ last_crisp_human_reply_at: NOW - 5, last_operator_reply_at: NOW, ai_mode: 'PAUSED_OPERATOR' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      disable_notification: true, text: '👤 Crisp 人工客服 → 用户\n\ntext-human'
    });
  });

  it('never starts the clock for automation, customer messages, or gateway self echoes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 501 } }));
    await processCrispEvent(event('auto', 'OPERATOR', NOW * 1000, { automated: true }), env);
    await processCrispEvent(event('customer', 'CUSTOMER'), env);
    db.exec(`INSERT INTO outbound_operations (id,conversation_id,destination_provider,operation_type,status,provider_message_ref,created_at,updated_at)
      VALUES ('send_crisp_echo','conv-a','crisp','SEND_MESSAGE','SENT','echo-ref',1,1)`);
    await processCrispEvent(event('echo-ref', 'OPERATOR'), env);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: null });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crisp_human_reply_receipts').first()).toEqual({ count: 0 });
  });

  it('continues legacy human bridging without inventing a timestamp for old queued events', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 501 } }));
    await processCrispEvent(event('legacy', 'OPERATOR', NOW * 1000, { providerTimestamp: undefined }), env);
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: null });
    expect(await db.prepare("SELECT status FROM outbound_operations WHERE id = 'send_tg_crisp_legacy'").first()).toEqual({ status: 'SENT' });
  });

  it('keeps notification time independent through Telegram reply, manual AI off/on, and AI auto-resume', async () => {
    await recordCrispHumanReply(env, 'conv-a', 'human', NOW * 1000);
    await applyTelegramOperatorAction(env, 'conv-a', 0, '1', 'HUMAN_REPLY');
    await applyTelegramOperatorAction(env, 'conv-a', 0, '2', 'AI_OFF');
    await applyTelegramOperatorAction(env, 'conv-a', 0, '3', 'AI_ON');
    expect(await clock(db)).toEqual({ last_crisp_human_reply_at: NOW });
    db.exec(`UPDATE conversations SET ai_mode='PAUSED_OPERATOR', ai_pause_source='CRISP_OPERATOR',last_operator_reply_at=${NOW - 3601}`);
    const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind('conv-a').first<any>();
    await checkAutoResume(env, conversation);
    const resumed = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind('conv-a').first<any>();
    expect(resumed.ai_mode).toBe('ENABLED');
    expect(customerNotificationMode(env, resumed)).toBe('silent');
  });

  it('freezes a retry notification across window expiry while new messages return to normal', async () => {
    await recordCrispHumanReply(env, 'conv-a', 'human', (NOW - 30) * 1000);
    env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS = '86400';
    db.exec("UPDATE conversations SET ai_mode='PAUSED_OPERATOR', ai_pause_source='CRISP_OPERATOR'");
    let first = true;
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (first) { first = false; return Response.json({ ok: false }, { status: 429, headers: { 'Retry-After': '1' } }); }
      return Response.json({ ok: true, result: { message_id: bodies.length } });
    });
    await expect(processCrispEvent(event('retry', 'CUSTOMER'), env)).rejects.toThrow();
    vi.setSystemTime((NOW + 1000) * 1000);
    await processCrispEvent(event('retry', 'CUSTOMER'), env);
    await processCrispEvent(event('fresh', 'CUSTOMER'), env);
    expect(bodies.map(body => body.disable_notification === true)).toEqual([true, true, false]);
  });
});
