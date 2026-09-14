export const RUNTIME_CONFIG_KEYS = [
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_API_KEY',
  'AI_SYSTEM_PROMPT',
  'AI_REQUEST_TIMEOUT_MS',
  'AI_CONTEXT_MAX_MESSAGES',
  'AI_CONTEXT_MAX_CHARS',
  'AI_GENERATION_LEASE_SECONDS',
  'AI_OPERATOR_PAUSE_TIMEOUT_SECONDS',
  'TELEGRAM_SUPPORT_PROFILE',
  'BOT_GROUP_ID',
  'CHATWOOT_API_URL',
  'CHATWOOT_API_TOKEN',
  'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS',
  'ATTACHMENT_MAX_BYTES',
  'ATTACHMENT_MAX_COUNT_PER_MESSAGE',
  'ATTACHMENT_TTL_SECONDS',
  'ATTACHMENT_SOURCE_TIMEOUT_MS',
  'ATTACHMENT_DESTINATION_TIMEOUT_MS'
] as const;

export type RuntimeConfigKey = typeof RUNTIME_CONFIG_KEYS[number];
export type RuntimeValueKind = 'PLAIN' | 'SECRET';
export type RuntimeValueSource = 'ENV' | 'D1';
export type RuntimeConfigAction = 'SET' | 'RESTORE_ENV' | 'ROLLBACK' | 'BOT_ROTATE' | 'GROUP_MIGRATION';

export interface RuntimeConfigRow {
  key: RuntimeConfigKey;
  value_kind: RuntimeValueKind;
  value_text: string | null;
  ciphertext: string | null;
  nonce: string | null;
  version: number;
  updated_by: string;
  updated_at: number;
}

export interface RuntimeConfigHistoryRow {
  id: number;
  key: RuntimeConfigKey;
  version: number;
  value_kind: RuntimeValueKind;
  value_text: string | null;
  ciphertext: string | null;
  nonce: string | null;
  is_deleted: number;
  actor_user_id: string;
  action: RuntimeConfigAction;
  source_update_id: string;
  created_at: number;
}

export interface TelegramSupportProfile {
  bot_token: string;
  webhook_secret: string;
  webhook_path: string;
}

export interface RuntimeConfigSnapshot {
  values: Partial<Record<RuntimeConfigKey, string>>;
  sources: Record<RuntimeConfigKey, RuntimeValueSource>;
  versions: Partial<Record<RuntimeConfigKey, number>>;
  errors: Partial<Record<RuntimeConfigKey | 'RUNTIME_CONFIG', SafeErrorCode>>;
  overrideCount: number;
  health: 'AVAILABLE' | 'ERROR';
}

export interface AdminSessionRow {
  admin_user_id: string;
  action: string;
  target: string;
  expected_version: number;
  candidate_value_text: string | null;
  candidate_ciphertext: string | null;
  candidate_nonce: string | null;
  context_json: string | null;
  expires_at: number;
  updated_at: number;
}
import { SafeErrorCode } from '../core/error-taxonomy';
