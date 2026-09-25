import { Env } from '../config/env';
import { encryptRuntimeSecret, decryptRuntimeSecret, generateOpaqueSecret, validateMasterKey } from '../runtime-config/crypto';
import { testAiCandidate } from '../runtime-config/candidate-validation';
import { getRuntimeConfigDefinition, parseTelegramSupportProfile, RUNTIME_CONFIG_SHORT_CODES, validateRuntimeValue } from '../runtime-config/registry';
import {
  claimAdminUpdate,
  clearAdminSession,
  completeAdminUpdate,
  getAdminSession,
  getRuntimeConfig,
  getRuntimeHistory,
  getRuntimeHistoryVersion,
  saveAdminSession
} from '../runtime-config/repository';
import { maskSecret, resolveEffectiveEnv } from '../runtime-config/resolver';
import {
  currentRuntimeVersion,
  migrateTelegramGroup,
  restoreEnvOverride,
  rollbackOverride,
  setPlainOverride,
  setSecretOverride
} from '../runtime-config/service';
import { RuntimeConfigKey } from '../runtime-config/types';
import {
  AdminProviderError,
  answerAdminCallback,
  deleteAdminInput,
  deleteSupportWebhook,
  setSupportWebhook,
  validateSupportBot
} from './telegram';
import { AdminBootstrap, AdminContext } from './types';
import { reply, showMain, showPage } from './ui';
import { processReliabilityCallback, processReliabilityMessage, showReliabilityMain } from './reliability';
import { processCrispKeywordCallback, processCrispKeywordMessage } from './crisp-keywords';
import { processKnowledgeCallback, processKnowledgeMessage } from './knowledge';
import { safeErrorCode } from '../core/errors';
import { CHATWOOT_ADMIN_DISABLED_MESSAGE, isLegacyChatwootRuntimeKey } from './platform-policy';
import { createCrispWelcomeConfig, resolveCrispWelcome } from '../config/crisp-welcome';
import { parseCrispMenu } from '../queue/crisp-handler';

function adminBootstrap(env: Env): AdminBootstrap | null {
  const token = env.ADMIN_TELEGRAM_BOT_TOKEN?.trim() || '';
  const path = env.ADMIN_TELEGRAM_SECRET_PATH?.trim() || '';
  const webhookSecret = env.ADMIN_TELEGRAM_WEBHOOK_SECRET?.trim() || '';
  const ids = (env.ADMIN_TELEGRAM_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (
    !token || !path || !webhookSecret || path === token ||
    path === webhookSecret ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(path) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(webhookSecret) ||
    ids.length === 0 || ids.some(id => !/^[1-9]\d{0,19}$/.test(id))
  ) return null;
  return { token, path, webhookSecret, userIds: new Set(ids), mode: 'LEGACY' };
}

function unifiedAdminBootstrap(rawEnv: Env, effectiveEnv: Env): AdminBootstrap | null {
  const token = effectiveEnv.TELEGRAM_BOT_TOKEN?.trim() || '';
  const ids = (rawEnv.ADMIN_TELEGRAM_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!token || ids.length === 0 || ids.some(id => !/^[1-9]\d{0,19}$/.test(id))) return null;
  return {
    token,
    path: effectiveEnv.TELEGRAM_SECRET_PATH?.trim() || '',
    webhookSecret: effectiveEnv.TELEGRAM_WEBHOOK_SECRET?.trim() || '',
    userIds: new Set(ids),
    mode: 'UNIFIED'
  };
}

function parseAdminContext(payload: any): AdminContext | null {
  if (!Number.isSafeInteger(payload?.update_id) || payload.update_id < 0) return null;
  if (payload.callback_query) {
    const callback = payload.callback_query;
    const chat = callback.message?.chat;
    if (!Number.isSafeInteger(callback.from?.id) || callback.from.id <= 0 || chat?.type !== 'private') return null;
    return {
      updateId: String(payload.update_id),
      userId: String(callback.from.id),
      chatId: String(chat.id),
      callbackId: typeof callback.id === 'string' ? callback.id : undefined,
      callbackData: typeof callback.data === 'string' && callback.data.length <= 64 ? callback.data : undefined
    };
  }
  const message = payload.message;
  if (
    !message || message.chat?.type !== 'private' ||
    !Number.isSafeInteger(message.from?.id) || message.from.id <= 0 ||
    !Number.isSafeInteger(message.message_id)
  ) return null;
  return {
    updateId: String(payload.update_id),
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    messageId: message.message_id,
    text: typeof message.text === 'string' && message.text.length <= 20000 ? message.text : undefined
  };
}

type BotRetirementCategory = 'OLD_SUPPORT' | 'LEGACY_ADMIN';

interface BotRetirementContext {
  previousSupportVersion: number;
  pending: BotRetirementCategory[];
}

function assertRotationCandidateDistinct(
  rawEnv: Env,
  effectiveEnv: Env,
  bootstrap: AdminBootstrap,
  candidateToken: string
): void {
  const existingTokens = new Set([
    effectiveEnv.TELEGRAM_BOT_TOKEN?.trim(),
    bootstrap.token?.trim(),
    rawEnv.ADMIN_TELEGRAM_BOT_TOKEN?.trim()
  ].filter((value): value is string => !!value));
  if (existingTokens.has(candidateToken)) throw new Error('ADMIN_SUPPORT_BOT_MUST_DIFFER');
}

async function priorSupportToken(rawEnv: Env, previousSupportVersion: number): Promise<string | null> {
  if (previousSupportVersion === 0) return rawEnv.TELEGRAM_BOT_TOKEN?.trim() || null;
  const history = await getRuntimeHistoryVersion(rawEnv, 'TELEGRAM_SUPPORT_PROFILE', previousSupportVersion);
  if (!history || history.value_kind !== 'SECRET' || !history.ciphertext || !history.nonce) {
    throw new Error('HISTORY_SECRET_INVALID');
  }
  const plaintext = await decryptRuntimeSecret(
    rawEnv.RUNTIME_CONFIG_MASTER_KEY || '',
    'TELEGRAM_SUPPORT_PROFILE',
    history.ciphertext,
    history.nonce
  );
  return parseTelegramSupportProfile(plaintext).bot_token;
}

async function retireOldBotWebhooks(
  newToken: string,
  oldSupportToken: string | null | undefined,
  legacyAdminToken: string | null | undefined,
  only: BotRetirementCategory[] = ['OLD_SUPPORT', 'LEGACY_ADMIN']
): Promise<BotRetirementCategory[]> {
  const requested = new Set(only);
  const grouped = new Map<string, Set<BotRetirementCategory>>();
  const add = (category: BotRetirementCategory, token: string | null | undefined) => {
    const normalized = token?.trim();
    if (!requested.has(category) || !normalized || normalized === newToken) return;
    const categories = grouped.get(normalized) || new Set<BotRetirementCategory>();
    categories.add(category);
    grouped.set(normalized, categories);
  };
  add('OLD_SUPPORT', oldSupportToken);
  add('LEGACY_ADMIN', legacyAdminToken);

  const failed = new Set<BotRetirementCategory>();
  for (const [token, categories] of grouped) {
    try {
      await deleteSupportWebhook(token);
    } catch {
      for (const category of categories) failed.add(category);
    }
  }
  return [...failed];
}

function retirementFailureText(pending: BotRetirementCategory[]): string {
  const labels = pending.map(category => category === 'OLD_SUPPORT' ? '旧客服 Bot webhook' : '旧 Admin Bot webhook');
  return [
    '新 Bot 已激活，但旧 Bot webhook 退役未完全成功。',
    `待重试：${labels.join('、')}`,
    '当前新 Bot profile 保持权威，不会回滚，也不会重新执行 Bot 轮换。',
    '如当前 Bot 已停用，请直接到新 Bot 发送 /start 后重试。'
  ].join('\n');
}

async function saveRetirementRetrySession(
  env: Env,
  ctx: AdminContext,
  activeVersion: number,
  previousSupportVersion: number,
  pending: BotRetirementCategory[]
): Promise<void> {
  await saveAdminSession(env, {
    admin_user_id: ctx.userId,
    action: 'RETIRE_BOT_WEBHOOKS',
    target: 'TELEGRAM_SUPPORT_PROFILE',
    expected_version: activeVersion,
    candidate_value_text: null,
    candidate_ciphertext: null,
    candidate_nonce: null,
    context_json: JSON.stringify({ previousSupportVersion, pending })
  }, 86400);
}

async function retryBotRetirement(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext
): Promise<string> {
  const session = await getAdminSession(env, ctx.userId);
  if (!session || session.action !== 'RETIRE_BOT_WEBHOOKS') throw new Error('CONFIRMATION_SESSION_MISSING');
  const currentVersion = await currentRuntimeVersion(rawEnv, 'TELEGRAM_SUPPORT_PROFILE');
  if (currentVersion !== session.expected_version) throw new Error('RUNTIME_CONFIG_VERSION_CONFLICT');
  const parsed = JSON.parse(session.context_json || '{}') as Partial<BotRetirementContext>;
  const previousSupportVersion = Number(parsed.previousSupportVersion);
  const pending = Array.isArray(parsed.pending)
    ? parsed.pending.filter((value): value is BotRetirementCategory => value === 'OLD_SUPPORT' || value === 'LEGACY_ADMIN')
    : [];
  if (!Number.isSafeInteger(previousSupportVersion) || previousSupportVersion < 0 || pending.length === 0) {
    throw new Error('CONFIRMATION_INVALID');
  }

  const oldSupportToken = await priorSupportToken(rawEnv, previousSupportVersion);
  const failed = await retireOldBotWebhooks(
    env.TELEGRAM_BOT_TOKEN || '',
    oldSupportToken,
    rawEnv.ADMIN_TELEGRAM_BOT_TOKEN,
    pending
  );
  if (failed.length > 0) {
    await saveRetirementRetrySession(rawEnv, ctx, session.expected_version, previousSupportVersion, failed);
    await reply(bootstrap, ctx, retirementFailureText(failed), [[
      { text: '重试旧 Bot Webhook 退役', callback_data: 't:trr' }
    ]]);
    return 'BOT_ROTATION_RETIREMENT_INCOMPLETE';
  }

  await clearAdminSession(rawEnv, ctx.userId);
  await reply(bootstrap, ctx, '旧 Bot webhook 退役已完成；当前仅新 Bot 接收 CZ2128 Telegram 更新。');
  return 'BOT_ROTATION_RETIREMENT_COMPLETE';
}

async function beginEdit(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, code: string): Promise<string> {
  if (code === 'cw') {
    const menu = parseCrispMenu(env.CRISP_MENU_JSON);
    const welcome = resolveCrispWelcome(env, menu?.welcome);
    const expectedVersion = welcome.source === 'D1'
      ? Number(env.runtimeConfigSnapshot?.versions.CRISP_WELCOME_CONFIG || 0)
      : 0;
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'CRISP_WELCOME_SET', target: 'CRISP_WELCOME_CONFIG',
      expected_version: expectedVersion,
      candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null,
      context_json: JSON.stringify({ enabled: welcome.status !== 'DISABLED' && welcome.status !== 'ERROR' })
    });
    await reply(bootstrap, ctx, '请发送新的 Crisp 欢迎语正文（1–4000 字符）。');
    return 'CRISP_WELCOME_SET_BEGIN';
  }
  if (code === 'tbot') {
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'ROTATE_BOT', target: 'TELEGRAM_SUPPORT_PROFILE',
      expected_version: await currentRuntimeVersion(env, 'TELEGRAM_SUPPORT_PROFILE'),
      candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null, context_json: null
    });
    await reply(bootstrap, ctx, '请发送新的客服 Bot Token。输入消息会在处理后尝试删除。');
    return 'ROTATE_BOT_BEGIN';
  }
  if (code === 'tgroup') {
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'MIGRATE_GROUP', target: 'BOT_GROUP_ID',
      expected_version: await currentRuntimeVersion(env, 'BOT_GROUP_ID'),
      candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null, context_json: null
    });
    await reply(bootstrap, ctx, '请发送目标 forum supergroup ID。');
    return 'MIGRATE_GROUP_BEGIN';
  }
  const definition = RUNTIME_CONFIG_SHORT_CODES.get(code);
  if (!definition || definition.rollback === 'DEDICATED') throw new Error('UNKNOWN_ADMIN_ACTION');
  if (isLegacyChatwootRuntimeKey(definition.key)) {
    await clearAdminSession(env, ctx.userId);
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE);
    return 'CHATWOOT_ADMIN_DISABLED';
  }
  await saveAdminSession(env, {
    admin_user_id: ctx.userId, action: 'SET', target: definition.key,
    expected_version: await currentRuntimeVersion(env, definition.key),
    candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null, context_json: null
  });
  await reply(bootstrap, ctx, `请发送新的 ${definition.label}${definition.kind === 'SECRET' ? '。输入消息会在处理后尝试删除。' : '。'}`);
  return `SET_BEGIN_${definition.key}`;
}

async function beginRestore(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, code: string): Promise<string> {
  const definition = RUNTIME_CONFIG_SHORT_CODES.get(code);
  if (!definition || definition.rollback === 'DEDICATED') throw new Error('DEDICATED_WORKFLOW_REQUIRED');
  if (isLegacyChatwootRuntimeKey(definition.key)) {
    await clearAdminSession(env, ctx.userId);
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE);
    return 'CHATWOOT_ADMIN_DISABLED';
  }
  const current = await getRuntimeConfig(env, definition.key);
  if (!current) {
    await reply(bootstrap, ctx, '当前已经使用 ENV。');
    return `RESTORE_NOOP_${definition.key}`;
  }
  if (definition.highImpact) {
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'CONFIRM_RESTORE', target: definition.key,
      expected_version: current.version,
      candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null, context_json: null
    });
    await reply(bootstrap, ctx, `确认移除 ${definition.label} 的 D1 覆盖配置并恢复 ENV？`, [[
      { text: '确认', callback_data: 'c:yes' }, { text: '取消', callback_data: 'c:no' }
    ]]);
    return `RESTORE_CONFIRM_${definition.key}`;
  }
  await restoreEnvOverride(env, definition.key, current.version, ctx.userId, ctx.updateId);
  await reply(bootstrap, ctx, `${definition.label} 已恢复 ENV。`);
  return `RESTORE_${definition.key}`;
}

async function beginRollback(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, rawId: string): Promise<string> {
  if (!/^\d{1,12}$/.test(rawId)) throw new Error('INVALID_HISTORY_ID');
  const history = await getRuntimeHistory(env, Number(rawId));
  if (!history) throw new Error('HISTORY_NOT_FOUND');
  if (isLegacyChatwootRuntimeKey(history.key)) {
    await clearAdminSession(env, ctx.userId);
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE);
    return 'CHATWOOT_ADMIN_DISABLED';
  }
  const definition = getRuntimeConfigDefinition(history.key);
  if (definition.rollback === 'DEDICATED') throw new Error('DEDICATED_WORKFLOW_REQUIRED');
  const expectedVersion = await currentRuntimeVersion(env, history.key);
  if (definition.highImpact) {
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'CONFIRM_ROLLBACK', target: history.key,
      expected_version: expectedVersion,
      candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null,
      context_json: JSON.stringify({ historyId: history.id })
    });
    await reply(bootstrap, ctx, `确认将 ${definition.label} 作为新版本回滚到 v${history.version}？`, [[
      { text: '确认', callback_data: 'c:yes' }, { text: '取消', callback_data: 'c:no' }
    ]]);
    return `ROLLBACK_CONFIRM_${history.key}`;
  }
  await rollbackOverride(env, history.id, expectedVersion, ctx.userId, ctx.updateId);
  await reply(bootstrap, ctx, `${definition.label} 已作为新版本回滚。`);
  return `ROLLBACK_${history.key}`;
}

async function processSetInput(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  session: Awaited<ReturnType<typeof getAdminSession>>
): Promise<string> {
  if (!session || !ctx.text) throw new Error('ADMIN_INPUT_INVALID');
  const key = session.target as RuntimeConfigKey;
  if (isLegacyChatwootRuntimeKey(key)) {
    if (key === 'CHATWOOT_API_TOKEN' && ctx.messageId !== undefined) {
      try { await deleteAdminInput(bootstrap.token, ctx.chatId, ctx.messageId); } catch { /* fail closed; no config write */ }
    }
    await clearAdminSession(env, ctx.userId);
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE);
    return 'CHATWOOT_ADMIN_DISABLED';
  }
  const definition = getRuntimeConfigDefinition(key);
  const secretInput = definition.kind === 'SECRET';
  const deleted = secretInput && ctx.messageId !== undefined
    ? await deleteAdminInput(bootstrap.token, ctx.chatId, ctx.messageId)
    : true;
  const normalized = validateRuntimeValue(key, ctx.text);
  let validationNote = '';
  if (key === 'AI_BASE_URL' || key === 'AI_MODEL' || key === 'AI_API_KEY') {
    try {
      await testAiCandidate(env, { [key]: normalized });
    } catch (error) {
      if (safeErrorCode(error) !== 'AI_CONFIG_INCOMPLETE') throw error;
      validationNote = '\nAI Provider 测试未执行：AI_CONFIG_INCOMPLETE。Provider 配置完整前，AI 保持未启用。';
    }
  }
  if (secretInput) {
    await setSecretOverride(env, key, normalized, session.expected_version, ctx.userId, ctx.updateId);
  } else {
    await setPlainOverride(env, key, normalized, session.expected_version, ctx.userId, ctx.updateId);
  }
  await clearAdminSession(env, ctx.userId);
  await reply(bootstrap, ctx,
    `${definition.label} 已更新${secretInput ? `：${maskSecret(normalized)}` : ''}.` +
    validationNote +
    (!deleted ? '\n密钥已保存，但 Telegram 中的原输入消息未能自动删除，请手动删除该消息。' : '')
  );
  return `SET_${key}`;
}

async function processCrispWelcomeInput(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  session: Awaited<ReturnType<typeof getAdminSession>>
): Promise<string> {
  if (!session || !ctx.text) throw new Error('ADMIN_INPUT_INVALID');
  const state = JSON.parse(session.context_json || '{}') as { enabled?: boolean };
  const value = createCrispWelcomeConfig(ctx.text, state.enabled !== false);
  await setPlainOverride(
    env,
    'CRISP_WELCOME_CONFIG',
    value,
    session.expected_version,
    ctx.userId,
    ctx.updateId
  );
  await clearAdminSession(env, ctx.userId);
  await reply(bootstrap, ctx, `欢迎语已保存，当前状态：${state.enabled === false ? '已停用' : '已启用'}。`);
  return 'CRISP_WELCOME_SET';
}

async function setCrispWelcomeEnabled(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  enabled: boolean
): Promise<string> {
  const menu = parseCrispMenu(env.CRISP_MENU_JSON);
  const welcome = resolveCrispWelcome(env, menu?.welcome);
  if (!welcome.text) {
    await reply(bootstrap, ctx, welcome.status === 'ERROR'
      ? '欢迎语配置读取异常，已保持自动发送关闭。请先重新设置欢迎语。'
      : '欢迎语未配置，请先设置欢迎语。');
    return enabled ? 'CRISP_WELCOME_ENABLE_NOOP' : 'CRISP_WELCOME_DISABLE_NOOP';
  }
  const expectedVersion = welcome.source === 'D1'
    ? Number(env.runtimeConfigSnapshot?.versions.CRISP_WELCOME_CONFIG || 0)
    : 0;
  await setPlainOverride(
    env,
    'CRISP_WELCOME_CONFIG',
    createCrispWelcomeConfig(welcome.text, enabled),
    expectedVersion,
    ctx.userId,
    ctx.updateId
  );
  await reply(bootstrap, ctx, enabled ? '欢迎语已启用。' : '欢迎语已停用。');
  return enabled ? 'CRISP_WELCOME_ENABLED' : 'CRISP_WELCOME_DISABLED';
}

async function processBotToken(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  expectedVersion: number
): Promise<string> {
  if (!ctx.text || ctx.messageId === undefined) throw new Error('ADMIN_INPUT_INVALID');
  const token = ctx.text.trim();
  assertRotationCandidateDistinct(rawEnv, env, bootstrap, token);
  const deleted = await deleteAdminInput(bootstrap.token, ctx.chatId, ctx.messageId);
  const groupId = env.BOT_GROUP_ID || undefined;
  const bot = await validateSupportBot(token, groupId);
  const encrypted = await encryptRuntimeSecret(
    env.RUNTIME_CONFIG_MASTER_KEY || '',
    'TELEGRAM_SUPPORT_PROFILE',
    JSON.stringify({ bot_token: token })
  );
  await saveAdminSession(env, {
    admin_user_id: ctx.userId, action: 'CONFIRM_BOT', target: 'TELEGRAM_SUPPORT_PROFILE',
    expected_version: expectedVersion, candidate_value_text: null,
    candidate_ciphertext: encrypted.ciphertext, candidate_nonce: encrypted.nonce,
    context_json: JSON.stringify({ username: bot.username?.slice(0, 64) || '已验证', deleteFailed: !deleted })
  });
  await reply(bootstrap, ctx,
    `新客服 Bot 已验证：${bot.username ? `@${bot.username}` : '已验证'}。\n\n确认后：\n- 新 Bot 将立即接管后台和客服群\n- 当前客服 Bot webhook 将停用\n- 旧 Admin Bot webhook 将停用` +
    (!deleted ? '\n输入消息未能自动删除，请手动删除。' : ''),
    [[{ text: '确认轮换', callback_data: 'c:yes' }, { text: '取消', callback_data: 'c:no' }]]
  );
  return 'BOT_ROTATION_CONFIRM';
}

async function processGroupInput(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  expectedVersion: number
): Promise<string> {
  if (!ctx.text) throw new Error('ADMIN_INPUT_INVALID');
  const groupId = validateRuntimeValue('BOT_GROUP_ID', ctx.text);
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('SUPPORT_BOT_UNAVAILABLE');
  await validateSupportBot(env.TELEGRAM_BOT_TOKEN, groupId);
  await saveAdminSession(env, {
    admin_user_id: ctx.userId, action: 'CONFIRM_GROUP', target: 'BOT_GROUP_ID',
    expected_version: expectedVersion, candidate_value_text: groupId,
    candidate_ciphertext: null, candidate_nonce: null, context_json: null
  });
  await reply(bootstrap, ctx,
    `当前客服群：${env.BOT_GROUP_ID || '未配置'}\n\n目标客服群：${groupId}\n\n` +
    '现有 Topic 映射将被重置；旧 Telegram Topic 不会自动删除。',
    [[{ text: '确认迁移', callback_data: 'c:yes' }, { text: '取消', callback_data: 'c:no' }]]
  );
  return 'GROUP_MIGRATION_CONFIRM';
}

async function confirmSession(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  origin: string
): Promise<string> {
  const session = await getAdminSession(env, ctx.userId);
  if (!session || !session.action.startsWith('CONFIRM_')) throw new Error('CONFIRMATION_SESSION_MISSING');
  if (isLegacyChatwootRuntimeKey(session.target)) {
    await clearAdminSession(env, ctx.userId);
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE);
    return 'CHATWOOT_ADMIN_DISABLED';
  }
  if (session.action === 'CONFIRM_SET') {
    if (!session.candidate_value_text) throw new Error('CONFIRMATION_INVALID');
    await setPlainOverride(env, session.target as RuntimeConfigKey, session.candidate_value_text, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_RESTORE') {
    await restoreEnvOverride(env, session.target as RuntimeConfigKey, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_ROLLBACK') {
    const historyId = Number(JSON.parse(session.context_json || '{}').historyId);
    const history = await getRuntimeHistory(env, historyId);
    if (!history || isLegacyChatwootRuntimeKey(history.key)) {
      await clearAdminSession(env, ctx.userId);
      await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE);
      return 'CHATWOOT_ADMIN_DISABLED';
    }
    await rollbackOverride(env, historyId, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_GROUP') {
    if (!session.candidate_value_text) throw new Error('CONFIRMATION_INVALID');
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('SUPPORT_BOT_UNAVAILABLE');
    await validateSupportBot(env.TELEGRAM_BOT_TOKEN, session.candidate_value_text);
    await migrateTelegramGroup(env, session.candidate_value_text, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_BOT') {
    if (!session.candidate_ciphertext || !session.candidate_nonce) throw new Error('CONFIRMATION_INVALID');
    const candidateEnvelope = await decryptRuntimeSecret(
      rawEnv.RUNTIME_CONFIG_MASTER_KEY || '',
      'TELEGRAM_SUPPORT_PROFILE',
      session.candidate_ciphertext,
      session.candidate_nonce
    );
    let candidateToken = '';
    try {
      const parsed = JSON.parse(candidateEnvelope);
      candidateToken = typeof parsed?.bot_token === 'string' ? parsed.bot_token.trim() : '';
    } catch {
      throw new Error('CONFIRMATION_INVALID');
    }
    if (!candidateToken) throw new Error('CONFIRMATION_INVALID');
    assertRotationCandidateDistinct(rawEnv, env, bootstrap, candidateToken);
    await validateSupportBot(candidateToken, env.BOT_GROUP_ID || undefined);

    const webhookPath = generateOpaqueSecret(32);
    let webhookSecret = generateOpaqueSecret(32);
    while (webhookSecret === webhookPath) webhookSecret = generateOpaqueSecret(32);
    const profile = validateRuntimeValue('TELEGRAM_SUPPORT_PROFILE', JSON.stringify({
      bot_token: candidateToken,
      webhook_secret: webhookSecret,
      webhook_path: webhookPath
    }));
    await setSupportWebhook(
      candidateToken,
      `${origin}/webhooks/telegram/${webhookPath}`,
      webhookSecret
    );

    let activeVersion: number;
    try {
      activeVersion = await setSecretOverride(
        rawEnv, 'TELEGRAM_SUPPORT_PROFILE', profile, session.expected_version,
        ctx.userId, ctx.updateId, 'BOT_ROTATE'
      );
    } catch (error) {
      try { await deleteSupportWebhook(candidateToken); } catch { /* new inactive bot remains fail-safe */ }
      throw error;
    }

    const failed = await retireOldBotWebhooks(
      candidateToken,
      env.TELEGRAM_BOT_TOKEN,
      rawEnv.ADMIN_TELEGRAM_BOT_TOKEN
    );
    if (failed.length > 0) {
      await saveRetirementRetrySession(rawEnv, ctx, activeVersion, session.expected_version, failed);
      await reply(bootstrap, ctx, retirementFailureText(failed), [[
        { text: '重试旧 Bot Webhook 退役', callback_data: 't:trr' }
      ]]);
      return 'BOT_ROTATION_RETIREMENT_INCOMPLETE';
    }

    await clearAdminSession(rawEnv, ctx.userId);
    await reply(bootstrap, ctx, '轮换完成：新 Bot 已立即接管后台和客服群；旧客服 Bot 与旧 Admin Bot webhook 已停用。');
    return 'BOT_ROTATION_SUCCESS';
  } else {
    throw new Error('UNKNOWN_CONFIRMATION');
  }
  await clearAdminSession(env, ctx.userId);
  await reply(bootstrap, ctx, '操作已确认并完成。');
  return session.action;
}

async function processCallback(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  origin: string
): Promise<string> {
  const data = ctx.callbackData || '';
  if (ctx.callbackId) {
    try { await answerAdminCallback(bootstrap.token, ctx.callbackId); } catch { /* mutation remains authoritative */ }
  }
  if (data === 'm') { await showMain(bootstrap, ctx); return 'MAIN'; }
  if (/^p:(ai|air|tg|tgr|crisp|crispr|cwelcome|cmenu|cw|cwr|att|attr|sys|hist|rel|kw|kb)$/.test(data)) {
    const page = data.slice(2);
    await showPage(env, bootstrap, ctx, page);
    return `PAGE_${page.toUpperCase()}`;
  }
  if (data === 'w:on') return setCrispWelcomeEnabled(env, bootstrap, ctx, true);
  if (data === 'w:off') return setCrispWelcomeEnabled(env, bootstrap, ctx, false);
  if (data.startsWith('r:')) return await processReliabilityCallback(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('k:')) return await processCrispKeywordCallback(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('b:')) return await processKnowledgeCallback(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('e:')) return beginEdit(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('x:')) return beginRestore(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('rb:')) return beginRollback(env, bootstrap, ctx, data.slice(3));
  if (data === 't:tgw') {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_SECRET_PATH || !env.TELEGRAM_WEBHOOK_SECRET) {
      throw new Error('SUPPORT_BOT_UNAVAILABLE');
    }
    await setSupportWebhook(
      env.TELEGRAM_BOT_TOKEN,
      `${origin}/webhooks/telegram/${env.TELEGRAM_SECRET_PATH}`,
      env.TELEGRAM_WEBHOOK_SECRET,
      { dropPendingUpdates: false }
    );
    await reply(bootstrap, ctx, bootstrap.mode === 'UNIFIED'
      ? 'Bot Webhook 已刷新，私聊后台、客服消息与 AI 按钮回调均已启用。'
      : '客服 Bot Webhook 已刷新，消息与 AI 按钮回调均已启用。');
    return 'TELEGRAM_SUPPORT_WEBHOOK_REFRESH';
  }
  if (data === 't:trr') return retryBotRetirement(rawEnv, env, bootstrap, ctx);
  if (data === 't:ai') {
    await testAiCandidate(env);
    await reply(bootstrap, ctx, 'AI 健康检查通过。');
    return 'AI_TEST';
  }
  if (data === 'c:no') {
    await clearAdminSession(env, ctx.userId);
    await reply(bootstrap, ctx, '操作已取消。');
    return 'CONFIRM_CANCEL';
  }
  if (data === 'c:yes') return confirmSession(rawEnv, env, bootstrap, ctx, origin);
  throw new Error('UNKNOWN_ADMIN_ACTION');
}

async function processMessage(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext
): Promise<string> {
  if (ctx.text === '/start' || ctx.text === '/menu') {
    const pendingRetirement = await getAdminSession(env, ctx.userId);
    if (pendingRetirement?.action === 'RETIRE_BOT_WEBHOOKS') {
      await showMain(bootstrap, ctx);
      await reply(bootstrap, ctx, '检测到旧 Bot webhook 退役尚未完成。新 Bot 已保持 active，可直接重试剩余退役。', [[
        { text: '重试旧 Bot Webhook 退役', callback_data: 't:trr' }
      ]]);
      return 'MAIN_RETIREMENT_PENDING';
    }
    await clearAdminSession(env, ctx.userId);
    await showMain(bootstrap, ctx);
    return 'MAIN';
  }
  const session = await getAdminSession(env, ctx.userId);
  if (!session) {
    await showMain(bootstrap, ctx);
    return 'MAIN';
  }
  if (session.action === 'SET') return processSetInput(env, bootstrap, ctx, session);
  if (session.action === 'CRISP_WELCOME_SET') return processCrispWelcomeInput(env, bootstrap, ctx, session);
  if (session.action === 'ROTATE_BOT') {
    return processBotToken(rawEnv, env, bootstrap, ctx, session.expected_version);
  }
  if (session.action === 'MIGRATE_GROUP') return processGroupInput(env, bootstrap, ctx, session.expected_version);
  if (session.action.startsWith('KEYWORD_')) return await processCrispKeywordMessage(env, bootstrap, ctx, session);
  if (session.action.startsWith('KNOWLEDGE_')) return await processKnowledgeMessage(env, bootstrap, ctx, session);
  if (session.action.startsWith('RELIABILITY_')) return await processReliabilityMessage(env, bootstrap, ctx, session);
  throw new Error('CONFIRMATION_REQUIRED');
}

async function processAdminTelegramPayload(
  payload: any,
  rawEnv: Env,
  effectiveEnv: Env,
  bootstrap: AdminBootstrap,
  origin: string,
  rejectSharedIdentity = false
): Promise<Response> {
  const ctx = parseAdminContext(payload);
  if (!ctx || !bootstrap.userIds.has(ctx.userId)) return new Response('Accepted', { status: 200 });
  if (!await claimAdminUpdate(rawEnv, ctx.updateId, ctx.userId)) return new Response('Accepted', { status: 200 });

  let action = 'UNKNOWN';
  try {
    validateMasterKey(rawEnv.RUNTIME_CONFIG_MASTER_KEY);
    if (rejectSharedIdentity && effectiveEnv.TELEGRAM_BOT_TOKEN && effectiveEnv.TELEGRAM_BOT_TOKEN === bootstrap.token) {
      throw new Error('ADMIN_SUPPORT_BOT_MUST_DIFFER');
    }
    action = ctx.callbackData
      ? await processCallback(rawEnv, effectiveEnv, bootstrap, ctx, origin)
      : await processMessage(rawEnv, effectiveEnv, bootstrap, ctx);
    await completeAdminUpdate(rawEnv, ctx.updateId, action);
  } catch (error) {
    const code = safeErrorCode(error);
    await completeAdminUpdate(rawEnv, ctx.updateId, action, code);
    try { await reply(bootstrap, ctx, `操作失败：${code}`); } catch { /* webhook acknowledgement remains safe */ }
  }
  return new Response('Accepted', { status: 200 });
}

export async function handleAdminTelegramUpdate(
  payload: any,
  rawEnv: Env,
  effectiveEnv: Env,
  origin: string
): Promise<Response> {
  const bootstrap = unifiedAdminBootstrap(rawEnv, effectiveEnv);
  if (!bootstrap) return new Response('Accepted', { status: 200 });
  return processAdminTelegramPayload(payload, rawEnv, effectiveEnv, bootstrap, origin);
}

export async function handleAdminTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const bootstrap = adminBootstrap(env);
  if (!bootstrap) return new Response('Not Found', { status: 404 });
  const url = new URL(request.url);
  if (url.pathname !== `/webhooks/admin-telegram/${bootstrap.path}`) return new Response('Not Found', { status: 404 });
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== bootstrap.webhookSecret) {
    return new Response('Unauthorized', { status: 401 });
  }
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return new Response('Malformed update', { status: 400 });
  }
  const effectiveEnv = await resolveEffectiveEnv(env);
  return processAdminTelegramPayload(payload, env, effectiveEnv, bootstrap, url.origin, true);
}
