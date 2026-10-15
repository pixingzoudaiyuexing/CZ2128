import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAttachmentConfig } from '../src/config/attachments';
import { telegramCustomerRequestOptions } from '../src/config/telegram-customer-ux';
import * as runtimeCrypto from '../src/runtime-config/crypto';
import { resolveEffectiveEnv, resolveUploadEnv } from '../src/runtime-config/resolver';
import { RuntimeConfigKey, RuntimeConfigRow } from '../src/runtime-config/types';
import { RuntimeDb, masterKey } from './helpers/runtime-db';
import { SqliteD1 } from './helpers/sqlite-d1';
import { handleUploadCapabilityRequest } from '../src/uploads/handler';
import { handleUploadSession } from '../src/uploads/sessions';
import { kickCrispRtm } from '../src/rtm/crisp-rtm';
import Worker from '../src/index';

vi.mock('../src/uploads/handler', () => ({ handleUploadCapabilityRequest: vi.fn() }));
vi.mock('../src/uploads/sessions', () => ({
  handleUploadSession: vi.fn(), cleanupUploadSessions: vi.fn()
}));
vi.mock('../src/attachments/proxy', () => ({
  handleAttachmentProxy: vi.fn().mockResolvedValue(new Response('attachment'))
}));
vi.mock('../src/rtm/crisp-rtm', () => ({
  kickCrispRtm: vi.fn(), CrispRtmBridge: class {}
}));

const UPLOAD_KEYS: RuntimeConfigKey[] = [
  'TELEGRAM_SUPPORT_PROFILE', 'BOT_GROUP_ID',
  'CRISP_OPERATOR_NICKNAME', 'CRISP_OPERATOR_AVATAR_URL',
  'TELEGRAM_CRISP_HUMAN_QUIET_MINUTES', 'TELEGRAM_NOTIFY_TELEGRAM_OPERATOR',
  'TELEGRAM_NOTIFY_MANUAL_OFF', 'ATTACHMENT_FILE_TTL_SECONDS', 'ATTACHMENT_IMAGE_TTL_SECONDS',
  'ATTACHMENT_SOURCE_TIMEOUT_MS', 'ATTACHMENT_DESTINATION_TIMEOUT_MS'
];
const TOKEN = 't'.repeat(43);
function env(db = new RuntimeDb()) {
  return {
    DB: db, RUNTIME_CONFIG_MASTER_KEY: masterKey(),
    TELEGRAM_BOT_TOKEN: 'old-env-token', TELEGRAM_WEBHOOK_SECRET: 'old-env-secret',
    TELEGRAM_SECRET_PATH: 'old-env-path', BOT_GROUP_ID: '-1001',
    CRISP_API_IDENTIFIER: 'bootstrap-crisp-id', CRISP_API_KEY: 'bootstrap-crisp-secret',
    CRISP_WEBSITE_ID: 'site', CRISP_OPERATOR_NICKNAME: 'env operator',
    AI_API_KEY: 'unused-env-ai-secret', CHATWOOT_API_TOKEN: 'unused-env-chatwoot-secret',
    QUEUE: { send: vi.fn() }, CRISP_RTM: {}
  } as any;
}
function plain(key: RuntimeConfigKey, value: string, version = 1): RuntimeConfigRow {
  return { key, value_kind: 'PLAIN', value_text: value, ciphertext: null, nonce: null,
    version, updated_by: '1', updated_at: 1 };
}
async function profile(version = 7): Promise<RuntimeConfigRow> {
  return { key: 'TELEGRAM_SUPPORT_PROFILE', value_kind: 'SECRET', value_text: null,
    ...await runtimeCrypto.encryptRuntimeSecret(masterKey(), 'TELEGRAM_SUPPORT_PROFILE', JSON.stringify({
      bot_token: `123456:runtime_${version}_abcdefghijklmnopqrstuvwxyz`,
      webhook_secret: 's'.repeat(43), webhook_path: 'p'.repeat(43)
    })), version, updated_by: '1', updated_at: 1 };
}

describe('upload-only runtime configuration snapshot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads one D1 snapshot of only upload keys and never decrypts an unrelated corrupt AI secret', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push({ ...plain('AI_API_KEY', 'not-plaintext'),
      value_kind: 'SECRET', value_text: null, ciphertext: 'corrupt', nonce: 'bad' });
    const decrypt = vi.spyOn(runtimeCrypto, 'decryptRuntimeSecret');
    const prepare = vi.spyOn(testEnv.DB, 'prepare');
    const effective = await resolveUploadEnv(testEnv);

    expect(testEnv.DB.runtimeListReads).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain('FROM runtime_config WHERE key IN (');
    expect(decrypt).not.toHaveBeenCalled();
    expect(effective.runtimeConfigSnapshot).toMatchObject({ health: 'AVAILABLE', errors: {}, overrideCount: 0 });
    expect(Object.keys(effective.runtimeConfigSnapshot!.sources).sort()).toEqual([...UPLOAD_KEYS].sort());
    expect(effective.runtimeConfigSnapshot!.sources.AI_API_KEY).toBeUndefined();
    expect(effective.runtimeConfigSnapshot!.versions.AI_API_KEY).toBeUndefined();
    expect(effective.runtimeConfigSnapshot!.values.AI_API_KEY).toBeUndefined();
    expect(effective.CRISP_API_IDENTIFIER).toBe(testEnv.CRISP_API_IDENTIFIER);
    expect(effective.CRISP_API_KEY).toBe(testEnv.CRISP_API_KEY);
  });

  it('decrypts the selected Bot profile and keeps its version fixed within each request', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(await profile(), plain('BOT_GROUP_ID', '-1002', 4),
      { ...plain('AI_API_KEY', 'not-plaintext'), value_kind: 'SECRET', value_text: null,
        ciphertext: 'corrupt', nonce: 'bad' });
    const decrypt = vi.spyOn(runtimeCrypto, 'decryptRuntimeSecret');
    const first = await resolveUploadEnv(testEnv);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0][1]).toBe('TELEGRAM_SUPPORT_PROFILE');
    expect(first.TELEGRAM_BOT_TOKEN).toBe('123456:runtime_7_abcdefghijklmnopqrstuvwxyz');
    expect(first.runtimeConfigSnapshot!.versions).toEqual({ TELEGRAM_SUPPORT_PROFILE: 7, BOT_GROUP_ID: 4 });
    testEnv.DB.runtime[0] = await profile(8);
    testEnv.DB.runtime[1] = plain('BOT_GROUP_ID', '-1003', 5);
    const second = await resolveUploadEnv(testEnv);
    expect(testEnv.DB.runtimeListReads).toBe(2);
    expect(first.TELEGRAM_BOT_TOKEN).toBe('123456:runtime_7_abcdefghijklmnopqrstuvwxyz');
    expect(first.BOT_GROUP_ID).toBe('-1002');
    expect(first.runtimeConfigSnapshot!.versions.TELEGRAM_SUPPORT_PROFILE).toBe(7);
    expect(second.TELEGRAM_BOT_TOKEN).toBe('123456:runtime_8_abcdefghijklmnopqrstuvwxyz');
    expect(second.BOT_GROUP_ID).toBe('-1003');
    expect(second.runtimeConfigSnapshot!.versions.TELEGRAM_SUPPORT_PROFILE).toBe(8);
  });

  it('executes the filtered snapshot SQL against migrated SQLite with encrypted selected and unrelated rows', async () => {
    const db = new SqliteD1();
    try {
      db.migrate();
      const rows: RuntimeConfigRow[] = [await profile(12), plain('BOT_GROUP_ID', '-1004', 6),
        plain('ATTACHMENT_FILE_TTL_SECONDS', '3600', 3),
        { ...plain('AI_API_KEY', 'not-plaintext'), value_kind: 'SECRET', value_text: null,
          ciphertext: 'corrupt', nonce: 'bad' }];
      for (const row of rows) {
        await db.prepare(`INSERT INTO runtime_config
          (key,value_kind,value_text,ciphertext,nonce,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(row.key, row.value_kind, row.value_text, row.ciphertext, row.nonce,
            row.version, row.updated_by, row.updated_at).run();
      }
      const testEnv = env();
      testEnv.DB = db;
      const prepare = vi.spyOn(db, 'prepare');
      const effective = await resolveUploadEnv(testEnv);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(effective.TELEGRAM_BOT_TOKEN).toBe('123456:runtime_12_abcdefghijklmnopqrstuvwxyz');
      expect(effective.BOT_GROUP_ID).toBe('-1004');
      expect(effective.ATTACHMENT_FILE_TTL_SECONDS).toBe('3600');
      expect(effective.runtimeConfigSnapshot).toMatchObject({
        health: 'AVAILABLE', errors: {}, overrideCount: 3,
        versions: { TELEGRAM_SUPPORT_PROFILE: 12, BOT_GROUP_ID: 6, ATTACHMENT_FILE_TTL_SECONDS: 3 }
      });
      expect(effective.runtimeConfigSnapshot!.sources.AI_API_KEY).toBeUndefined();
    } finally { db.close(); }
  });

  it('keeps selected invalid Bot credentials authoritative instead of using old env credentials', async () => {
    const testEnv = env();
    const broken = await profile();
    broken.nonce = 'bad';
    testEnv.DB.runtime.push(broken);
    const effective = await resolveUploadEnv(testEnv);
    expect(effective.TELEGRAM_BOT_TOKEN).toBe('');
    expect(effective.TELEGRAM_WEBHOOK_SECRET).toBe('');
    expect(effective.TELEGRAM_SECRET_PATH).toBe('');
    expect(effective.runtimeConfigSnapshot!.sources.TELEGRAM_SUPPORT_PROFILE).toBe('D1');
    expect(effective.runtimeConfigSnapshot!.versions.TELEGRAM_SUPPORT_PROFILE).toBe(7);
    expect(effective.runtimeConfigSnapshot!.health).toBe('ERROR');
  });

  it('fails closed on D1 read failure while keeping bootstrap Crisp credentials intact', async () => {
    const testEnv = env();
    testEnv.DB = { prepare: () => { throw new Error('D1 unavailable'); } };
    const effective = await resolveUploadEnv(testEnv);
    expect(effective.TELEGRAM_BOT_TOKEN).toBe('');
    expect(effective.BOT_GROUP_ID).toBe('');
    expect(effective.CRISP_API_KEY).toBe('bootstrap-crisp-secret');
    expect(effective.runtimeConfigSnapshot!.errors).toEqual({ RUNTIME_CONFIG: 'RUNTIME_CONFIG_READ_FAILED' });
    expect(effective.runtimeConfigSnapshot!.sources.AI_API_KEY).toBeUndefined();
  });

  it('resolves identical upload retention, timeouts, human identity and notification behavior to the full snapshot', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(
      plain('ATTACHMENT_FILE_TTL_SECONDS', '3600', 4), plain('ATTACHMENT_IMAGE_TTL_SECONDS', '7200', 5),
      plain('ATTACHMENT_SOURCE_TIMEOUT_MS', '10000'), plain('ATTACHMENT_DESTINATION_TIMEOUT_MS', '20000'),
      plain('CRISP_OPERATOR_NICKNAME', 'runtime operator'),
      plain('CRISP_OPERATOR_AVATAR_URL', 'https://avatar.example/operator.png'),
      plain('TELEGRAM_NOTIFY_MANUAL_OFF', 'normal'), plain('TELEGRAM_NOTIFY_TELEGRAM_OPERATOR', 'silent'),
      plain('TELEGRAM_CRISP_HUMAN_QUIET_MINUTES', '30')
    );
    const selected = await resolveUploadEnv(testEnv);
    const full = await resolveEffectiveEnv(testEnv);
    expect(getAttachmentConfig(selected)).toEqual(getAttachmentConfig(full));
    expect(selected.CRISP_OPERATOR_NICKNAME).toBe(full.CRISP_OPERATOR_NICKNAME);
    expect(selected.CRISP_OPERATOR_AVATAR_URL).toBe(full.CRISP_OPERATOR_AVATAR_URL);
    for (const conversation of [
      { ai_mode: 'ENABLED', ai_pause_source: null, last_crisp_human_reply_at: Math.floor(Date.now() / 1000) - 1500 },
      { ai_mode: 'PAUSED_MANUAL', ai_pause_source: 'MANUAL', last_crisp_human_reply_at: null },
      { ai_mode: 'PAUSED_OPERATOR', ai_pause_source: 'TELEGRAM_OPERATOR', last_crisp_human_reply_at: null }
    ] as any[]) {
      expect(telegramCustomerRequestOptions(selected, conversation, false))
        .toEqual(telegramCustomerRequestOptions(full, conversation, false));
    }
  });

  it('still resolves all keys and exposes unrelated corrupt secrets as errors in the normal full resolver', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push({ ...plain('AI_API_KEY', 'not-plaintext'),
      value_kind: 'SECRET', value_text: null, ciphertext: 'corrupt', nonce: 'bad' });
    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.AI_API_KEY).toBe('');
    expect(effective.runtimeConfigSnapshot!.health).toBe('ERROR');
    expect(effective.runtimeConfigSnapshot!.sources.AI_API_KEY).toBe('D1');
  });
});

describe('attachment HTTP runtime isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kickCrispRtm).mockResolvedValue(undefined);
    vi.mocked(handleUploadSession).mockResolvedValue(new Response('session'));
    vi.mocked(handleUploadCapabilityRequest).mockResolvedValue(new Response('invite'));
  });

  it.each([
    [`/uploads/${TOKEN}`, 'GET'], [`/uploads/${TOKEN}`, 'POST'],
    [`/upload-sessions/${TOKEN}`, 'GET'], [`/upload-sessions/${TOKEN}/parts/1`, 'PUT'],
    [`/upload-sessions/${TOKEN}/complete`, 'POST']
  ])('uses one selected snapshot without RTM wake for %s %s', async (path, method) => {
    const testEnv = env();
    testEnv.DB.runtime.push(await profile(9), plain('BOT_GROUP_ID', '-1002', 4));
    const ctx = { waitUntil: vi.fn() };
    const response = await Worker.fetch(new Request(`https://custom.example${path}`, { method }), testEnv, ctx as any);
    expect(response.status).toBe(200);
    expect(kickCrispRtm).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(testEnv.DB.runtimeListReads).toBe(1);
    const handler = path.startsWith('/uploads/') ? handleUploadCapabilityRequest : handleUploadSession;
    const effective = vi.mocked(handler).mock.calls[0][1];
    expect(effective.BOT_GROUP_ID).toBe('-1002');
    expect(effective.runtimeConfigSnapshot?.versions.TELEGRAM_SUPPORT_PROFILE).toBe(9);
    expect(effective.runtimeConfigSnapshot?.sources.AI_API_KEY).toBeUndefined();
  });

  it.each([`/uploads/${TOKEN}`, `/upload-sessions/${TOKEN}`])('returns private 503 before upload handling on config read failure: %s', async path => {
    const testEnv = env();
    testEnv.DB = { prepare: () => { throw new Error('D1 unavailable'); } };
    const response = await Worker.fetch(new Request(`https://custom.example${path}`), testEnv, { waitUntil: vi.fn() } as any);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('old-env');
    expect(handleUploadSession).not.toHaveBeenCalled();
    expect(handleUploadCapabilityRequest).not.toHaveBeenCalled();
  });

  it.each(['TELEGRAM_SUPPORT_PROFILE', 'BOT_GROUP_ID', 'ATTACHMENT_FILE_TTL_SECONDS'] as RuntimeConfigKey[])(
    'returns 503 rather than admitting generation-zero work with invalid selected override %s', async key => {
      const testEnv = env();
      testEnv.DB.runtime.push(plain(key, 'invalid', 7));
      const response = await Worker.fetch(new Request(`https://custom.example/upload-sessions/${TOKEN}`), testEnv,
        { waitUntil: vi.fn() } as any);
      expect(response.status).toBe(503);
      expect(handleUploadSession).not.toHaveBeenCalled();
      expect(kickCrispRtm).not.toHaveBeenCalled();
    }
  );

  it('rejects a corrupt encrypted current-generation profile before either upload handler can run', async () => {
    const testEnv = env();
    const broken = await profile(7);
    broken.nonce = 'bad';
    testEnv.DB.runtime.push(broken);
    for (const path of [`/uploads/${TOKEN}`, `/upload-sessions/${TOKEN}`]) {
      const response = await Worker.fetch(new Request(`https://custom.example${path}`), testEnv,
        { waitUntil: vi.fn() } as any);
      expect(response.status).toBe(503);
    }
    expect(handleUploadSession).not.toHaveBeenCalled();
    expect(handleUploadCapabilityRequest).not.toHaveBeenCalled();
    expect(kickCrispRtm).not.toHaveBeenCalled();
  });

  it.each(['/uploads/malformed', '/upload-sessions/malformed', `/attachments/${TOKEN}`])(
    'does not wake RTM for upload errors or attachment downloads: %s', async path => {
      const testEnv = env();
      const ctx = { waitUntil: vi.fn() };
      await Worker.fetch(new Request(`https://custom.example${path}`), testEnv, ctx as any);
      expect(kickCrispRtm).not.toHaveBeenCalled();
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      expect(testEnv.DB.runtimeListReads).toBe(0);
    }
  );

  it('preserves RTM wake for ordinary ingress and scheduled keepalive', async () => {
    const testEnv = env();
    const ctx = { waitUntil: vi.fn() };
    await Worker.fetch(new Request('https://custom.example/webhooks/crisp', { method: 'POST', body: '{}' }), testEnv, ctx as any);
    expect(kickCrispRtm).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Worker.scheduled!({ scheduledTime: Date.UTC(2026, 9, 15, 1, 5) } as any, testEnv, ctx as any);
    expect(kickCrispRtm).toHaveBeenCalledTimes(2);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });
});
