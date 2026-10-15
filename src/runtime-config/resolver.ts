import { Env } from '../config/env';
import { decryptRuntimeSecret } from './crypto';
import { parseTelegramSupportProfile, validateRuntimeValue } from './registry';
import { listRuntimeConfig } from './repository';
import {
  RUNTIME_CONFIG_KEYS,
  RuntimeConfigKey,
  RuntimeConfigRow,
  RuntimeConfigSnapshot,
  RuntimeValueSource
} from './types';
import { safeErrorCode } from '../core/errors';
import { SafeErrorCode } from '../core/error-taxonomy';

const ENV_KEY_MAP: Partial<Record<RuntimeConfigKey, keyof Env>> = {
  AI_BASE_URL: 'AI_BASE_URL',
  AI_MODEL: 'AI_MODEL',
  AI_API_KEY: 'AI_API_KEY',
  AI_SYSTEM_PROMPT: 'AI_SYSTEM_PROMPT',
  AI_REQUEST_TIMEOUT_MS: 'AI_REQUEST_TIMEOUT_MS',
  AI_CONTEXT_MAX_MESSAGES: 'AI_CONTEXT_MAX_MESSAGES',
  AI_CONTEXT_MAX_CHARS: 'AI_CONTEXT_MAX_CHARS',
  AI_GENERATION_LEASE_SECONDS: 'AI_GENERATION_LEASE_SECONDS',
  AI_OPERATOR_PAUSE_TIMEOUT_SECONDS: 'AI_OPERATOR_PAUSE_TIMEOUT_SECONDS',
  CRISP_KEYWORD_RULES: 'CRISP_KEYWORD_RULES',
  CRISP_OPERATOR_NICKNAME: 'CRISP_OPERATOR_NICKNAME',
  CRISP_OPERATOR_AVATAR_URL: 'CRISP_OPERATOR_AVATAR_URL',
  CRISP_AI_NICKNAME: 'CRISP_AI_NICKNAME',
  CRISP_AI_AVATAR_URL: 'CRISP_AI_AVATAR_URL',
  TELEGRAM_NOTIFY_CRISP_OPERATOR: 'TELEGRAM_NOTIFY_CRISP_OPERATOR',
  TELEGRAM_CRISP_HUMAN_QUIET_MINUTES: 'TELEGRAM_CRISP_HUMAN_QUIET_MINUTES',
  TELEGRAM_NOTIFY_TELEGRAM_OPERATOR: 'TELEGRAM_NOTIFY_TELEGRAM_OPERATOR',
  TELEGRAM_NOTIFY_MANUAL_OFF: 'TELEGRAM_NOTIFY_MANUAL_OFF',
  BOT_GROUP_ID: 'BOT_GROUP_ID',
  CHATWOOT_API_URL: 'CHATWOOT_API_URL',
  CHATWOOT_API_TOKEN: 'CHATWOOT_API_TOKEN',
  CHATWOOT_ATTACHMENT_ALLOWED_HOSTS: 'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS',
  ATTACHMENT_MAX_BYTES: 'ATTACHMENT_MAX_BYTES',
  ATTACHMENT_MAX_COUNT_PER_MESSAGE: 'ATTACHMENT_MAX_COUNT_PER_MESSAGE',
  ATTACHMENT_TTL_SECONDS: 'ATTACHMENT_TTL_SECONDS',
  ATTACHMENT_FILE_TTL_SECONDS: 'ATTACHMENT_FILE_TTL_SECONDS',
  ATTACHMENT_IMAGE_TTL_SECONDS: 'ATTACHMENT_IMAGE_TTL_SECONDS',
  ATTACHMENT_SOURCE_TIMEOUT_MS: 'ATTACHMENT_SOURCE_TIMEOUT_MS',
  ATTACHMENT_DESTINATION_TIMEOUT_MS: 'ATTACHMENT_DESTINATION_TIMEOUT_MS'
};

// Upload HTTP requests never call AI or the historical Chatwoot provider. Keep
// their snapshot coherent without reading/decrypting unrelated provider secrets.
// The Support profile still requires authenticated decryption and validation:
// its D1 version is part of the upload invitation's authorization boundary.
const UPLOAD_RUNTIME_KEYS: readonly RuntimeConfigKey[] = [
  'TELEGRAM_SUPPORT_PROFILE',
  'BOT_GROUP_ID',
  'CRISP_OPERATOR_NICKNAME',
  'CRISP_OPERATOR_AVATAR_URL',
  'TELEGRAM_CRISP_HUMAN_QUIET_MINUTES',
  'TELEGRAM_NOTIFY_TELEGRAM_OPERATOR',
  'TELEGRAM_NOTIFY_MANUAL_OFF',
  'ATTACHMENT_FILE_TTL_SECONDS',
  'ATTACHMENT_IMAGE_TTL_SECONDS',
  'ATTACHMENT_SOURCE_TIMEOUT_MS',
  'ATTACHMENT_DESTINATION_TIMEOUT_MS'
];

function envFallback(env: Env, key: RuntimeConfigKey): string | undefined {
  if (key === 'TELEGRAM_SUPPORT_PROFILE') {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_SECRET_PATH) return undefined;
    return JSON.stringify({
      bot_token: env.TELEGRAM_BOT_TOKEN,
      webhook_secret: env.TELEGRAM_WEBHOOK_SECRET,
      webhook_path: env.TELEGRAM_SECRET_PATH
    });
  }
  const envKey = ENV_KEY_MAP[key];
  const value = envKey ? env[envKey] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function fallbackSnapshot(env: Env, keys: readonly RuntimeConfigKey[]): RuntimeConfigSnapshot {
  const values: Partial<Record<RuntimeConfigKey, string>> = {};
  const sources: Partial<Record<RuntimeConfigKey, RuntimeValueSource>> = {};
  for (const key of keys) {
    sources[key] = 'ENV';
    const value = envFallback(env, key);
    if (value !== undefined) values[key] = value;
  }
  return {
    values,
    sources,
    versions: {},
    errors: {},
    overrideCount: 0,
    health: 'AVAILABLE'
  };
}

function failedSnapshot(error: SafeErrorCode, keys: readonly RuntimeConfigKey[]): RuntimeConfigSnapshot {
  const sources: Partial<Record<RuntimeConfigKey, RuntimeValueSource>> = {};
  for (const key of keys) sources[key] = 'D1';
  return {
    values: {},
    sources,
    versions: {},
    errors: { RUNTIME_CONFIG: error },
    overrideCount: 0,
    health: 'ERROR'
  };
}

export async function loadRuntimeConfigSnapshot(
  env: Env,
  selectedKeys?: readonly RuntimeConfigKey[]
): Promise<RuntimeConfigSnapshot> {
  const keys = selectedKeys ?? RUNTIME_CONFIG_KEYS;
  const snapshot = fallbackSnapshot(env, keys);
  let rows;
  try {
    rows = selectedKeys
      ? (await env.DB.prepare(`SELECT * FROM runtime_config WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY key`)
        .bind(...keys).all<RuntimeConfigRow>()).results
      : await listRuntimeConfig(env);
  } catch {
    return failedSnapshot('RUNTIME_CONFIG_READ_FAILED', keys);
  }

  snapshot.overrideCount = rows.length;
  for (const row of rows) {
    if (!keys.includes(row.key)) continue;
    snapshot.sources[row.key] = 'D1';
    snapshot.versions[row.key] = Number(row.version);
    try {
      const raw = row.value_kind === 'PLAIN'
        ? row.value_text
        : row.ciphertext && row.nonce
          ? await decryptRuntimeSecret(env.RUNTIME_CONFIG_MASTER_KEY || '', row.key, row.ciphertext, row.nonce)
          : null;
      if (raw === null) throw new Error('RUNTIME_CONFIG_MALFORMED_ROW');
      snapshot.values[row.key] = validateRuntimeValue(row.key, raw);
    } catch (error) {
      delete snapshot.values[row.key];
      const code = safeErrorCode(error);
      snapshot.errors[row.key] = code === 'INTERNAL_INVARIANT_VIOLATION'
        ? 'RUNTIME_CONFIG_VALUE_INVALID'
        : code;
      snapshot.health = 'ERROR';
    }
  }
  return snapshot;
}

export function applyRuntimeConfigSnapshot(env: Env, snapshot: RuntimeConfigSnapshot): Env {
  const effective = { ...env, runtimeConfigSnapshot: snapshot } as Env;
  for (const [key, envKey] of Object.entries(ENV_KEY_MAP) as [RuntimeConfigKey, keyof Env][]) {
    if (snapshot.sources[key] === 'D1') {
      (effective as any)[envKey] = snapshot.values[key] ?? '';
    }
  }

  if (snapshot.sources.TELEGRAM_SUPPORT_PROFILE === 'D1') {
    const raw = snapshot.values.TELEGRAM_SUPPORT_PROFILE;
    if (!raw) {
      effective.TELEGRAM_BOT_TOKEN = '';
      effective.TELEGRAM_WEBHOOK_SECRET = '';
      effective.TELEGRAM_SECRET_PATH = '';
    } else {
      const profile = parseTelegramSupportProfile(raw);
      effective.TELEGRAM_BOT_TOKEN = profile.bot_token;
      effective.TELEGRAM_WEBHOOK_SECRET = profile.webhook_secret;
      effective.TELEGRAM_SECRET_PATH = profile.webhook_path;
    }
  }
  return effective;
}

export async function resolveEffectiveEnv(env: Env): Promise<Env> {
  return applyRuntimeConfigSnapshot(env, await loadRuntimeConfigSnapshot(env));
}

export async function resolveUploadEnv(env: Env): Promise<Env> {
  return applyRuntimeConfigSnapshot(env, await loadRuntimeConfigSnapshot(env, UPLOAD_RUNTIME_KEYS));
}

export function runtimeSource(snapshot: RuntimeConfigSnapshot | undefined, key: RuntimeConfigKey): RuntimeValueSource {
  return snapshot?.sources[key] || 'ENV';
}

export function maskSecret(value: string | undefined): string {
  if (!value) return '未配置';
  return `${'*'.repeat(12)}${value.slice(-4)}`;
}
