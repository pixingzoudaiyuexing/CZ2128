import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateChatCompletion } from '../src/adapters/ai/openai-compatible';
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

    expect(result).toEqual({ success: false, error: 'AI_TRANSPORT_ERROR' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns bounded error codes for HTTP and malformed responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response('private body', { status: 503 }));
    await expect(generateChatCompletion(baseConfig, [])).resolves.toEqual({ success: false, error: 'AI_HTTP_503' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(generateChatCompletion(baseConfig, [])).resolves.toEqual({ success: false, error: 'AI_INVALID_RESPONSE' });
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
