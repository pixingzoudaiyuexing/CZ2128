import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChatwootApiUrl, canonicalChatwootBaseUrl } from '../src/adapters/chatwoot/url';
import { testChatwootCandidate } from '../src/runtime-config/candidate-validation';

describe('canonical Chatwoot API base', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['https://chat.example', 'https://chat.example'],
    ['https://chat.example/', 'https://chat.example'],
    ['https://chat.example/tenant-a', 'https://chat.example/tenant-a'],
    ['https://chat.example/tenant-a/', 'https://chat.example/tenant-a']
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(canonicalChatwootBaseUrl(input)).toBe(expected);
    expect(buildChatwootApiUrl(input, '/api/v1/profile')).toBe(`${expected}/api/v1/profile`);
  });

  it('keeps different hosts, effective ports and base paths distinct', () => {
    expect(canonicalChatwootBaseUrl('https://chat-a.example/base'))
      .not.toBe(canonicalChatwootBaseUrl('https://chat-b.example/base'));
    expect(canonicalChatwootBaseUrl('https://chat.example/base'))
      .not.toBe(canonicalChatwootBaseUrl('https://chat.example:8443/base'));
    expect(canonicalChatwootBaseUrl('https://chat.example/tenant-a'))
      .not.toBe(canonicalChatwootBaseUrl('https://chat.example/tenant-b'));
    expect(canonicalChatwootBaseUrl('https://chat.example:443/base'))
      .toBe(canonicalChatwootBaseUrl('https://chat.example/base'));
  });

  it.each([
    ['https://chat.example', 'https://chat.example/api/v1/profile'],
    ['https://chat.example/', 'https://chat.example/api/v1/profile'],
    ['https://chat.example/tenant-a', 'https://chat.example/tenant-a/api/v1/profile'],
    ['https://chat.example/tenant-a/', 'https://chat.example/tenant-a/api/v1/profile']
  ])('uses the canonical base for candidate validation: %s', async (base, expected) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await testChatwootCandidate({ CHATWOOT_API_URL: base, CHATWOOT_API_TOKEN: 'secret' } as any);
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
  });
});
