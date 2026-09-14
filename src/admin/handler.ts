import { Env } from '../config/env';
import { encryptRuntimeSecret, decryptRuntimeSecret, generateOpaqueSecret, validateMasterKey } from '../runtime-config/crypto';
import { testAiCandidate, testChatwootCandidate } from '../runtime-config/candidate-validation';
import { getRuntimeConfigDefinition, parseTelegramSupportProfile, RUNTIME_CONFIG_SHORT_CODES, validateRuntimeValue } from '../runtime-config/registry';
import {
  claimAdminUpdate,
  clearAdminSession,
  completeAdminUpdate,
  getAdminSession,
  getRuntimeConfig,
  getRuntimeHistory,
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
import { safeErrorCode } from '../core/errors';

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
  return { token, path, webhookSecret, userIds: new Set(ids) };
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

async function beginEdit(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, code: string): Promise<string> {
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
    await reply(bootstrap, ctx, `确认移除 ${definition.label} 的 D1 override 并恢复 ENV？`, [[
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
      validationNote = '\nProvider test not performed: AI_CONFIG_INCOMPLETE. AI remains disabled until the provider profile is complete.';
    }
  }
  if (key === 'CHATWOOT_API_URL' || key === 'CHATWOOT_API_TOKEN') {
    await testChatwootCandidate(env, { [key]: normalized });
  }
  if (key === 'CHATWOOT_API_URL') {
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'CONFIRM_SET', target: key,
      expected_version: session.expected_version,
      candidate_value_text: normalized, candidate_ciphertext: null, candidate_nonce: null, context_json: null
    });
    await reply(bootstrap, ctx,
      '确认修改 Chatwoot API 地址？这不会自动重配外部 webhook 或签名 secret。',
      [[{ text: '确认', callback_data: 'c:yes' }, { text: '取消', callback_data: 'c:no' }]]
    );
    return 'SET_CONFIRM_CHATWOOT_API_URL';
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
    (!deleted ? '\nSecret was stored, but the Telegram source message could not be deleted. Please delete it manually.' : '')
  );
  return `SET_${key}`;
}

async function processBotToken(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  expectedVersion: number
): Promise<string> {
  if (!ctx.text || ctx.messageId === undefined) throw new Error('ADMIN_INPUT_INVALID');
  const deleted = await deleteAdminInput(bootstrap.token, ctx.chatId, ctx.messageId);
  const token = ctx.text.trim();
  if (token === bootstrap.token) throw new Error('ADMIN_SUPPORT_BOT_MUST_DIFFER');
  const groupId = env.BOT_GROUP_ID || undefined;
  const bot = await validateSupportBot(token, groupId);
  const webhookPath = generateOpaqueSecret(32);
  let webhookSecret = generateOpaqueSecret(32);
  while (webhookSecret === webhookPath) webhookSecret = generateOpaqueSecret(32);
  const profile = JSON.stringify({
    bot_token: token,
    webhook_secret: webhookSecret,
    webhook_path: webhookPath
  });
  const encrypted = await encryptRuntimeSecret(
    env.RUNTIME_CONFIG_MASTER_KEY || '', 'TELEGRAM_SUPPORT_PROFILE', validateRuntimeValue('TELEGRAM_SUPPORT_PROFILE', profile)
  );
  await saveAdminSession(env, {
    admin_user_id: ctx.userId, action: 'CONFIRM_BOT', target: 'TELEGRAM_SUPPORT_PROFILE',
    expected_version: expectedVersion, candidate_value_text: null,
    candidate_ciphertext: encrypted.ciphertext, candidate_nonce: encrypted.nonce,
    context_json: JSON.stringify({ username: bot.username?.slice(0, 64) || 'validated', deleteFailed: !deleted })
  });
  await reply(bootstrap, ctx,
    `新客服 Bot 已验证：${bot.username ? `@${bot.username}` : 'validated'}。确认轮换并创建全新 webhook identity？` +
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
    `Current Group: ${env.BOT_GROUP_ID || '未配置'}\n\nTarget Group: ${groupId}\n\n` +
    'Existing topic mappings will be reset. Old Telegram topics will NOT be deleted automatically.',
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
  let completionWarning = '';
  if (session.action === 'CONFIRM_SET') {
    if (!session.candidate_value_text) throw new Error('CONFIRMATION_INVALID');
    await setPlainOverride(env, session.target as RuntimeConfigKey, session.candidate_value_text, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_RESTORE') {
    await restoreEnvOverride(env, session.target as RuntimeConfigKey, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_ROLLBACK') {
    const historyId = Number(JSON.parse(session.context_json || '{}').historyId);
    await rollbackOverride(env, historyId, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_GROUP') {
    if (!session.candidate_value_text) throw new Error('CONFIRMATION_INVALID');
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('SUPPORT_BOT_UNAVAILABLE');
    await validateSupportBot(env.TELEGRAM_BOT_TOKEN, session.candidate_value_text);
    await migrateTelegramGroup(env, session.candidate_value_text, session.expected_version, ctx.userId, ctx.updateId);
  } else if (session.action === 'CONFIRM_BOT') {
    if (!session.candidate_ciphertext || !session.candidate_nonce) throw new Error('CONFIRMATION_INVALID');
    const plaintext = await decryptRuntimeSecret(
      rawEnv.RUNTIME_CONFIG_MASTER_KEY || '',
      'TELEGRAM_SUPPORT_PROFILE',
      session.candidate_ciphertext,
      session.candidate_nonce
    );
    const profile = parseTelegramSupportProfile(plaintext);
    await validateSupportBot(profile.bot_token, env.BOT_GROUP_ID || undefined);
    await setSupportWebhook(
      profile.bot_token,
      `${origin}/webhooks/telegram/${profile.webhook_path}`,
      profile.webhook_secret
    );
    try {
      await setSecretOverride(
        rawEnv, 'TELEGRAM_SUPPORT_PROFILE', plaintext, session.expected_version,
        ctx.userId, ctx.updateId, 'BOT_ROTATE'
      );
    } catch (error) {
      try { await deleteSupportWebhook(profile.bot_token); } catch { /* new inactive bot remains fail-safe */ }
      throw error;
    }
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== profile.bot_token) {
      try {
        await deleteSupportWebhook(env.TELEGRAM_BOT_TOKEN);
      } catch {
        completionWarning = '\n新客服 Bot 已启用，但旧 Bot webhook 未能删除；旧 webhook identity 已失效。';
      }
    }
  } else {
    throw new Error('UNKNOWN_CONFIRMATION');
  }
  await clearAdminSession(env, ctx.userId);
  await reply(bootstrap, ctx, `操作已确认并完成。${completionWarning}`);
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
  if (/^p:(ai|air|tg|cw|cwr|att|attr|sys|hist)$/.test(data)) {
    const page = data.slice(2);
    await showPage(env, bootstrap, ctx, page);
    return `PAGE_${page.toUpperCase()}`;
  }
  if (data.startsWith('e:')) return beginEdit(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('x:')) return beginRestore(env, bootstrap, ctx, data.slice(2));
  if (data.startsWith('rb:')) return beginRollback(env, bootstrap, ctx, data.slice(3));
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
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext
): Promise<string> {
  if (ctx.text === '/start' || ctx.text === '/menu') {
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
  if (session.action === 'ROTATE_BOT') return processBotToken(env, bootstrap, ctx, session.expected_version);
  if (session.action === 'MIGRATE_GROUP') return processGroupInput(env, bootstrap, ctx, session.expected_version);
  throw new Error('CONFIRMATION_REQUIRED');
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
  const ctx = parseAdminContext(payload);
  if (!ctx || !bootstrap.userIds.has(ctx.userId)) return new Response('Accepted', { status: 200 });
  if (!await claimAdminUpdate(env, ctx.updateId, ctx.userId)) return new Response('Accepted', { status: 200 });

  let action = 'UNKNOWN';
  try {
    validateMasterKey(env.RUNTIME_CONFIG_MASTER_KEY);
    const effectiveEnv = await resolveEffectiveEnv(env);
    if (effectiveEnv.TELEGRAM_BOT_TOKEN && effectiveEnv.TELEGRAM_BOT_TOKEN === bootstrap.token) {
      throw new Error('ADMIN_SUPPORT_BOT_MUST_DIFFER');
    }
    action = ctx.callbackData
      ? await processCallback(env, effectiveEnv, bootstrap, ctx, url.origin)
      : await processMessage(effectiveEnv, bootstrap, ctx);
    await completeAdminUpdate(env, ctx.updateId, action);
  } catch (error) {
    const code = safeErrorCode(error);
    await completeAdminUpdate(env, ctx.updateId, action, code);
    try { await reply(bootstrap, ctx, `操作失败：${code}`); } catch { /* webhook acknowledgement remains safe */ }
  }
  return new Response('Accepted', { status: 200 });
}
