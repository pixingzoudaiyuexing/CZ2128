import { generateChatCompletion } from '../adapters/ai/openai-compatible';
import { getAIConfig } from '../config/ai';
import { Env } from '../config/env';
import { RuntimeConfigKey } from './types';
import { SafeErrorCode } from '../core/error-taxonomy';
import { SafeError } from '../core/errors';

export class CandidateValidationError extends SafeError {
  constructor(code: SafeErrorCode, options: ConstructorParameters<typeof SafeError>[1] = {}) {
    super(code, options);
    this.name = 'CandidateValidationError';
  }
}

export async function testAiCandidate(
  env: Env,
  candidate: Partial<Record<RuntimeConfigKey, string>> = {}
): Promise<void> {
  const candidateEnv = {
    ...env,
    AI_BASE_URL: candidate.AI_BASE_URL ?? env.AI_BASE_URL,
    AI_MODEL: candidate.AI_MODEL ?? env.AI_MODEL,
    AI_API_KEY: candidate.AI_API_KEY ?? env.AI_API_KEY
  } as Env;
  const config = getAIConfig(candidateEnv);
  if (!config.enabled) throw new CandidateValidationError('AI_CONFIG_INCOMPLETE');
  const result = await generateChatCompletion(
    { ...config, requestTimeoutMs: Math.min(config.requestTimeoutMs, 15000) },
    [{ role: 'user', content: 'Reply with OK.' }],
    { maxTokens: 1 }
  );
  if (!result.success) {
    throw new CandidateValidationError(result.error, {
      provider: 'AI_PROVIDER',
      httpStatus: result.httpStatus,
      retryAfterSeconds: result.retryAfterSeconds
    });
  }
}

export async function testChatwootCandidate(
  env: Env,
  candidate: Partial<Record<RuntimeConfigKey, string>> = {}
): Promise<void> {
  const baseUrl = (candidate.CHATWOOT_API_URL ?? env.CHATWOOT_API_URL ?? '').replace(/\/+$/, '');
  const token = candidate.CHATWOOT_API_TOKEN ?? env.CHATWOOT_API_TOKEN ?? '';
  if (!baseUrl || !token) throw new CandidateValidationError('CHATWOOT_CONFIG_INCOMPLETE');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/api/v1/profile`, {
      method: 'GET',
      headers: { 'api_access_token': token },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new CandidateValidationError('CHATWOOT_PROFILE_REJECTED', {
        provider: 'CHATWOOT',
        httpStatus: response.status
      });
    }
  } catch (error) {
    if (error instanceof CandidateValidationError) throw error;
    throw new CandidateValidationError(error instanceof Error && error.name === 'AbortError'
      ? 'CHATWOOT_PROFILE_TIMEOUT'
      : 'CHATWOOT_PROFILE_TRANSPORT_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}
