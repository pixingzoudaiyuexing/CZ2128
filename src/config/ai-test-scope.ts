import { Env } from './env';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ALLOWLIST_ENTRIES = 100;
const MAX_ALLOWLIST_BYTES = 4096;

export type AiTestScope =
  | { mode: 'OFF'; allowsAll: true }
  | { mode: 'ALLOWLIST'; allowsAll: false; conversationIds: ReadonlySet<string> }
  | { mode: 'INVALID'; allowsAll: false; reason: string };

export function getAiTestScope(
  env: Pick<Env, 'AI_TEST_SCOPE_ENABLED' | 'AI_TEST_ALLOWED_CONVERSATION_IDS'>
): AiTestScope {
  const enabled = env.AI_TEST_SCOPE_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') {
    return { mode: 'OFF', allowsAll: true };
  }
  if (enabled !== 'true') {
    return { mode: 'INVALID', allowsAll: false, reason: 'INVALID_ENABLE_FLAG' };
  }

  const raw = env.AI_TEST_ALLOWED_CONVERSATION_IDS;
  if (!raw || new TextEncoder().encode(raw).length > MAX_ALLOWLIST_BYTES) {
    return { mode: 'INVALID', allowsAll: false, reason: 'ALLOWLIST_MISSING_OR_TOO_LARGE' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode: 'INVALID', allowsAll: false, reason: 'ALLOWLIST_INVALID_JSON' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ALLOWLIST_ENTRIES) {
    return { mode: 'INVALID', allowsAll: false, reason: 'ALLOWLIST_INVALID_SIZE' };
  }
  if (!parsed.every(value => typeof value === 'string' && UUID_PATTERN.test(value))) {
    return { mode: 'INVALID', allowsAll: false, reason: 'ALLOWLIST_INVALID_CONVERSATION_ID' };
  }

  const conversationIds = new Set(parsed);
  if (conversationIds.size !== parsed.length) {
    return { mode: 'INVALID', allowsAll: false, reason: 'ALLOWLIST_DUPLICATE_CONVERSATION_ID' };
  }
  return { mode: 'ALLOWLIST', allowsAll: false, conversationIds };
}

export function isAiConversationAllowed(
  env: Pick<Env, 'AI_TEST_SCOPE_ENABLED' | 'AI_TEST_ALLOWED_CONVERSATION_IDS'>,
  conversationId: string
): boolean {
  const scope = getAiTestScope(env);
  return scope.allowsAll || (scope.mode === 'ALLOWLIST' && scope.conversationIds.has(conversationId));
}
