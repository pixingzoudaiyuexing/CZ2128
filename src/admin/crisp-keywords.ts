import {
  CRISP_KEYWORD_RULES_MAX_COUNT,
  CrispKeywordRulesConfig,
  emptyCrispKeywordRules,
  generateCrispKeywordRuleId,
  normalizeCrispKeyword,
  parseCrispKeywordRules,
  sanitizeCrispKeyword,
  sanitizeCrispKeywordReply,
  serializeCrispKeywordRules
} from '../config/crisp-keywords';
import { Env } from '../config/env';
import { SafeError } from '../core/errors';
import { clearAdminSession, getAdminSession, saveAdminSession } from '../runtime-config/repository';
import { setPlainOverride } from '../runtime-config/service';
import { AdminSessionRow } from '../runtime-config/types';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';

const CONFIG_KEY = 'CRISP_KEYWORD_RULES' as const;

function configState(env: Env): { config: CrispKeywordRulesConfig; version: number } {
  const snapshot = env.runtimeConfigSnapshot;
  if (snapshot?.errors.RUNTIME_CONFIG || snapshot?.errors.CRISP_KEYWORD_RULES) {
    throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
  const raw = snapshot?.values.CRISP_KEYWORD_RULES;
  const version = Number(snapshot?.versions.CRISP_KEYWORD_RULES || 0);
  if (!raw) {
    if (version !== 0) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    return { config: emptyCrispKeywordRules(), version: 0 };
  }
  const config = parseCrispKeywordRules(raw);
  if (!config || !Number.isSafeInteger(version) || version < 1) {
    throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
  return { config, version };
}

async function send(
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  text: string,
  keyboard?: AdminKeyboard
): Promise<void> {
  await sendAdminMessage(bootstrap.token, ctx.chatId, text, keyboard);
}

function displayKeyword(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}

function findRule(config: CrispKeywordRulesConfig, ruleId: string) {
  const rule = config.rules.find(item => item.id === ruleId);
  if (!rule) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  return rule;
}

function ensureUniqueKeyword(config: CrispKeywordRulesConfig, keyword: string, excludingId?: string): void {
  const normalized = normalizeCrispKeyword(keyword);
  if (config.rules.some(rule => rule.id !== excludingId && normalizeCrispKeyword(rule.keyword) === normalized)) {
    throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
}

async function persist(
  env: Env,
  config: CrispKeywordRulesConfig,
  expectedVersion: number,
  ctx: AdminContext
): Promise<number> {
  let value: string;
  try {
    value = serializeCrispKeywordRules(config);
  } catch {
    throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
  return setPlainOverride(env, CONFIG_KEY, value, expectedVersion, ctx.userId, ctx.updateId);
}

export async function showKeywordRulesPage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext
): Promise<void> {
  let state;
  try {
    state = configState(env);
  } catch {
    await send(bootstrap, ctx, '关键词回复配置当前不可用。功能将保持关闭，不影响人工客服链路。', [
      [{ text: '返回', callback_data: 'm' }]
    ]);
    return;
  }
  const enabled = state.config.rules.filter(rule => rule.enabled).length;
  const lines = state.config.rules.map((rule, index) =>
    `${index + 1}. ${rule.enabled ? '✅' : '⏸'} ${rule.keyword}`
  );
  const keyboard: AdminKeyboard = state.config.rules.map(rule => [{
    text: `${rule.enabled ? '✅' : '⏸'} ${displayKeyword(rule.keyword)}`,
    callback_data: `k:v:${rule.id}`
  }]);
  if (state.config.rules.length < CRISP_KEYWORD_RULES_MAX_COUNT) {
    keyboard.push([{ text: '➕ 添加规则', callback_data: 'k:add' }]);
  }
  keyboard.push([{ text: '返回', callback_data: 'm' }]);
  await send(
    bootstrap,
    ctx,
    `Crisp 关键词自动回复\n\n规则：${state.config.rules.length}/${CRISP_KEYWORD_RULES_MAX_COUNT}，启用：${enabled}\n\n` +
      (lines.join('\n') || '当前没有规则。未配置规则时不会产生关键词自动回复。'),
    keyboard
  );
}

async function showRule(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  ruleId: string
): Promise<void> {
  const { config } = configState(env);
  const rule = findRule(config, ruleId);
  const preview = rule.reply.length <= 1200 ? rule.reply : `${rule.reply.slice(0, 1197)}...`;
  await send(
    bootstrap,
    ctx,
    `状态：${rule.enabled ? '✅ 启用' : '⏸ 停用'}\n关键词：${rule.keyword}\n\n回复：\n${preview}`,
    [
      [{ text: '修改关键词', callback_data: `k:ek:${rule.id}` }, { text: '修改回复', callback_data: `k:er:${rule.id}` }],
      [{ text: rule.enabled ? '停用规则' : '启用规则', callback_data: `k:t:${rule.id}` }],
      [{ text: '🗑 删除规则', callback_data: `k:d:${rule.id}` }],
      [{ text: '返回规则列表', callback_data: 'p:kw' }]
    ]
  );
}

async function beginSession(
  env: Env,
  ctx: AdminContext,
  action: string,
  version: number,
  context: Record<string, unknown> | null = null,
  candidateValue: string | null = null
): Promise<void> {
  await saveAdminSession(env, {
    admin_user_id: ctx.userId,
    action,
    target: CONFIG_KEY,
    expected_version: version,
    candidate_value_text: candidateValue,
    candidate_ciphertext: null,
    candidate_nonce: null,
    context_json: context ? JSON.stringify(context) : null
  });
}

function sessionRuleId(session: AdminSessionRow): string {
  let parsed: any;
  try {
    parsed = JSON.parse(session.context_json || '{}');
  } catch {
    throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
  if (typeof parsed?.ruleId !== 'string' || !/^kw_[a-z0-9]{16}$/.test(parsed.ruleId)) {
    throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
  return parsed.ruleId;
}

export async function processCrispKeywordCallback(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  action: string
): Promise<string> {
  if (action === 'dn') {
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, '已取消删除。', [[{ text: '返回规则列表', callback_data: 'p:kw' }]]);
    return 'KEYWORD_DELETE_CANCEL';
  }
  const { config, version } = configState(env);
  if (action === 'add') {
    if (config.rules.length >= CRISP_KEYWORD_RULES_MAX_COUNT) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    await beginSession(env, ctx, 'KEYWORD_ADD_KEYWORD', version);
    await send(bootstrap, ctx, '请输入新规则的关键词。匹配方式为：首尾去空白、英文字母忽略大小写、其余字符精确匹配。');
    return 'KEYWORD_ADD_BEGIN';
  }

  const view = /^v:(kw_[a-z0-9]{16})$/.exec(action);
  if (view) {
    await showRule(env, bootstrap, ctx, view[1]);
    return 'KEYWORD_VIEW';
  }

  const editKeyword = /^ek:(kw_[a-z0-9]{16})$/.exec(action);
  if (editKeyword) {
    findRule(config, editKeyword[1]);
    await beginSession(env, ctx, 'KEYWORD_EDIT_KEYWORD', version, { ruleId: editKeyword[1] });
    await send(bootstrap, ctx, '请输入新的关键词。');
    return 'KEYWORD_EDIT_KEYWORD_BEGIN';
  }

  const editReply = /^er:(kw_[a-z0-9]{16})$/.exec(action);
  if (editReply) {
    findRule(config, editReply[1]);
    await beginSession(env, ctx, 'KEYWORD_EDIT_REPLY', version, { ruleId: editReply[1] });
    await send(bootstrap, ctx, '请输入新的自动回复文字。');
    return 'KEYWORD_EDIT_REPLY_BEGIN';
  }

  const toggle = /^t:(kw_[a-z0-9]{16})$/.exec(action);
  if (toggle) {
    const rule = findRule(config, toggle[1]);
    const next = {
      ...config,
      rules: config.rules.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item)
    };
    await persist(env, next, version, ctx);
    await send(bootstrap, ctx, `规则已${rule.enabled ? '停用' : '启用'}：${rule.keyword}`, [
      [{ text: '返回规则列表', callback_data: 'p:kw' }]
    ]);
    return rule.enabled ? 'KEYWORD_DISABLED' : 'KEYWORD_ENABLED';
  }

  const remove = /^d:(kw_[a-z0-9]{16})$/.exec(action);
  if (remove) {
    const rule = findRule(config, remove[1]);
    await beginSession(env, ctx, 'KEYWORD_DELETE_CONFIRM', version, { ruleId: rule.id });
    await send(bootstrap, ctx, `确认删除关键词规则“${rule.keyword}”？删除后不可通过当前规则列表恢复。`, [[
      { text: '确认删除', callback_data: 'k:dy' },
      { text: '取消', callback_data: 'k:dn' }
    ]]);
    return 'KEYWORD_DELETE_BEGIN';
  }

  if (action === 'dy') {
    const session = await getAdminSession(env, ctx.userId);
    if (!session || session.action !== 'KEYWORD_DELETE_CONFIRM') throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    if (session.expected_version !== version) throw new SafeError('RUNTIME_CONFIG_VERSION_CONFLICT');
    const ruleId = sessionRuleId(session);
    const rule = findRule(config, ruleId);
    await persist(env, { ...config, rules: config.rules.filter(item => item.id !== ruleId) }, version, ctx);
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `已删除规则：${rule.keyword}`, [[{ text: '返回规则列表', callback_data: 'p:kw' }]]);
    return 'KEYWORD_DELETED';
  }

  throw new Error('UNKNOWN_ADMIN_ACTION');
}

export async function processCrispKeywordMessage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  session: AdminSessionRow
): Promise<string> {
  if (!ctx.text) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
  const { config, version } = configState(env);
  if (session.expected_version !== version) throw new SafeError('RUNTIME_CONFIG_VERSION_CONFLICT');

  if (session.action === 'KEYWORD_ADD_KEYWORD') {
    const keyword = sanitizeCrispKeyword(ctx.text);
    if (!keyword) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    ensureUniqueKeyword(config, keyword);
    await beginSession(env, ctx, 'KEYWORD_ADD_REPLY', version, null, keyword);
    await send(bootstrap, ctx, `关键词：${keyword}\n\n请输入对应的自动回复文字。`);
    return 'KEYWORD_ADD_KEYWORD';
  }

  if (session.action === 'KEYWORD_ADD_REPLY') {
    const keyword = sanitizeCrispKeyword(session.candidate_value_text || '');
    const reply = sanitizeCrispKeywordReply(ctx.text);
    if (!keyword || !reply || config.rules.length >= CRISP_KEYWORD_RULES_MAX_COUNT) {
      throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    }
    ensureUniqueKeyword(config, keyword);
    const next = {
      ...config,
      rules: [...config.rules, { id: generateCrispKeywordRuleId(), keyword, reply, enabled: true }]
    };
    await persist(env, next, version, ctx);
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `已添加并启用关键词规则：${keyword}`, [[{ text: '查看规则', callback_data: 'p:kw' }]]);
    return 'KEYWORD_ADDED';
  }

  if (session.action === 'KEYWORD_EDIT_KEYWORD') {
    const ruleId = sessionRuleId(session);
    const rule = findRule(config, ruleId);
    const keyword = sanitizeCrispKeyword(ctx.text);
    if (!keyword) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    ensureUniqueKeyword(config, keyword, ruleId);
    await persist(env, {
      ...config,
      rules: config.rules.map(item => item.id === ruleId ? { ...item, keyword } : item)
    }, version, ctx);
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `关键词已修改：${rule.keyword} → ${keyword}`, [[{ text: '返回规则列表', callback_data: 'p:kw' }]]);
    return 'KEYWORD_EDITED';
  }

  if (session.action === 'KEYWORD_EDIT_REPLY') {
    const ruleId = sessionRuleId(session);
    const rule = findRule(config, ruleId);
    const reply = sanitizeCrispKeywordReply(ctx.text);
    if (!reply) throw new SafeError('RUNTIME_CONFIG_VALUE_INVALID');
    await persist(env, {
      ...config,
      rules: config.rules.map(item => item.id === ruleId ? { ...item, reply } : item)
    }, version, ctx);
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `规则“${rule.keyword}”的回复已更新。`, [[{ text: '返回规则列表', callback_data: 'p:kw' }]]);
    return 'KEYWORD_REPLY_EDITED';
  }

  throw new Error('CONFIRMATION_REQUIRED');
}
