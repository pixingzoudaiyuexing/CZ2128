import { RuntimeConfigKey } from '../runtime-config/types';

export const CHATWOOT_ADMIN_DISABLED_MESSAGE =
  '当前仅支持 Crisp，旧 Chatwoot 配置入口已停用。历史记录仍会保留。';

const LEGACY_CHATWOOT_RUNTIME_KEYS = new Set<RuntimeConfigKey>([
  'CHATWOOT_API_URL',
  'CHATWOOT_API_TOKEN',
  'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS'
]);

export function isLegacyChatwootRuntimeKey(value: string): value is RuntimeConfigKey {
  return LEGACY_CHATWOOT_RUNTIME_KEYS.has(value as RuntimeConfigKey);
}
