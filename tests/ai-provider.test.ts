import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyAIHttpFailure, generateChatCompletion } from '../src/adapters/ai/openai-compatible';
import { getAIConfig } from '../src/config/ai';

const baseConfig = {
  enabled: true,
  baseUrl: 'https://ai.example/v1/',
  apiKey: 'secret-key',
  model: 'model',
  systemPrompt: 'System',
  requestTimeoutMs: 30000,
  contextMaxMessages: 20,
  contextMaxChars: 12000,
  generationLeaseSeconds: 60,
  operatorPauseTimeoutSeconds: 3600
};
const validMessages = [{ role: 'user' as const, content: 'Question' }];

describe('AI provider and configuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('normalizes a trailing slash when constructing the completion endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'response-1', choices: [{ message: { content: 'Answer' } }]
    }), { status: 200 }));

    const result = await generateChatCompletion(baseConfig, [{ role: 'user', content: 'Question' }]);

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai.example/v1/chat/completions');
  });

  it('clears the timeout and redacts transport exception details', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket failed with secret-key'));

    const result = await generateChatCompletion(baseConfig, [{ role: 'user', content: 'Question' }]);

    expect(result).toEqual({ success: false, error: 'AI_TRANSPORT_ERROR', retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies an aborted AI request as a retryable timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      })
    );
    const pending = generateChatCompletion({ ...baseConfig, requestTimeoutMs: 10 }, validMessages);
    await vi.advanceTimersByTimeAsync(11);
    await expect(pending).resolves.toEqual({ success: false, error: 'AI_TIMEOUT', retryable: true });
  });

  it('honors Retry-After for AI 429 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private body', {
      status: 429, headers: { 'Retry-After': '30' }
    }));
    const result = await generateChatCompletion(baseConfig, validMessages);
    expect(result).toMatchObject({ success: false, error: 'AI_RATE_LIMITED', retryable: true, httpStatus: 429 });
    if (result.success) throw new Error('Expected AI rate limit failure');
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(30);
  });

  it('returns bounded error codes for HTTP and malformed responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response('private body', { status: 503 }));
    await expect(generateChatCompletion(baseConfig, validMessages)).resolves.toEqual({
      success: false, error: 'AI_PROVIDER_5XX', retryable: true, httpStatus: 503
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(generateChatCompletion(baseConfig, validMessages)).resolves.toEqual({
      success: false, error: 'AI_INVALID_RESPONSE', retryable: true
    });
  });

  it.each([429, 408, 500, 502, 503, 504])('classifies AI HTTP %s as retryable', status => {
    expect(classifyAIHttpFailure(status).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('classifies AI HTTP %s as final', status => {
    expect(classifyAIHttpFailure(status)).toMatchObject({
      success: false, error: 'AI_PROVIDER_4XX', retryable: false, httpStatus: status
    });
  });

  it('classifies invalid local context as final without calling the provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(generateChatCompletion(baseConfig, [])).resolves.toEqual({
      success: false, error: 'AI_CONTEXT_INVALID', retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects partial numeric config and invalid provider URLs', () => {
    const config = getAIConfig({
      AI_BASE_URL: 'not-a-url',
      AI_API_KEY: 'key',
      AI_MODEL: 'model',
      AI_REQUEST_TIMEOUT_MS: '10000junk'
    } as any);

    expect(config.enabled).toBe(false);
    expect(config.requestTimeoutMs).toBe(30000);
  });
});
