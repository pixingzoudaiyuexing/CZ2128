import {
  AIModelDiscoveryError,
  AIModelDiscoveryResult,
  listAvailableModels,
  normalizeModelDirectory
} from '../adapters/ai/model-discovery';
import { getAIConfig } from '../config/ai';
import { Env } from '../config/env';
import { safeErrorCode } from '../core/errors';
import {
  clearAdminSession,
  getAdminSession,
  latestRuntimeHistoryVersion,
  RuntimeConfigConflictError,
  saveAdminSession
} from '../runtime-config/repository';
import { currentRuntimeVersion, setPlainOverride } from '../runtime-config/service';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';

const PAGE_SIZE = 8;
const SESSION_TTL_SECONDS = 600;
const SESSION_MODELS_MAX_CHARS = 19000;

interface ModelSessionMeta {
  truncated: boolean;
  sessionBounded: boolean;
  historyVersion: number;
}

function modelButtonText(model: string, selected: boolean): string {
  const max = selected ? 54 : 56;
  const shortened = model.length > max ? `${model.slice(0, max - 1)}…` : model;
  return selected ? `✅ ${shortened}` : shortened;
}

function selectorActions(): AdminKeyboard {
  return [
    [{ text: '刷新模型列表', callback_data: 'am:r' }],
    [{ text: '⌨️ 手动输入模型', callback_data: 'e:am' }],
    [{ text: '返回 AI 设置', callback_data: 'p:ai' }]
  ];
}

function failureText(error: AIModelDiscoveryError): string {
  switch (error.reason) {
    case 'CONFIG_INCOMPLETE':
      return '请先配置 AI API 地址和 API Key。';
    case 'CREDENTIAL_REJECTED':
      return 'AI API 凭据被上游拒绝（401/403）。请检查 API Key 或其模型目录权限。';
    case 'UNSUPPORTED':
      return '上游不支持模型列表接口（404/405）。可以使用手动输入模型。';
    case 'RATE_LIMITED':
      return '上游模型列表请求被限流（429）。请稍后重试。';
    case 'UNAVAILABLE':
      return '上游模型服务暂时不可用（5xx）。请稍后重试。';
    case 'TIMEOUT':
      return '获取上游模型列表超时。请稍后重试或手动输入模型。';
    case 'TRANSPORT':
      return '无法连接上游模型服务。请检查网络或手动输入模型。';
    case 'REDIRECT_REJECTED':
      return '上游返回了重定向。为保护 API Key，模型发现不会跟随重定向。';
    case 'EMPTY':
      return '上游没有返回可用的模型 ID。可以使用手动输入模型。';
    case 'INVALID_RESPONSE':
      return '上游模型列表响应格式无效。可以使用手动输入模型。';
    case 'REJECTED':
      return error.httpStatus
        ? `上游拒绝模型列表请求（HTTP ${error.httpStatus}）。可以使用手动输入模型。`
        : '上游拒绝模型列表请求。可以使用手动输入模型。';
  }
}

function fitSessionModels(result: AIModelDiscoveryResult): AIModelDiscoveryResult & { sessionBounded: boolean } {
  const models: string[] = [];
  let sessionBounded = false;
  for (const model of result.models) {
    const candidate = JSON.stringify([...models, model]);
    if (candidate.length > SESSION_MODELS_MAX_CHARS) {
      sessionBounded = true;
      break;
    }
    models.push(model);
  }
  if (models.length === 0) throw new AIModelDiscoveryError('EMPTY');
  return { models, truncated: result.truncated || sessionBounded, sessionBounded };
}

function parseSessionModels(raw: string | null): string[] {
  if (!raw || raw.length > SESSION_MODELS_MAX_CHARS) throw new Error('AI_MODEL_SESSION_INVALID');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AI_MODEL_SESSION_INVALID');
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new Error('AI_MODEL_SESSION_INVALID');
  }
  const normalized = normalizeModelDirectory({ data: value.map(id => ({ id })) });
  if (
    normalized.truncated ||
    normalized.models.length !== value.length ||
    normalized.models.some((id, index) => id !== value[index])
  ) {
    throw new Error('AI_MODEL_SESSION_INVALID');
  }
  return normalized.models;
}

function parseSessionMeta(raw: string | null): ModelSessionMeta {
  if (!raw || raw.length > 512) throw new Error('AI_MODEL_SESSION_INVALID');
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.truncated !== 'boolean' ||
      typeof value.sessionBounded !== 'boolean' ||
      !Number.isSafeInteger(value.historyVersion) ||
      value.historyVersion < 0
    ) {
      throw new Error('invalid');
    }
    return {
      truncated: value.truncated,
      sessionBounded: value.sessionBounded,
      historyVersion: value.historyVersion
    };
  } catch {
    throw new Error('AI_MODEL_SESSION_INVALID');
  }
}

async function sendFailure(
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  error: AIModelDiscoveryError
): Promise<void> {
  await sendAdminMessage(
    bootstrap.token,
    ctx.chatId,
    failureText(error),
    selectorActions()
  );
}

async function renderSelector(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  models: string[],
  meta: ModelSessionMeta,
  page: number
): Promise<void> {
  const pageCount = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
    throw new Error('AI_MODEL_PAGE_INVALID');
  }
  const start = page * PAGE_SIZE;
  const pageModels = models.slice(start, start + PAGE_SIZE);
  const current = env.AI_MODEL?.trim() || '';
  const lines = [
    'AI 模型',
    '',
    `当前模型：${current || '未配置'}`,
    '',
    '上游可用模型：',
    ...pageModels.map((model, index) => `${start + index + 1}. ${model}`),
    '',
    `第 ${page + 1} / ${pageCount} 页`
  ];
  if (meta.truncated) {
    lines.push(
      '',
      meta.sessionBounded
        ? `模型 ID 较长，仅显示前 ${models.length} 个（最多 200 个）。`
        : '上游模型数量较多，仅显示前 200 个。'
    );
  }

  const keyboard: AdminKeyboard = pageModels.map((model, index) => [{
    text: modelButtonText(model, model === current),
    callback_data: `am:s:${start + index}`
  }]);
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) navigation.push({ text: '上一页', callback_data: `am:p:${page - 1}` });
  if (page + 1 < pageCount) navigation.push({ text: '下一页', callback_data: `am:p:${page + 1}` });
  if (navigation.length > 0) keyboard.push(navigation);
  keyboard.push(...selectorActions());

  await sendAdminMessage(bootstrap.token, ctx.chatId, lines.join('\n'), keyboard);
}

async function expired(
  bootstrap: AdminBootstrap,
  ctx: AdminContext
): Promise<string> {
  await sendAdminMessage(
    bootstrap.token,
    ctx.chatId,
    '模型列表已过期，请重新获取。',
    selectorActions()
  );
  return 'AI_MODEL_SESSION_EXPIRED';
}

export async function beginAIModelSelection(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext
): Promise<string> {
  const existing = await getAdminSession(rawEnv, ctx.userId);
  if (existing?.action === 'AI_MODEL_SELECT') {
    await clearAdminSession(rawEnv, ctx.userId);
  }

  let result: AIModelDiscoveryResult & { sessionBounded: boolean };
  try {
    const config = getAIConfig(env);
    result = fitSessionModels(await listAvailableModels({
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      timeoutMs: Math.min(config.requestTimeoutMs, 15000)
    }));
  } catch (error) {
    if (error instanceof AIModelDiscoveryError) {
      await sendFailure(bootstrap, ctx, error);
      return `AI_MODEL_DISCOVERY_${error.reason}`;
    }
    throw error;
  }

  const expectedVersion = await currentRuntimeVersion(rawEnv, 'AI_MODEL');
  const historyVersion = await latestRuntimeHistoryVersion(rawEnv, 'AI_MODEL');
  const meta: ModelSessionMeta = {
    truncated: result.truncated,
    sessionBounded: result.sessionBounded,
    historyVersion
  };
  await saveAdminSession(rawEnv, {
    admin_user_id: ctx.userId,
    action: 'AI_MODEL_SELECT',
    target: 'AI_MODEL',
    expected_version: expectedVersion,
    candidate_value_text: JSON.stringify(result.models),
    candidate_ciphertext: null,
    candidate_nonce: null,
    context_json: JSON.stringify(meta)
  }, SESSION_TTL_SECONDS);
  await renderSelector(env, bootstrap, ctx, result.models, meta, 0);
  return 'AI_MODEL_DISCOVERY';
}

async function selectModel(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  index: number
): Promise<string> {
  const session = await getAdminSession(rawEnv, ctx.userId);
  if (!session || session.action !== 'AI_MODEL_SELECT' || session.target !== 'AI_MODEL') {
    return expired(bootstrap, ctx);
  }
  const models = parseSessionModels(session.candidate_value_text);
  const meta = parseSessionMeta(session.context_json);
  if (!Number.isSafeInteger(index) || index < 0 || index >= models.length) {
    throw new Error('AI_MODEL_SELECTION_INVALID');
  }
  const model = models[index];
  const currentVersion = await currentRuntimeVersion(rawEnv, 'AI_MODEL');
  const currentHistoryVersion = await latestRuntimeHistoryVersion(rawEnv, 'AI_MODEL');
  if (currentVersion !== session.expected_version || currentHistoryVersion !== meta.historyVersion) {
    await clearAdminSession(rawEnv, ctx.userId);
    await sendAdminMessage(
      bootstrap.token,
      ctx.chatId,
      '模型配置已被其他操作更新，请重新获取模型列表。',
      selectorActions()
    );
    return 'AI_MODEL_VERSION_CONFLICT';
  }

  try {
    await setPlainOverride(
      rawEnv,
      'AI_MODEL',
      model,
      session.expected_version,
      ctx.userId,
      ctx.updateId,
      'SET',
      { expectedHistoryVersion: meta.historyVersion }
    );
  } catch (error) {
    if (error instanceof RuntimeConfigConflictError || safeErrorCode(error) === 'RUNTIME_CONFIG_VERSION_CONFLICT') {
      await clearAdminSession(rawEnv, ctx.userId);
      await sendAdminMessage(
        bootstrap.token,
        ctx.chatId,
        '模型配置已被其他操作更新，请重新获取模型列表。',
        selectorActions()
      );
      return 'AI_MODEL_VERSION_CONFLICT';
    }
    throw error;
  }

  await clearAdminSession(rawEnv, ctx.userId);
  await sendAdminMessage(
    bootstrap.token,
    ctx.chatId,
    [
      'AI 模型已更新：',
      model,
      '',
      '建议点击「测试 AI」验证当前 API 地址、API Key 和模型组合。'
    ].join('\n'),
    [
      [{ text: '测试 AI', callback_data: 't:ai' }],
      [{ text: '返回 AI 设置', callback_data: 'p:ai' }],
      [{ text: '再次修改模型', callback_data: 'am:r' }]
    ]
  );
  return 'AI_MODEL_SELECTED';
}

export async function processAIModelSelectorCallback(
  rawEnv: Env,
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  data: string
): Promise<string> {
  if (data === 'am:r') return beginAIModelSelection(rawEnv, env, bootstrap, ctx);

  const pageMatch = /^am:p:(\d{1,3})$/.exec(data);
  if (pageMatch) {
    const session = await getAdminSession(rawEnv, ctx.userId);
    if (!session || session.action !== 'AI_MODEL_SELECT' || session.target !== 'AI_MODEL') {
      return expired(bootstrap, ctx);
    }
    const models = parseSessionModels(session.candidate_value_text);
    const meta = parseSessionMeta(session.context_json);
    await renderSelector(env, bootstrap, ctx, models, meta, Number(pageMatch[1]));
    return 'AI_MODEL_PAGE';
  }

  const selectMatch = /^am:s:(\d{1,3})$/.exec(data);
  if (selectMatch) {
    return selectModel(rawEnv, env, bootstrap, ctx, Number(selectMatch[1]));
  }

  throw new Error('UNKNOWN_ADMIN_ACTION');
}
