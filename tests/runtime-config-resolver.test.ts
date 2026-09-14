import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateChatCompletion } from '../src/adapters/ai/openai-compatible';
import { createChatwootMessage } from '../src/adapters/chatwoot/api';
import { closeTelegramTopic, createTelegramTopic, reopenTelegramTopic, sendTelegramMessage } from '../src/adapters/telegram/api';
import { verifyTelegramWebhook } from '../src/adapters/telegram/webhook';
import { deliverAttachmentToTelegram } from '../src/attachments/delivery';
import { downloadTelegramAttachment } from '../src/attachments/source';
import { getAIConfig } from '../src/config/ai';
import { getAttachmentConfig } from '../src/config/attachments';
import { encryptRuntimeSecret } from '../src/runtime-config/crypto';
import { resolveEffectiveEnv } from '../src/runtime-config/resolver';
import { RuntimeConfigRow } from '../src/runtime-config/types';
import { restoreEnvOverride, setPlainOverride } from '../src/runtime-config/service';
import { RuntimeDb, masterKey } from './helpers/runtime-db';
import Worker from '../src/index';
import { processAiTrigger } from '../src/queue/ai-handler';

function env(db = new RuntimeDb()) {
  return {
    DB: db,
    QUEUE: { send: async () => undefined },
    RUNTIME_CONFIG_MASTER_KEY: masterKey(),
    AI_BASE_URL: 'https://env-ai.example/v1', AI_MODEL: 'env-model', AI_API_KEY: 'env-ai-key',
    CHATWOOT_API_URL: 'https://env-chatwoot.example', CHATWOOT_API_TOKEN: 'env-cw-token',
    TELEGRAM_BOT_TOKEN: 'env-tg-token', TELEGRAM_WEBHOOK_SECRET: 'env-secret',
    TELEGRAM_SECRET_PATH: 'env-path', BOT_GROUP_ID: '-1001'
  } as any;
}

function plain(key: string, value: string, version = 1): RuntimeConfigRow {
  return {
    key: key as any, value_kind: 'PLAIN', value_text: value, ciphertext: null, nonce: null,
    version, updated_by: '1', updated_at: 1
  };
}

async function secret(key: any, value: string, version = 1): Promise<RuntimeConfigRow> {
  const encrypted = await encryptRuntimeSecret(masterKey(), key, value);
  return {
    key, value_kind: 'SECRET', value_text: null, ...encrypted,
    version, updated_by: '1', updated_at: 1
  };
}

describe('runtime config resolver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to env when no override exists and D1 wins when present', async () => {
    const testEnv = env();
    const fallback = await resolveEffectiveEnv(testEnv);
    expect(fallback.AI_MODEL).toBe('env-model');
    expect(fallback.runtimeConfigSnapshot?.sources.AI_MODEL).toBe('ENV');

    testEnv.DB.runtime.push(plain('AI_MODEL', 'd1-model'));
    const overridden = await resolveEffectiveEnv(testEnv);
    expect(overridden.AI_MODEL).toBe('d1-model');
    expect(overridden.runtimeConfigSnapshot?.sources.AI_MODEL).toBe('D1');
  });

  it('uses an encrypted D1 secret and never stores its plaintext in the row', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(await secret('AI_API_KEY', 'd1-private-key'));
    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.AI_API_KEY).toBe('d1-private-key');
    expect(testEnv.DB.runtime[0].value_text).toBeNull();
    expect(JSON.stringify(testEnv.DB.runtime[0])).not.toContain('d1-private-key');
  });

  it('does not fall back to a superseded env secret when decryption fails', async () => {
    const testEnv = env();
    const row = await secret('AI_API_KEY', 'd1-key');
    row.ciphertext = `${row.ciphertext!.startsWith('A') ? 'B' : 'A'}${row.ciphertext!.slice(1)}`;
    testEnv.DB.runtime.push(row);

    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.AI_API_KEY).toBe('');
    expect(effective.AI_API_KEY).not.toBe('env-ai-key');
    expect(getAIConfig(effective).enabled).toBe(false);
    expect(effective.TELEGRAM_BOT_TOKEN).toBe('env-tg-token');
    expect(effective.runtimeConfigSnapshot?.health).toBe('ERROR');
  });

  it('fails closed for all runtime-controlled providers when the runtime table cannot be read', async () => {
    const testEnv = env();
    testEnv.DB = { prepare: () => { throw new Error('D1 unavailable'); } };
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.AI_BASE_URL).toBe('');
    expect(effective.AI_MODEL).toBe('');
    expect(effective.AI_API_KEY).toBe('');
    expect(effective.TELEGRAM_BOT_TOKEN).toBe('');
    expect(effective.TELEGRAM_WEBHOOK_SECRET).toBe('');
    expect(effective.TELEGRAM_SECRET_PATH).toBe('');
    expect(effective.BOT_GROUP_ID).toBe('');
    expect(effective.CHATWOOT_API_URL).toBe('');
    expect(effective.CHATWOOT_API_TOKEN).toBe('');
    expect(getAIConfig(effective).enabled).toBe(false);
    await processAiTrigger({
      version: 1, source: 'internal', type: 'ai_trigger', eventId: 'read-failure',
      payload: { convId: 'conv', messageId: 'message' }
    }, effective);
    await expect(sendTelegramMessage(effective, '-1001', null, 'test')).rejects.toMatchObject({
      message: 'TELEGRAM_RUNTIME_CONFIG_ERROR'
    });
    await expect(createChatwootMessage(effective, '1', '2', 'test', 'op')).rejects.toMatchObject({
      message: 'CHATWOOT_RUNTIME_CONFIG_ERROR'
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(effective.runtimeConfigSnapshot).toMatchObject({
      health: 'ERROR', errors: { RUNTIME_CONFIG: 'RUNTIME_CONFIG_READ_FAILED' }
    });
  });

  it('rejects the stale env Support webhook when runtime config cannot be read', async () => {
    const testEnv = env();
    testEnv.DB = { prepare: () => { throw new Error('D1 unavailable'); } };
    testEnv.QUEUE = { send: vi.fn() };
    const response = await Worker.fetch(new Request('https://worker.example/webhooks/telegram/env-path', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'env-secret' },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 1, message_thread_id: 7, chat: { id: -1001 }, from: { id: 1, is_bot: false }, text: 'late' }
      })
    }), testEnv, {} as any);
    expect(response.status).toBe(500);
    expect(testEnv.QUEUE.send).not.toHaveBeenCalled();
  });

  it('does not expose env Telegram or Chatwoot credentials after malformed secret overrides', async () => {
    const testEnv = env();
    const telegram = await secret('TELEGRAM_SUPPORT_PROFILE', JSON.stringify({
      bot_token: '123456:abcdefghijklmnopqrstuvwxyz',
      webhook_secret: 's'.repeat(43), webhook_path: 'p'.repeat(43)
    }));
    telegram.nonce = 'bad';
    const chatwoot = await secret('CHATWOOT_API_TOKEN', 'runtime-token');
    chatwoot.ciphertext = 'bad';
    testEnv.DB.runtime.push(telegram, chatwoot);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const effective = await resolveEffectiveEnv(testEnv);
    expect(effective.TELEGRAM_BOT_TOKEN).toBe('');
    expect(effective.CHATWOOT_API_TOKEN).toBe('');
    await expect(sendTelegramMessage(effective, '-1001', null, 'test')).rejects.toMatchObject({
      message: 'TELEGRAM_RUNTIME_CONFIG_ERROR'
    });
    await expect(createChatwootMessage(effective, '1', '2', 'test', 'op')).rejects.toMatchObject({
      message: 'CHATWOOT_RUNTIME_CONFIG_ERROR'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads a coherent snapshot and exposes updates only to the next resolution', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(plain('AI_MODEL', 'first', 1));
    const first = await resolveEffectiveEnv(testEnv);
    testEnv.DB.runtime[0].value_text = 'second';
    testEnv.DB.runtime[0].version = 2;
    const second = await resolveEffectiveEnv(testEnv);
    expect(first.AI_MODEL).toBe('first');
    expect(first.runtimeConfigSnapshot?.versions.AI_MODEL).toBe(1);
    expect(second.AI_MODEL).toBe('second');
    expect(second.runtimeConfigSnapshot?.versions.AI_MODEL).toBe(2);
  });

  it('restores env fallback on the request after a runtime override is removed', async () => {
    const testEnv = env();
    await setPlainOverride(testEnv, 'AI_MODEL', 'runtime-model', 0, '1', '1');
    expect((await resolveEffectiveEnv(testEnv)).AI_MODEL).toBe('runtime-model');
    await restoreEnvOverride(testEnv, 'AI_MODEL', 1, '1', '2');
    const restored = await resolveEffectiveEnv(testEnv);
    expect(restored.AI_MODEL).toBe('env-model');
    expect(restored.runtimeConfigSnapshot?.sources.AI_MODEL).toBe('ENV');
  });

  it('sends effective D1 AI URL, authorization and model to the adapter', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(
      plain('AI_BASE_URL', 'https://runtime-ai.example/v1'),
      plain('AI_MODEL', 'runtime-model'),
      await secret('AI_API_KEY', 'runtime-ai-key')
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }));
    const effective = await resolveEffectiveEnv(testEnv);
    await generateChatCompletion(getAIConfig(effective), [{ role: 'user', content: 'synthetic' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://runtime-ai.example/v1/chat/completions');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer runtime-ai-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('runtime-model');
  });

  it('uses the atomic runtime Telegram profile for ingress and provider paths', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(await secret('TELEGRAM_SUPPORT_PROFILE', JSON.stringify({
      bot_token: '123456:runtimeabcdefghijklmnopqrstuvwxyz',
      webhook_secret: 's'.repeat(43), webhook_path: 'p'.repeat(43)
    })));
    const effective = await resolveEffectiveEnv(testEnv);
    const request = new Request('https://worker.example/webhooks/telegram/runtime', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's'.repeat(43) },
      body: JSON.stringify({ update_id: 1 })
    });
    await expect(verifyTelegramWebhook(request, 'p'.repeat(43), effective.TELEGRAM_SECRET_PATH,
      effective.TELEGRAM_WEBHOOK_SECRET, effective.BOT_GROUP_ID)).resolves.toMatchObject({ valid: true });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    await sendTelegramMessage(effective, '-1001', null, 'test');
    expect(String(fetchMock.mock.calls[0][0])).toContain('bot123456:runtimeabcdefghijklmnopqrstuvwxyz/sendMessage');

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: 'file.bin' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob([new Uint8Array([1])]).stream(), { status: 200 }));
    const source = await downloadTelegramAttachment(effective, 'file', 1, getAttachmentConfig(effective));
    source.finish();
    expect(String(fetchMock.mock.calls[1][0])).toContain('bot123456:runtimeabcdefghijklmnopqrstuvwxyz/getFile');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200 }));
    await deliverAttachmentToTelegram(effective, getAttachmentConfig(effective), {
      id: 'a', attachment_type: 'document', safe_filename: 'a.bin', mime_type: 'application/octet-stream', size_bytes: 1
    } as any, '7', new Uint8Array([1]).buffer);
    expect(String(fetchMock.mock.calls[3][0])).toContain('bot123456:runtimeabcdefghijklmnopqrstuvwxyz/sendDocument');

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_thread_id: 9 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    await createTelegramTopic(effective, '-1001', 'topic');
    await closeTelegramTopic(effective, '-1001', '9');
    await reopenTelegramTopic(effective, '-1001', '9');
    expect(String(fetchMock.mock.calls[4][0])).toContain('bot123456:runtimeabcdefghijklmnopqrstuvwxyz/createForumTopic');
    expect(String(fetchMock.mock.calls[5][0])).toContain('bot123456:runtimeabcdefghijklmnopqrstuvwxyz/closeForumTopic');
    expect(String(fetchMock.mock.calls[6][0])).toContain('bot123456:runtimeabcdefghijklmnopqrstuvwxyz/reopenForumTopic');
    expect(fetchMock.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('env-tg-token');
  });

  it('applies Chatwoot and attachment plain runtime settings', async () => {
    const testEnv = env();
    testEnv.DB.runtime.push(
      plain('CHATWOOT_API_URL', 'https://runtime-chatwoot.example'),
      await secret('CHATWOOT_API_TOKEN', 'runtime-cw-token'),
      plain('ATTACHMENT_MAX_BYTES', '1024'),
      plain('ATTACHMENT_MAX_COUNT_PER_MESSAGE', '2')
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 })
    );
    const effective = await resolveEffectiveEnv(testEnv);
    await createChatwootMessage(effective, '1', '2', 'test', 'op');
    expect(fetchMock.mock.calls[0][0]).toBe('https://runtime-chatwoot.example/api/v1/accounts/1/conversations/2/messages');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('api_access_token')).toBe('runtime-cw-token');
    expect(getAttachmentConfig(effective)).toMatchObject({ maxBytes: 1024, maxCountPerMessage: 2 });
  });
});
