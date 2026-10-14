import { Env } from '../config/env';
import { CRISP_QUIET_DEFAULT_MINUTES, CRISP_QUIET_KEY, parseCrispQuietMinutes } from '../config/crisp-quiet';
import {
  getAdminSession, getRuntimeConfig, getRuntimeHistory, latestRuntimeHistoryVersion,
  RuntimeConfigConflictError, saveAdminSession
} from '../runtime-config/repository';
import { restoreEnvOverride, rollbackOverride, setPlainOverride } from '../runtime-config/service';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';

const SELECT_ACTION = 'CRISP_QUIET_SELECT';
const INPUT_ACTION = 'CRISP_QUIET_INPUT';
interface QuietMeta { ref: string; historyVersion: number; rollbackId?: number }

function parseMeta(raw: string | null): QuietMeta | null {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value.ref !== 'string' || !/^[a-f0-9]{16}$/.test(value.ref) ||
        !Number.isSafeInteger(value.historyVersion) || value.historyVersion < 0) return null;
    return { ref: value.ref, historyVersion: value.historyVersion,
      rollbackId: Number.isSafeInteger(value.rollbackId) && value.rollbackId > 0 ? value.rollbackId : undefined };
  } catch { return null; }
}

async function send(bootstrap: AdminBootstrap, ctx: AdminContext, text: string, keyboard?: AdminKeyboard) {
  await sendAdminMessage(bootstrap.token, ctx.chatId, text, keyboard);
}

export async function clearQuietInput(env: Env, ctx: AdminContext): Promise<void> {
  await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id=? AND target=? AND action IN (?,?)')
    .bind(ctx.userId, CRISP_QUIET_KEY, SELECT_ACTION, INPUT_ACTION).run();
}

export async function showCrispQuietSetting(rawEnv: Env, bootstrap: AdminBootstrap, ctx: AdminContext): Promise<string> {
  const row = await getRuntimeConfig(rawEnv, CRISP_QUIET_KEY);
  const historyVersion = await latestRuntimeHistoryVersion(rawEnv, CRISP_QUIET_KEY);
  const raw = row ? (row.value_kind === 'PLAIN' ? row.value_text ?? undefined : undefined) : rawEnv[CRISP_QUIET_KEY];
  const parsed = parseCrispQuietMinutes(raw);
  const minutes = parsed ?? CRISP_QUIET_DEFAULT_MINUTES;
  const source = row ? 'D1' : raw?.trim() ? 'ENV' : '默认值';
  const meta: QuietMeta = { ref: crypto.randomUUID().replace(/-/g, '').slice(0, 16), historyVersion };
  await saveAdminSession(rawEnv, {
    admin_user_id: ctx.userId, action: SELECT_ACTION, target: CRISP_QUIET_KEY,
    expected_version: Number(row?.version || 0), candidate_value_text: null,
    candidate_ciphertext: null, candidate_nonce: null, context_json: JSON.stringify(meta)
  });
  const lines = [
    '🔕 Crisp 人工静默时间', '', `当前静默时间：${minutes} 分钟`, `配置来源：${source}`,
    `当前设置版本：${row ? `v${row.version}` : historyVersion ? `默认配置（历史 v${historyVersion}）` : '默认配置'}`,
    '', '从最后一次 Crisp 真人客服回复开始计时；每次真人回复重新计时。',
    '期间客户文字和附件静默进入原 Topic，Telegram 回复不会提前结束静默。',
    '到期恢复正常通知；独立的手动静默设置继续生效。', '此设置不改变 AI 人工暂停或自动恢复时间。',
    '', '点击快捷按钮立即保存，或输入 1–1440 分钟。'
  ];
  if (row && parsed === null || raw !== undefined && raw.trim() !== '' && parsed === null) {
    lines.push('', '当前配置无效，暂使用安全默认值 15 分钟，请重新设置。');
  }
  const quick = (value: number) => ({
    text: `${minutes === value ? '✅ ' : ''}${value} 分钟`, callback_data: `cq:s:${meta.ref}:${value}`
  });
  await send(bootstrap, ctx, lines.join('\n'), [
    [quick(5), quick(10), quick(15)], [quick(30), quick(60)],
    [{ text: '自定义分钟数', callback_data: `cq:i:${meta.ref}` }],
    [{ text: '恢复 ENV / 默认值', callback_data: `cq:r:${meta.ref}` }],
    [{ text: '操作历史 / 回滚', callback_data: 'p:hist' }],
    [{ text: '返回 Telegram 设置', callback_data: 'cq:b' }]
  ]);
  return 'CRISP_QUIET_PAGE';
}

async function expired(rawEnv: Env, bootstrap: AdminBootstrap, ctx: AdminContext): Promise<string> {
  const current = await rawEnv.DB.prepare('SELECT target FROM admin_sessions WHERE admin_user_id=?')
    .bind(ctx.userId).first<{ target: string }>();
  if (current && current.target !== CRISP_QUIET_KEY) {
    await send(bootstrap, ctx, '旧静默设置页面已失效，当前输入流程未改变。', [[
      { text: '重新打开 Crisp 人工静默时间', callback_data: 'cq:o' }
    ]]);
    return 'CRISP_QUIET_SESSION_EXPIRED';
  }
  await clearQuietInput(rawEnv, ctx);
  await send(bootstrap, ctx, '静默设置已过期或被其他操作更新，请重新选择。');
  await showCrispQuietSetting(rawEnv, bootstrap, ctx);
  return 'CRISP_QUIET_SESSION_EXPIRED';
}

export async function confirmCrispQuietRollback(rawEnv: Env, bootstrap: AdminBootstrap, ctx: AdminContext, historyId: number): Promise<string> {
  const history = await getRuntimeHistory(rawEnv, historyId);
  if (!history || history.key !== CRISP_QUIET_KEY) throw new Error('HISTORY_NOT_FOUND');
  const row = await getRuntimeConfig(rawEnv, CRISP_QUIET_KEY);
  const meta: QuietMeta = { ref: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    historyVersion: await latestRuntimeHistoryVersion(rawEnv, CRISP_QUIET_KEY), rollbackId: historyId };
  await saveAdminSession(rawEnv, { admin_user_id: ctx.userId, action: SELECT_ACTION, target: CRISP_QUIET_KEY,
    expected_version: row?.version || 0, candidate_value_text: null, candidate_ciphertext: null,
    candidate_nonce: null, context_json: JSON.stringify(meta) });
  await send(bootstrap, ctx, `确认将 Crisp 人工静默时间回滚到历史 v${history.version}？\n当前历史版本：v${meta.historyVersion}。回滚将创建新版本，AI 设置不变。`, [[
    { text: '确认回滚', callback_data: `cq:k:${meta.ref}` }, { text: '取消', callback_data: 'cq:c' }
  ]]);
  return 'CRISP_QUIET_ROLLBACK_CONFIRM';
}

async function change(
  rawEnv: Env, bootstrap: AdminBootstrap, ctx: AdminContext, value: string | null,
  expectedVersion: number, meta: QuietMeta
): Promise<string> {
  try {
    if (await latestRuntimeHistoryVersion(rawEnv, CRISP_QUIET_KEY) !== meta.historyVersion) throw new RuntimeConfigConflictError();
    if (value === null) {
      if (expectedVersion > 0) {
        await restoreEnvOverride(rawEnv, CRISP_QUIET_KEY, expectedVersion, ctx.userId, ctx.updateId);
      } else if (await getRuntimeConfig(rawEnv, CRISP_QUIET_KEY)) {
        throw new RuntimeConfigConflictError();
      }
    } else {
      await setPlainOverride(rawEnv, CRISP_QUIET_KEY, value, expectedVersion, ctx.userId, ctx.updateId, 'SET', {
        expectedHistoryVersion: meta.historyVersion
      });
    }
  } catch (error) {
    if (!(error instanceof RuntimeConfigConflictError)) throw error;
    return expired(rawEnv, bootstrap, ctx);
  }
  await clearQuietInput(rawEnv, ctx);
  await send(bootstrap, ctx, value === null ? '已恢复 ENV / 默认静默时间。' : `已保存：${value} 分钟。立即生效，AI 配置未改变。`);
  await showCrispQuietSetting(rawEnv, bootstrap, ctx);
  return value === null ? 'CRISP_QUIET_RESTORE' : 'CRISP_QUIET_SET';
}

export async function processCrispQuietCallback(rawEnv: Env, bootstrap: AdminBootstrap, ctx: AdminContext): Promise<string> {
  const data = ctx.callbackData || '';
  if (data === 'cq:o') return showCrispQuietSetting(rawEnv, bootstrap, ctx);
  if (data === 'cq:b') {
    await clearQuietInput(rawEnv, ctx);
    return 'CRISP_QUIET_BACK';
  }
  if (data === 'cq:c') {
    const session = await getAdminSession(rawEnv, ctx.userId);
    if (!session || session.target !== CRISP_QUIET_KEY ||
        ![SELECT_ACTION, INPUT_ACTION].includes(session.action)) return expired(rawEnv, bootstrap, ctx);
    await clearQuietInput(rawEnv, ctx);
    await send(bootstrap, ctx, '已取消，静默时间未修改。');
    await showCrispQuietSetting(rawEnv, bootstrap, ctx);
    return 'CRISP_QUIET_CANCEL';
  }
  const match = /^cq:([sirk]):([a-f0-9]{16})(?::(5|10|15|30|60))?$/.exec(data);
  const session = await getAdminSession(rawEnv, ctx.userId);
  const meta = parseMeta(session?.context_json || null);
  if (!match || !session || session.target !== CRISP_QUIET_KEY || session.action !== SELECT_ACTION ||
      !meta || match[2] !== meta.ref) return expired(rawEnv, bootstrap, ctx);
  if (match[1] === 'k' && !match[3] && meta.rollbackId) {
    try {
      await rollbackOverride(rawEnv, meta.rollbackId, session.expected_version, ctx.userId, ctx.updateId,
        { expectedHistoryVersion: meta.historyVersion });
    } catch (error) {
      if (!(error instanceof RuntimeConfigConflictError)) throw error;
      return expired(rawEnv, bootstrap, ctx);
    }
    await clearQuietInput(rawEnv, ctx);
    await send(bootstrap, ctx, '已作为新版本回滚静默时间。');
    await showCrispQuietSetting(rawEnv, bootstrap, ctx);
    return 'CRISP_QUIET_ROLLBACK';
  }
  if (meta.rollbackId) return expired(rawEnv, bootstrap, ctx);
  if (match[1] === 's' && match[3]) return change(rawEnv, bootstrap, ctx, match[3], session.expected_version, meta);
  if (match[1] === 'r' && !match[3]) return change(rawEnv, bootstrap, ctx, null, session.expected_version, meta);
  if (match[1] !== 'i' || match[3]) return expired(rawEnv, bootstrap, ctx);
  await saveAdminSession(rawEnv, { ...session, action: INPUT_ACTION });
  await send(bootstrap, ctx, '请输入 1–1440 的整数分钟。发送 /cancel 或点击取消可退出。', [
    [{ text: '取消', callback_data: 'cq:c' }, { text: '返回 Telegram 设置', callback_data: 'cq:b' }]
  ]);
  return 'CRISP_QUIET_INPUT_BEGIN';
}

export async function processCrispQuietMessage(rawEnv: Env, bootstrap: AdminBootstrap, ctx: AdminContext): Promise<string | null> {
  const row = await rawEnv.DB.prepare(
    'SELECT action FROM admin_sessions WHERE admin_user_id = ? AND target = ?'
  ).bind(ctx.userId, CRISP_QUIET_KEY).first<{ action: string }>();
  if (row?.action !== INPUT_ACTION && row?.action !== SELECT_ACTION) return null;
  if (ctx.text === '/cancel') {
    await clearQuietInput(rawEnv, ctx);
    await send(bootstrap, ctx, '已取消，静默时间未修改。');
    await showCrispQuietSetting(rawEnv, bootstrap, ctx);
    return 'CRISP_QUIET_CANCEL';
  }
  const session = await getAdminSession(rawEnv, ctx.userId);
  const meta = parseMeta(session?.context_json || null);
  if (!session || !meta) return expired(rawEnv, bootstrap, ctx);
  if (session.action !== INPUT_ACTION) {
    await send(bootstrap, ctx, '请使用快捷按钮，或先点击自定义分钟数。');
    return 'CRISP_QUIET_INPUT_NOT_ACTIVE';
  }
  const minutes = parseCrispQuietMinutes(ctx.text);
  if (minutes === null) {
    await send(bootstrap, ctx, '请输入 1–1440 的整数分钟，当前设置未改变。', [
      [{ text: '取消', callback_data: 'cq:c' }, { text: '返回 Telegram 设置', callback_data: 'cq:b' }]
    ]);
    return 'CRISP_QUIET_INPUT_INVALID';
  }
  return change(rawEnv, bootstrap, ctx, String(minutes), session.expected_version, meta);
}
