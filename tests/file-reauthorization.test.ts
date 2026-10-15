import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdminTelegramWebhook } from '../src/admin/handler';
import { ensureAttachmentGrant } from '../src/attachments/grants';
import { handleAttachmentProxy } from '../src/attachments/proxy';
import { AttachmentRow } from '../src/core/attachments';
import { getAttachmentConfig } from '../src/config/attachments';
import { setPlainOverride } from '../src/runtime-config/service';
import { saveAdminSession } from '../src/runtime-config/repository';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { sendConversationFiles } from '../src/uploads/service';
import { SqliteD1 } from './helpers/sqlite-d1';
import { masterKey } from './helpers/runtime-db';

const ORIGIN = 'https://files.synthetic.example';
const SECRET = 'A'.repeat(43);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const adminPath = 'p'.repeat(43);
const adminSecret = 's'.repeat(43);
const conversation = { id: 'conv', helpdesk_provider: 'crisp', helpdesk_account_ref: 'site',
  helpdesk_conversation_ref: 'session', operator_thread_ref: '77', operator_thread_status: 'OPEN' };

describe('retained file reauthorization and retired product controls', () => {
  let db: SqliteD1;
  let env: any;
  let telegram: any[];
  const clock = 1792000000000;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock);
    db = new SqliteD1(); db.migrate(); telegram = [];
    env = { DB: db, PUBLIC_ORIGIN: ORIGIN, BOT_GROUP_ID: '-100',
      TELEGRAM_BOT_TOKEN: '123456:synthetic-support-token', UPLOAD_CAPABILITY_SECRET: SECRET,
      RUNTIME_CONFIG_MASTER_KEY: masterKey(), ADMIN_TELEGRAM_BOT_TOKEN: '999999:synthetic-admin-token',
      ADMIN_TELEGRAM_SECRET_PATH: adminPath, ADMIN_TELEGRAM_WEBHOOK_SECRET: adminSecret,
      ADMIN_TELEGRAM_USER_IDS: '1001' };
    await db.prepare(`INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,
      customer_ref,operator_channel,operator_thread_ref,created_at,updated_at)
      VALUES('conv','crisp','site','session','synthetic','telegram','77',1,1)`).run();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/api\.telegram\.org\/bot(?:123456|999999):/);
      if (String(url).endsWith('/sendMessage')) telegram.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 800 + telegram.length } });
    });
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

  async function file(index: number, options: { expires?: number; image?: boolean; deleted?: boolean; filename?: string } = {}) {
    const id = 'synthetic-file-' + String(index).padStart(3, '0');
    const storedAt = Math.floor(clock / 1000) - index;
    const expiry = options.expires ?? storedAt + (options.image ? 7 * 86400 : 72 * 3600);
    const name = options.filename ?? `${String(index).padStart(2, '0')}-${'合成文件名'.repeat(32)}.txt`;
    await db.prepare(`INSERT INTO attachments(id,conversation_id,source_provider,source_message_ref,source_attachment_ref,
      attachment_type,original_filename,safe_filename,mime_type,size_bytes,storage_key,access_token_hash,status,destination_provider,
      attempt_count,expires_at,created_at,updated_at,stored_size_bytes,stored_at,retention_class,retention_expires_at,sha256,
      transfer_version,deleted_at)
      VALUES(?,'conv','upload',?,?,'document',?,?,?,4,?,?,'STORED','telegram',0,?,?,?,?,?,?,?,?,2,?)`)
      .bind(id, id, id, name, name, options.image ? 'image/png' : 'text/plain', 'attachments-v2/' + id,
        sha256(id), expiry, storedAt, storedAt, 4, storedAt, options.image ? 'IMAGE' : 'FILE', expiry,
        sha256('data'), options.deleted ? storedAt : null).run();
    return (await db.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first<AttachmentRow>())!;
  }

  const command = (updateRef: string, offset = 0) => ({ supportProfileVersion: 0, updateRef, operatorRef: '1001',
    threadRef: '77', publicOrigin: 'https://malicious-request-host.example', offset });
  async function admin(update: number, text: string, callback = true) {
    return handleAdminTelegramWebhook(new Request(`https://synthetic.example/webhooks/admin-telegram/${adminPath}`, {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': adminSecret },
      body: JSON.stringify(callback ? { update_id: update,
        callback_query: { id: 'callback-' + update, data: text, from: { id: 1001 }, message: { chat: { id: 1001, type: 'private' } } } }
        : { update_id: update, message: { message_id: update, text, from: { id: 1001 }, chat: { id: 1001, type: 'private' } } })
    }), env);
  }

  it('represents every requested file across long-name message batches and the 31st-file continuation without duplicate SENT sends', async () => {
    const files: AttachmentRow[] = [];
    for (let i = 0; i < 31; i++) files.push(await file(i));
    await sendConversationFiles(env, conversation, command('100'));
    const first = telegram.map(body => body.text).join('\n');
    expect(telegram.length).toBeGreaterThan(1);
    expect(telegram.every(body => body.text.length > 0 && body.text.length <= 4096)).toBe(true);
    for (const row of files.slice(0, 30)) expect(first.split(row.safe_filename)).toHaveLength(2);
    expect(first).not.toContain(files[30].safe_filename);
    expect(first).toContain('/files 30');
    expect(first).not.toContain('malicious-request-host');
    const urls = first.match(/https:\/\/[^\s]+/g)!;
    expect(urls).toHaveLength(30);
    expect(urls.every((url: string) => url.startsWith(ORIGIN + '/attachments/'))).toBe(true);
    const sentCount = telegram.length;
    await sendConversationFiles(env, conversation, command('100'));
    expect(telegram).toHaveLength(sentCount);
    const operations = await db.prepare("SELECT status,attempt_count FROM outbound_operations WHERE id LIKE 'files_ack:0:100:%'").all<any>();
    expect(operations.results).toHaveLength(sentCount);
    expect(operations.results.every(row => row.status === 'SENT' && row.attempt_count === 1)).toBe(true);
    await sendConversationFiles(env, conversation, command('101', 30));
    const continuation = telegram.slice(sentCount).map(body => body.text).join('\n');
    expect(continuation).toContain(files[30].safe_filename);
    expect(continuation).not.toContain('/files 60');
    expect(telegram.every(body => body.text.length <= 4096)).toBe(true);
    expect((first + '\n' + continuation).match(/https:\/\/[^\s]+/g)).toHaveLength(31);
  });

  it('renews an expired grant for the remaining retention window without extending file or image expiry', async () => {
    for (const image of [false, true]) {
      const row = await file(image ? 41 : 40, { image });
      const first = await ensureAttachmentGrant(env, row);
      await db.prepare('UPDATE attachment_access_grants SET expires_at=? WHERE attachment_id=?')
        .bind(Math.floor(clock / 1000) - 1, row.id).run();
      vi.setSystemTime(clock + 3600000);
      const current = (await db.prepare('SELECT * FROM attachments WHERE id=?').bind(row.id).first<AttachmentRow>())!;
      const renewed = await ensureAttachmentGrant(env, current);
      expect(renewed.token).not.toBe(first.token);
      expect(renewed.expiresAt).toBe(row.retention_expires_at);
      expect(renewed.url.startsWith(ORIGIN + '/attachments/')).toBe(true);
      expect(renewed.url.endsWith(image ? '/inline' : '/download')).toBe(true);
      const grants = await db.prepare('SELECT generation,expires_at FROM attachment_access_grants WHERE attachment_id=? ORDER BY generation')
        .bind(row.id).all<any>();
      expect(grants.results.map(grant => grant.generation)).toEqual([1, 2]);
      expect(grants.results[1].expires_at).toBe(row.retention_expires_at);
      const after = await db.prepare('SELECT stored_at,retention_expires_at FROM attachments WHERE id=?').bind(row.id).first();
      expect(after).toEqual({ stored_at: row.stored_at, retention_expires_at: row.retention_expires_at });
      const bucket = { head: async () => ({ size: 4 }), get: async () => ({ body: new Blob(['data']).stream() }) };
      env.ATTACHMENTS_BUCKET = bucket;
      expect((await handleAttachmentProxy(new Request(first.url), env, first.token, image ? 'inline' : 'download')).status).toBe(404);
      expect((await handleAttachmentProxy(new Request(renewed.url), env, renewed.token, image ? 'inline' : 'download')).status).toBe(200);
      vi.setSystemTime(row.retention_expires_at! * 1000);
      expect((await handleAttachmentProxy(new Request(renewed.url), env, renewed.token, image ? 'inline' : 'download')).status).toBe(404);
      await expect(ensureAttachmentGrant(env, row, true)).rejects.toThrow('ATTACHMENT_EXPIRED');
      vi.setSystemTime(clock);
    }
  });

  it('omits expired and physically deleted files while issuing a new authorization for retained stored bytes', async () => {
    const retained = await file(50);
    await file(51, { expires: Math.floor(clock / 1000) });
    await file(52, { deleted: true });
    await sendConversationFiles(env, conversation, command('200'));
    expect(telegram).toHaveLength(1);
    expect(telegram[0].text).toContain(retained.safe_filename);
    expect(telegram[0].text).not.toContain('51-');
    expect(telegram[0].text).not.toContain('52-');
    expect((await db.prepare('SELECT COUNT(*) AS count FROM attachment_access_grants').first())).toEqual({ count: 1 });
  });

  it.each([
    ['fb', 'ATTACHMENT_MAX_BYTES', '1024'],
    ['fc', 'ATTACHMENT_MAX_COUNT_PER_MESSAGE', '3'],
    ['ft', 'ATTACHMENT_TTL_SECONDS', '3600']
  ])('retains %s historical value and history while its retired edit callback cannot save another value', async (code, key, value) => {
    await setPlainOverride(env, key as any, value, 0, 'synthetic-admin', 'legacy');
    const before = await db.prepare('SELECT * FROM runtime_config_history ORDER BY id').all();
    await admin(300, 'e:' + code);
    await admin(301, '60', false);
    expect(await db.prepare('SELECT value_text,version FROM runtime_config WHERE key=?').bind(key).first()).toEqual({ value_text: value, version: 1 });
    expect((await db.prepare('SELECT * FROM runtime_config_history ORDER BY id').all()).results).toEqual(before.results);
    const config = getAttachmentConfig(await resolveEffectiveEnv(env));
    expect(config.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.maxCountPerMessage).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.fileTtlSeconds).toBe(72 * 3600);
    expect(config.imageTtlSeconds).toBe(7 * 86400);
    expect(telegram.some(body => body.text.includes('已停用'))).toBe(true);
  });

  it('does not let an input session created by the previous runtime write a retired unified TTL after its legacy edit button is rejected', async () => {
    await setPlainOverride(env, 'ATTACHMENT_TTL_SECONDS', '3600', 0, 'synthetic-admin', 'old-setting');
    await saveAdminSession(env, { admin_user_id: '1001', action: 'SET', target: 'ATTACHMENT_TTL_SECONDS',
      expected_version: 1, candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null, context_json: null });
    await admin(400, 'e:ft');
    await admin(401, '60', false);
    expect(await db.prepare("SELECT value_text,version FROM runtime_config WHERE key='ATTACHMENT_TTL_SECONDS'").first())
      .toEqual({ value_text: '3600', version: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM runtime_config_history WHERE key='ATTACHMENT_TTL_SECONDS'").first())
      .toEqual({ count: 1 });
  });
});
