export const CRISP_KEYWORD_RULES_MAX_COUNT = 100;
export const CRISP_KEYWORD_MAX_LENGTH = 128;
export const CRISP_KEYWORD_REPLY_MAX_LENGTH = 4000;
export const CRISP_KEYWORD_CONFIG_MAX_LENGTH = 500_000;

const RULE_ID_PATTERN = /^kw_[a-z0-9]{16}$/;
const KEYWORD_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const REPLY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface CrispKeywordRule {
  id: string;
  keyword: string;
  reply: string;
  enabled: boolean;
}

export interface CrispKeywordRulesConfig {
  version: 1;
  rules: CrispKeywordRule[];
}

export function normalizeCrispKeyword(value: string): string {
  return value.trim().replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function validKeyword(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 &&
    trimmed.length <= CRISP_KEYWORD_MAX_LENGTH &&
    !KEYWORD_CONTROL_PATTERN.test(trimmed);
}

function validReply(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length >= 1 &&
    normalized.length <= CRISP_KEYWORD_REPLY_MAX_LENGTH &&
    !REPLY_CONTROL_PATTERN.test(normalized);
}

export function sanitizeCrispKeyword(value: string): string | null {
  return validKeyword(value) ? value.trim() : null;
}

export function sanitizeCrispKeywordReply(value: string): string | null {
  return validReply(value) ? value.replace(/\r\n?/g, '\n').trim() : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

export function parseCrispKeywordRules(value: string | undefined): CrispKeywordRulesConfig | null {
  if (!value || value.length > CRISP_KEYWORD_CONFIG_MAX_LENGTH) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    if (!exactKeys(root, ['version', 'rules']) || root.version !== 1 || !Array.isArray(root.rules)) return null;
    if (root.rules.length > CRISP_KEYWORD_RULES_MAX_COUNT) return null;

    const rules: CrispKeywordRule[] = [];
    const normalizedKeywords = new Set<string>();
    const ids = new Set<string>();
    for (const rawRule of root.rules) {
      if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) return null;
      const rule = rawRule as Record<string, unknown>;
      if (!exactKeys(rule, ['id', 'keyword', 'reply', 'enabled'])) return null;
      if (typeof rule.id !== 'string' || !RULE_ID_PATTERN.test(rule.id) || ids.has(rule.id)) return null;
      if (!validKeyword(rule.keyword) || !validReply(rule.reply) || typeof rule.enabled !== 'boolean') return null;
      const keyword = rule.keyword.trim();
      const reply = rule.reply.replace(/\r\n?/g, '\n').trim();
      const normalizedKeyword = normalizeCrispKeyword(keyword);
      if (normalizedKeywords.has(normalizedKeyword)) return null;
      normalizedKeywords.add(normalizedKeyword);
      ids.add(rule.id);
      rules.push({ id: rule.id, keyword, reply, enabled: rule.enabled });
    }
    return { version: 1, rules };
  } catch {
    return null;
  }
}

export function canonicalizeCrispKeywordRules(value: string): string | null {
  const parsed = parseCrispKeywordRules(value);
  if (!parsed) return null;
  const canonical = JSON.stringify(parsed);
  return canonical.length <= CRISP_KEYWORD_CONFIG_MAX_LENGTH ? canonical : null;
}

export function serializeCrispKeywordRules(config: CrispKeywordRulesConfig): string {
  const canonical = canonicalizeCrispKeywordRules(JSON.stringify(config));
  if (!canonical) throw new Error('INVALID_CRISP_KEYWORD_RULES');
  return canonical;
}

export function emptyCrispKeywordRules(): CrispKeywordRulesConfig {
  return { version: 1, rules: [] };
}

export function generateCrispKeywordRuleId(): string {
  return `kw_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function findEnabledCrispKeywordRule(
  config: CrispKeywordRulesConfig,
  customerText: string
): CrispKeywordRule | null {
  const normalized = normalizeCrispKeyword(customerText);
  if (!normalized) return null;
  return config.rules.find(rule => rule.enabled && normalizeCrispKeyword(rule.keyword) === normalized) || null;
}
