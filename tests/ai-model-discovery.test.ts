import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_MODEL_DISCOVERY_MAX_MODELS,
  AI_MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
  AIModelDiscoveryError,
  listAvailableModels,
  normalizeModelDirectory
} from '../src/adapters/ai/model-discovery';

function providerResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init
  });
}

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'AIModelDiscoveryError', reason });
}

describe('OpenAI-compatible model discovery adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('GETs the normalized /models endpoint with Bearer auth, JSON accept, bounded signal and manual redirects', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      providerResponse({ data: [{ id: 'model-b' }, { id: 'model-a' }] })
    );

    const result = await listAvailableModels({
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'secret-provider-key',
      timeoutMs: 9000
    });

    expect(result).toEqual({ models: ['model-a', 'model-b'], truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://provider.example/v1/models');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer secret-provider-key'
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes model ids by trim, exact dedupe, control filtering and stable lexical sort', () => {
    const result = normalizeModelDirectory({
      data: [
        { id: ' z-model ' },
        { id: 'a-model' },
        { id: 'a-model' },
        { id: 'bad\nmodel' },
        { id: '' },
        { id: '   ' },
        { id: 123 },
        null,
        { nope: 'x' },
        { id: 'm-model' }
      ]
    });
    expect(result).toEqual({
      models: ['a-model', 'm-model', 'z-model'],
      truncated: false
    });
  });

  it('filters overlong discovered ids instead of guessing or truncating them', () => {
    const result = normalizeModelDirectory({
      data: [{ id: 'x'.repeat(257) }, { id: 'valid-model' }]
    });
    expect(result.models).toEqual(['valid-model']);
  });

  it('bounds a large provider directory at 200 valid ids and marks it truncated', () => {
    const result = normalizeModelDirectory({
      data: Array.from({ length: 250 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` }))
    });
    expect(result.models).toHaveLength(AI_MODEL_DISCOVERY_MAX_MODELS);
    expect(result.models[0]).toBe('model-000');
    expect(result.models.at(-1)).toBe('model-199');
    expect(result.truncated).toBe(true);
  });

  it('rejects a non-array data field', async () => {
    expect(() => normalizeModelDirectory({ data: {} })).toThrowError(
      expect.objectContaining({ reason: 'INVALID_RESPONSE' })
    );
  });

  it('rejects an empty valid model list', async () => {
    expect(() => normalizeModelDirectory({ data: [{ id: '' }, { id: '\u0000' }] })).toThrowError(
      expect.objectContaining({ reason: 'EMPTY' })
    );
  });

  it('does not issue a provider request when base URL is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expectReason(listAvailableModels({ baseUrl: '', apiKey: 'key' }), 'CONFIG_INCOMPLETE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not issue a provider request when API key is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expectReason(listAvailableModels({ baseUrl: 'https://provider.example/v1', apiKey: '' }), 'CONFIG_INCOMPLETE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'CREDENTIAL_REJECTED'],
    [403, 'CREDENTIAL_REJECTED'],
    [404, 'UNSUPPORTED'],
    [405, 'UNSUPPORTED'],
    [429, 'RATE_LIMITED'],
    [500, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
    [400, 'REJECTED']
  ] as const)('classifies provider HTTP %s as %s without reading or logging the body', async (status, reason) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private provider body', { status })
    );
    const promise = listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-provider-key'
    });
    await expectReason(promise, reason);
    await expect(promise).rejects.toMatchObject({ httpStatus: status });
  });

  it('rejects redirects instead of following a credential-bearing request to another origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/steal' }
      })
    );
    await expectReason(listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-provider-key'
    }), 'REDIRECT_REJECTED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('classifies malformed JSON as an invalid response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{not-json', { status: 200 })
    );
    await expectReason(listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'key'
    }), 'INVALID_RESPONSE');
  });

  it('classifies an empty valid directory separately', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse({ data: [] }));
    await expectReason(listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'key'
    }), 'EMPTY');
  });

  it('rejects an oversized model-directory response before reading it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(AI_MODEL_DISCOVERY_MAX_RESPONSE_BYTES + 1) }
      })
    );
    await expectReason(listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'key'
    }), 'INVALID_RESPONSE');
  });

  it('classifies provider transport failures without leaking the original error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('secret transport detail'));
    await expectReason(listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'key'
    }), 'TRANSPORT');
  });

  it('aborts a hung model request at the bounded timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const promise = listAvailableModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'key',
      timeoutMs: 1000
    });
    const assertion = expectReason(promise, 'TIMEOUT');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
