import { Env } from '../index';

export interface AIConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  requestTimeoutMs: number;
  contextMaxMessages: number;
  contextMaxChars: number;
  generationLeaseSeconds: number;
  operatorPauseTimeoutSeconds: number;
}

export function getAIConfig(env: Env): AIConfig {
  const baseUrl = env.AI_BASE_URL || '';
  const apiKey = env.AI_API_KEY || '';
  const model = env.AI_MODEL || '';

  // Only enable if the core configuration is present
  const enabled = Boolean(baseUrl && apiKey && model);

  return {
    enabled,
    baseUrl,
    apiKey,
    model,
    systemPrompt: env.AI_SYSTEM_PROMPT || 'You are a helpful customer support AI.',
    requestTimeoutMs: parseInt(env.AI_REQUEST_TIMEOUT_MS as string, 10) || 30000,
    contextMaxMessages: parseInt(env.AI_CONTEXT_MAX_MESSAGES as string, 10) || 20,
    contextMaxChars: parseInt(env.AI_CONTEXT_MAX_CHARS as string, 10) || 12000,
    generationLeaseSeconds: parseInt(env.AI_GENERATION_LEASE_SECONDS as string, 10) || 60,
    operatorPauseTimeoutSeconds: parseInt(env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS as string, 10) || 3600
  };
}
