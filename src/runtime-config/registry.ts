import { ATTACHMENT_HARD_MAX_BYTES, ATTACHMENT_HARD_MAX_COUNT } from '../config/attachments';
import { RuntimeConfigKey, RuntimeValueKind, TelegramSupportProfile } from './types';

export class RuntimeConfigValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'RuntimeConfigValidationError';
  }
}

export interface RuntimeConfigDefinition {
  key: RuntimeConfigKey;
  kind: RuntimeValueKind;
  label: string;
  shortCode: string;
  rollback: 'GENERIC' | 'DEDICATED';
  highImpact: boolean;
  validate: (value: string) => string;
}

function boundedText(value: string, min: number, max: number, code: string): string {
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RuntimeConfigValidationError(code);
  return normalized;
}

function boundedInteger(value: string, min: number, max: number, code: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new RuntimeConfigValidationError(code);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RuntimeConfigValidationError(code);
  }
  return String(number);
}

function providerUrl(value: string, protocols: string[], httpsOnly: boolean): string {
  const normalized = boundedText(value, 1, 2048, 'INVALID_PROVIDER_URL');
  try {
    const url = new URL(normalized);
    if (
      !protocols.includes(url.protocol) ||
      (httpsOnly && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('invalid');
    }
    return normalized.replace(/\/+$/, '');
  } catch {
    throw new RuntimeConfigValidationError('INVALID_PROVIDER_URL');
  }
}

function allowedHosts(value: string): string {
  const entries = value.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.length > 32) throw new RuntimeConfigValidationError('INVALID_ALLOWED_HOSTS');
  const normalized: string[] = [];
  for (const entry of entries) {
    if (entry.length > 253 || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(entry) || entry.includes('..')) {
      throw new RuntimeConfigValidationError('INVALID_ALLOWED_HOSTS');
    }
    try {
      const url = new URL(`https://${entry}`);
      if (url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.')) {
        throw new Error('invalid');
      }
      normalized.push(url.host.toLowerCase());
    } catch {
      throw new RuntimeConfigValidationError('INVALID_ALLOWED_HOSTS');
    }
  }
  return [...new Set(normalized)].join(',');
}

function supportProfile(value: string): string {
  if (value.length > 8192) throw new RuntimeConfigValidationError('INVALID_TELEGRAM_PROFILE');
  let profile: TelegramSupportProfile;
  try {
    profile = JSON.parse(value);
  } catch {
    throw new RuntimeConfigValidationError('INVALID_TELEGRAM_PROFILE');
  }
  if (
    !profile ||
    typeof profile.bot_token !== 'string' || profile.bot_token.length < 20 || profile.bot_token.length > 256 || /\s/.test(profile.bot_token) ||
    typeof profile.webhook_secret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(profile.webhook_secret) ||
    typeof profile.webhook_path !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(profile.webhook_path) ||
    profile.webhook_secret === profile.webhook_path
  ) {
    throw new RuntimeConfigValidationError('INVALID_TELEGRAM_PROFILE');
  }
  return JSON.stringify({
    bot_token: profile.bot_token,
    webhook_secret: profile.webhook_secret,
    webhook_path: profile.webhook_path
  });
}

const definitions: RuntimeConfigDefinition[] = [
  { key: 'AI_BASE_URL', kind: 'PLAIN', label: 'AI API 地址', shortCode: 'ab', rollback: 'GENERIC', highImpact: false, validate: value => providerUrl(value, ['http:', 'https:'], false) },
  { key: 'AI_MODEL', kind: 'PLAIN', label: 'AI Model', shortCode: 'am', rollback: 'GENERIC', highImpact: false, validate: value => boundedText(value, 1, 256, 'INVALID_AI_MODEL') },
  { key: 'AI_API_KEY', kind: 'SECRET', label: 'AI API Key', shortCode: 'ak', rollback: 'GENERIC', highImpact: true, validate: value => boundedText(value, 1, 4096, 'INVALID_SECRET') },
  { key: 'AI_SYSTEM_PROMPT', kind: 'PLAIN', label: 'AI System Prompt', shortCode: 'ap', rollback: 'GENERIC', highImpact: false, validate: value => boundedText(value, 1, 20000, 'INVALID_SYSTEM_PROMPT') },
  { key: 'AI_REQUEST_TIMEOUT_MS', kind: 'PLAIN', label: 'AI 请求超时', shortCode: 'at', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 5000, 120000, 'INVALID_AI_TIMEOUT') },
  { key: 'AI_CONTEXT_MAX_MESSAGES', kind: 'PLAIN', label: 'AI 上下文消息数', shortCode: 'acm', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 1, 100, 'INVALID_AI_CONTEXT_MESSAGES') },
  { key: 'AI_CONTEXT_MAX_CHARS', kind: 'PLAIN', label: 'AI 上下文字符数', shortCode: 'acc', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 1000, 100000, 'INVALID_AI_CONTEXT_CHARS') },
  { key: 'AI_GENERATION_LEASE_SECONDS', kind: 'PLAIN', label: 'AI Generation Lease', shortCode: 'agl', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 10, 300, 'INVALID_AI_LEASE') },
  { key: 'AI_OPERATOR_PAUSE_TIMEOUT_SECONDS', kind: 'PLAIN', label: 'AI 人工暂停超时', shortCode: 'aop', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 60, 86400 * 30, 'INVALID_AI_PAUSE_TIMEOUT') },
  { key: 'TELEGRAM_SUPPORT_PROFILE', kind: 'SECRET', label: '客服 Telegram Bot', shortCode: 'tb', rollback: 'DEDICATED', highImpact: true, validate: supportProfile },
  { key: 'BOT_GROUP_ID', kind: 'PLAIN', label: '客服 Telegram 群', shortCode: 'tg', rollback: 'DEDICATED', highImpact: true, validate: value => {
    const normalized = value.trim();
    if (!/^-100\d{1,16}$/.test(normalized)) throw new RuntimeConfigValidationError('INVALID_TELEGRAM_GROUP');
    return normalized;
  } },
  { key: 'CHATWOOT_API_URL', kind: 'PLAIN', label: 'Chatwoot API 地址', shortCode: 'cu', rollback: 'GENERIC', highImpact: true, validate: value => providerUrl(value, ['https:'], true) },
  { key: 'CHATWOOT_API_TOKEN', kind: 'SECRET', label: 'Chatwoot API Token', shortCode: 'ct', rollback: 'GENERIC', highImpact: true, validate: value => boundedText(value, 1, 4096, 'INVALID_SECRET') },
  { key: 'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS', kind: 'PLAIN', label: 'Chatwoot 附件 Hosts', shortCode: 'ch', rollback: 'GENERIC', highImpact: false, validate: allowedHosts },
  { key: 'ATTACHMENT_MAX_BYTES', kind: 'PLAIN', label: '附件大小', shortCode: 'fb', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 1, ATTACHMENT_HARD_MAX_BYTES, 'INVALID_ATTACHMENT_SIZE') },
  { key: 'ATTACHMENT_MAX_COUNT_PER_MESSAGE', kind: 'PLAIN', label: '单消息附件数', shortCode: 'fc', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 1, ATTACHMENT_HARD_MAX_COUNT, 'INVALID_ATTACHMENT_COUNT') },
  { key: 'ATTACHMENT_TTL_SECONDS', kind: 'PLAIN', label: '附件 TTL', shortCode: 'ft', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 60, 86400, 'INVALID_ATTACHMENT_TTL') },
  { key: 'ATTACHMENT_SOURCE_TIMEOUT_MS', kind: 'PLAIN', label: '附件源超时', shortCode: 'fs', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 1000, 120000, 'INVALID_ATTACHMENT_TIMEOUT') },
  { key: 'ATTACHMENT_DESTINATION_TIMEOUT_MS', kind: 'PLAIN', label: '附件目标超时', shortCode: 'fd', rollback: 'GENERIC', highImpact: false, validate: value => boundedInteger(value, 1000, 120000, 'INVALID_ATTACHMENT_TIMEOUT') }
];

export const RUNTIME_CONFIG_REGISTRY = new Map(definitions.map(definition => [definition.key, definition]));
export const RUNTIME_CONFIG_SHORT_CODES = new Map(definitions.map(definition => [definition.shortCode, definition]));

export function getRuntimeConfigDefinition(key: string): RuntimeConfigDefinition {
  const definition = RUNTIME_CONFIG_REGISTRY.get(key as RuntimeConfigKey);
  if (!definition) throw new RuntimeConfigValidationError('UNKNOWN_CONFIG_KEY');
  return definition;
}

export function validateRuntimeValue(key: RuntimeConfigKey, value: string): string {
  return getRuntimeConfigDefinition(key).validate(value);
}

export function parseTelegramSupportProfile(value: string): TelegramSupportProfile {
  return JSON.parse(supportProfile(value));
}
