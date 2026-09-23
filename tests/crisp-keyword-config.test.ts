import { describe, expect, it } from 'vitest';
import {
  CRISP_KEYWORD_MAX_LENGTH,
  CRISP_KEYWORD_REPLY_MAX_LENGTH,
  CRISP_KEYWORD_RULES_MAX_COUNT,
  findEnabledCrispKeywordRule,
  normalizeCrispKeyword,
  parseCrispKeywordRules
} from '../src/config/crisp-keywords';
import { validateRuntimeValue } from '../src/runtime-config/registry';

const rule = (id: number, keyword: string, reply = 'reply', enabled = true) => ({
  id: `kw_${String(id).padStart(16, '0')}`,
  keyword,
  reply,
  enabled
});

describe('Crisp keyword rule contract', () => {
  it('keeps an empty rule set inert', () => {
    const config = parseCrispKeywordRules(validateRuntimeValue(
      'CRISP_KEYWORD_RULES',
      JSON.stringify({ version: 1, rules: [] })
    ));
    expect(config?.rules).toEqual([]);
    expect(findEnabledCrispKeywordRule(config!, 'anything')).toBeNull();
  });

  it('matches Chinese exactly and rejects substring-only text', () => {
    const config = parseCrispKeywordRules(JSON.stringify({
      version: 1,
      rules: [rule(1, '续费', '请前往用户中心续费。')]
    }))!;
    expect(findEnabledCrispKeywordRule(config, '续费')?.reply).toContain('用户中心');
    expect(findEnabledCrispKeywordRule(config, '我想了解怎么续费')).toBeNull();
  });

  it('trims edges and folds ASCII English case only', () => {
    const config = parseCrispKeywordRules(JSON.stringify({
      version: 1,
      rules: [rule(1, 'Renew NOW')]
    }))!;
    expect(normalizeCrispKeyword('  RENEW now  ')).toBe('renew now');
    expect(findEnabledCrispKeywordRule(config, '  RENEW now  ')?.id).toBe(rule(1, '').id);
  });

  it('never matches disabled rules', () => {
    const config = parseCrispKeywordRules(JSON.stringify({
      version: 1,
      rules: [rule(1, '续费', 'reply', false)]
    }))!;
    expect(findEnabledCrispKeywordRule(config, '续费')).toBeNull();
  });

  it('rejects duplicate normalized keywords even when one is disabled', () => {
    expect(() => validateRuntimeValue('CRISP_KEYWORD_RULES', JSON.stringify({
      version: 1,
      rules: [rule(1, 'Renew'), rule(2, '  renew  ', 'other', false)]
    }))).toThrow('RUNTIME_CONFIG_VALUE_INVALID');
  });

  it('enforces rule count, keyword, reply and total runtime-config bounds', () => {
    expect(() => validateRuntimeValue('CRISP_KEYWORD_RULES', JSON.stringify({
      version: 1,
      rules: Array.from({ length: CRISP_KEYWORD_RULES_MAX_COUNT + 1 }, (_, index) => rule(index + 1, `k${index}`))
    }))).toThrow('RUNTIME_CONFIG_VALUE_INVALID');
    expect(() => validateRuntimeValue('CRISP_KEYWORD_RULES', JSON.stringify({
      version: 1, rules: [rule(1, 'x'.repeat(CRISP_KEYWORD_MAX_LENGTH + 1))]
    }))).toThrow('RUNTIME_CONFIG_VALUE_INVALID');
    expect(() => validateRuntimeValue('CRISP_KEYWORD_RULES', JSON.stringify({
      version: 1, rules: [rule(1, 'ok', 'x'.repeat(CRISP_KEYWORD_REPLY_MAX_LENGTH + 1))]
    }))).toThrow('RUNTIME_CONFIG_VALUE_INVALID');
  });
});
