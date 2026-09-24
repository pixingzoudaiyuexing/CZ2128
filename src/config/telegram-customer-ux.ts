import { Env } from './env';
import { Conversation } from '../core/domain';

export type TelegramNotifyMode = 'normal' | 'silent';

export interface TelegramCustomerUxOptions {
  version: 1;
  disableNotification: boolean;
  controls?: 'AI_TOGGLE_V1';
}

function configuredNotifyMode(env: Env, key: 'TELEGRAM_NOTIFY_CRISP_OPERATOR' | 'TELEGRAM_NOTIFY_TELEGRAM_OPERATOR' | 'TELEGRAM_NOTIFY_MANUAL_OFF', fallback: TelegramNotifyMode): TelegramNotifyMode {
  const snapshot = env.runtimeConfigSnapshot;
  if (snapshot?.errors[key]) return 'silent';
  const value = snapshot?.values[key] ?? env[key];
  if (value === 'normal' || value === 'silent') return value;
  if (typeof value === 'string' && value.trim() !== '') return 'silent';
  return fallback;
}

export function customerNotificationMode(env: Env, conversation: Conversation): TelegramNotifyMode {
  if (conversation.ai_mode === 'ENABLED') return 'normal';
  if (conversation.ai_mode === 'PAUSED_MANUAL' || conversation.ai_pause_source === 'MANUAL') {
    return configuredNotifyMode(env, 'TELEGRAM_NOTIFY_MANUAL_OFF', 'silent');
  }
  if (conversation.ai_pause_source === 'CRISP_OPERATOR') {
    return configuredNotifyMode(env, 'TELEGRAM_NOTIFY_CRISP_OPERATOR', 'silent');
  }
  if (conversation.ai_pause_source === 'TELEGRAM_OPERATOR') {
    return configuredNotifyMode(env, 'TELEGRAM_NOTIFY_TELEGRAM_OPERATOR', 'normal');
  }
  return 'normal';
}

export function telegramCustomerRequestOptions(
  env: Env,
  conversation: Conversation,
  controls = true
): TelegramCustomerUxOptions {
  return {
    version: 1,
    disableNotification: customerNotificationMode(env, conversation) === 'silent',
    ...(controls ? { controls: 'AI_TOGGLE_V1' as const } : {})
  };
}

export function parseTelegramCustomerRequestOptions(value: string | null | undefined): TelegramCustomerUxOptions | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.disableNotification !== 'boolean' ||
      (parsed.controls !== undefined && parsed.controls !== 'AI_TOGGLE_V1')
    ) return null;
    const keys = Object.keys(parsed).sort().join(',');
    if (keys !== 'disableNotification,version' && keys !== 'controls,disableNotification,version') return null;
    return {
      version: 1,
      disableNotification: parsed.disableNotification,
      ...(parsed.controls === 'AI_TOGGLE_V1' ? { controls: 'AI_TOGGLE_V1' as const } : {})
    };
  } catch {
    return null;
  }
}
