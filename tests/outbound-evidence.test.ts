import { describe, expect, it } from 'vitest';
import {
  buildChatwootTargetEvidence,
  buildTelegramTargetEvidence,
  parseTargetEvidence,
  serializeTargetEvidence
} from '../src/core/outbound-evidence';

describe('outbound target evidence', () => {
  it('persists versioned Chatwoot identity without raw URL or secrets', async () => {
    const env = {
      CHATWOOT_API_URL: 'https://support.example/private/base',
      CHATWOOT_API_TOKEN: 'chatwoot-secret-token',
      runtimeConfigSnapshot: {
        sources: { CHATWOOT_API_URL: 'D1' },
        versions: { CHATWOOT_API_URL: 7 }
      }
    } as any;
    const evidence = await buildChatwootTargetEvidence(env, '1', '2', 'operation-1');
    const serialized = serializeTargetEvidence({
      ...evidence,
      rawUrl: env.CHATWOOT_API_URL,
      token: env.CHATWOOT_API_TOKEN,
      content: 'private customer message'
    } as any);

    expect(parseTargetEvidence(serialized)).toEqual({
      version: 1,
      provider: 'chatwoot',
      accountRef: '1',
      conversationRef: '2',
      sourceId: 'cz2128:operation-1',
      apiUrlSource: 'D1',
      apiUrlVersion: 7,
      apiOriginFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(serialized).not.toContain('https://support.example');
    expect(serialized).not.toContain('chatwoot-secret-token');
    expect(serialized).not.toContain('private customer message');
  });

  it('persists Telegram runtime sources, versions and destination without bot secrets', () => {
    const env = {
      TELEGRAM_BOT_TOKEN: 'telegram-secret-token',
      BOT_GROUP_ID: '-100123',
      runtimeConfigSnapshot: {
        sources: { TELEGRAM_SUPPORT_PROFILE: 'D1', BOT_GROUP_ID: 'D1' },
        versions: { TELEGRAM_SUPPORT_PROFILE: 4, BOT_GROUP_ID: 9 }
      }
    } as any;
    const evidence = buildTelegramTargetEvidence(env, '-100123', '77', 'sendDocument');
    const serialized = serializeTargetEvidence({
      ...evidence,
      botToken: env.TELEGRAM_BOT_TOKEN,
      text: 'private operator message'
    } as any);

    expect(parseTargetEvidence(serialized)).toEqual({
      version: 1,
      provider: 'telegram',
      supportProfileSource: 'D1',
      supportProfileVersion: 4,
      botGroupIdSource: 'D1',
      botGroupIdVersion: 9,
      groupRef: '-100123',
      threadRef: '77',
      method: 'sendDocument'
    });
    expect(serialized).not.toContain('telegram-secret-token');
    expect(serialized).not.toContain('private operator message');
  });
});
