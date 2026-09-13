import { Env } from './env';
import { logger } from '../observability/logger';

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

function parseBoundedInt(val: string | undefined, def: number, min: number, max: number): number {
  if (!val) return def;
  const normalized = val.trim();
  if (!/^\d+$/.test(normalized)) return def;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return def;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function parseBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || '';
  if (!raw || raw.length > 2048) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return '';
    }
    return raw.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function getAIConfig(env: Env): AIConfig {
  const baseUrl = parseBaseUrl(env.AI_BASE_URL);
  const apiKey = env.AI_API_KEY?.trim() || '';
  const model = (env.AI_MODEL?.trim() || '').slice(0, 256);

  const enabled = Boolean(baseUrl && apiKey && model);

  // Hard caps and sane defaults
  const requestTimeoutMs = parseBoundedInt(env.AI_REQUEST_TIMEOUT_MS, 30000, 5000, 120000);
  let generationLeaseSeconds = parseBoundedInt(env.AI_GENERATION_LEASE_SECONDS, 60, 10, 300);
  
  // Guarantee generationLeaseSeconds > requestTimeout
  const minLease = Math.ceil(requestTimeoutMs / 1000) + 10; 
  if (generationLeaseSeconds < minLease) {
    logger.warn(`AI_GENERATION_LEASE_SECONDS was too low, overriding to ${minLease}`);
    generationLeaseSeconds = minLease;
  }

  return {
    enabled,
    baseUrl,
    apiKey,
    model,
    systemPrompt: (env.AI_SYSTEM_PROMPT || 'You are a helpful customer support AI.').slice(0, 20000),
    requestTimeoutMs,
    contextMaxMessages: parseBoundedInt(env.AI_CONTEXT_MAX_MESSAGES, 20, 1, 100),
    contextMaxChars: parseBoundedInt(env.AI_CONTEXT_MAX_CHARS, 12000, 1000, 100000),
    generationLeaseSeconds,
    operatorPauseTimeoutSeconds: parseBoundedInt(env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS, 3600, 60, 86400 * 30)
  };
}
