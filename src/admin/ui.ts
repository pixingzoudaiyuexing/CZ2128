import { Env } from '../config/env';
import { getRuntimeConfigDefinition } from '../runtime-config/registry';
import { listRuntimeHistory } from '../runtime-config/repository';
import { maskSecret, runtimeSource } from '../runtime-config/resolver';
import { RuntimeConfigKey } from '../runtime-config/types';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';
import { showKeywordRulesPage } from './crisp-keywords';
import { parseCrispKeywordRules } from '../config/crisp-keywords';
import { CHATWOOT_ADMIN_DISABLED_MESSAGE, isLegacyChatwootRuntimeKey } from './platform-policy';

const mainKeyboard: AdminKeyboard = [
  [{ text: '🤖 AI 设置', callback_data: 'p:ai' }, { text: '💬 Telegram 设置', callback_data: 'p:tg' }],
  [{ text: '🔵 Crisp 设置', callback_data: 'p:crisp' }, { text: '📎 附件设置', callback_data: 'p:att' }],
  [{ text: '💡 关键词回复', callback_data: 'p:kw' }, { text: '🛡 可靠性管理', callback_data: 'p:rel' }],
  [{ text: '⚙️ 系统状态', callback_data: 'p:sys' }, { text: '📜 操作历史', callback_data: 'p:hist' }]
];

export async function reply(
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  text: string,
  keyboard?: AdminKeyboard
): Promise<void> {
  await sendAdminMessage(bootstrap.token, ctx.chatId, text, keyboard);
}

function valueLine(env: Env, key: RuntimeConfigKey, masked = false): string {
  const snapshot = env.runtimeConfigSnapshot;
  const raw = snapshot?.values[key];
  const value = masked ? maskSecret(raw) : raw || '未配置';
  return `${getRuntimeConfigDefinition(key).label}:\n${value}\n配置来源：${runtimeSource(snapshot, key)}`;
}

function configured(value: string | undefined): string {
  return value?.trim() ? '已配置' : '未配置';
}

export async function showMain(bootstrap: AdminBootstrap, ctx: AdminContext): Promise<void> {
  await reply(bootstrap, ctx, 'CZ2128 控制中心', mainKeyboard);
}

import { showReliabilityMain } from './reliability';

export async function showPage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  page: string
): Promise<void> {
  const edit = (text: string, code: string) => ({ text, callback_data: `e:${code}` });
  if (page === 'rel') {
    await showReliabilityMain(env, bootstrap, ctx);
    return;
  }
  if (page === 'kw') {
    await showKeywordRulesPage(env, bootstrap, ctx);
    return;
  }
  if (page === 'ai') {
    await reply(bootstrap, ctx, [
      'AI 设置',
      '',
      valueLine(env, 'AI_BASE_URL'), valueLine(env, 'AI_MODEL'), valueLine(env, 'AI_API_KEY', true),
      valueLine(env, 'AI_REQUEST_TIMEOUT_MS'), valueLine(env, 'AI_CONTEXT_MAX_MESSAGES'),
      valueLine(env, 'AI_CONTEXT_MAX_CHARS'), valueLine(env, 'AI_GENERATION_LEASE_SECONDS'),
      valueLine(env, 'AI_OPERATOR_PAUSE_TIMEOUT_SECONDS')
    ].join('\n\n'), [
      [edit('修改 API 地址', 'ab'), edit('修改模型', 'am')],
      [edit('修改 API Key', 'ak'), edit('修改系统提示词', 'ap')],
      [edit('请求超时', 'at'), edit('上下文消息数', 'acm')],
      [edit('上下文字符数', 'acc'), edit('生成租约', 'agl')],
      [edit('人工暂停超时', 'aop'), { text: '测试 AI', callback_data: 't:ai' }],
      [{ text: '恢复 ENV 默认值', callback_data: 'p:air' }, { text: '历史 / 回滚', callback_data: 'p:hist' }],
      [{ text: '返回', callback_data: 'm' }]
    ]);
    return;
  }
  if (page === 'air') {
    await reply(bootstrap, ctx, '选择要移除的 AI D1 覆盖配置：', [
      [{ text: 'API 地址', callback_data: 'x:ab' }, { text: '模型', callback_data: 'x:am' }],
      [{ text: 'API Key', callback_data: 'x:ak' }, { text: '系统提示词', callback_data: 'x:ap' }],
      [{ text: '请求超时', callback_data: 'x:at' }, { text: '上下文消息', callback_data: 'x:acm' }],
      [{ text: '上下文字符', callback_data: 'x:acc' }, { text: '生成租约', callback_data: 'x:agl' }],
      [{ text: '人工暂停超时', callback_data: 'x:aop' }], [{ text: '返回 AI', callback_data: 'p:ai' }]
    ]);
    return;
  }
  if (page === 'tg') {
    await reply(bootstrap, ctx,
      `Telegram 设置\n\n客服 Bot：${configured(env.TELEGRAM_BOT_TOKEN)}\n` +
      `配置来源：${runtimeSource(env.runtimeConfigSnapshot, 'TELEGRAM_SUPPORT_PROFILE')}\n\n` +
      `${valueLine(env, 'BOT_GROUP_ID')}\n\nBot Token：${maskSecret(env.TELEGRAM_BOT_TOKEN)}`,
      [[{ text: '轮换客服 Bot', callback_data: 'e:tbot' }], [{ text: '迁移客服群', callback_data: 'e:tgroup' }], [{ text: '返回', callback_data: 'm' }]]
    );
    return;
  }
  if (page === 'crisp') {
    await reply(bootstrap, ctx, [
      'Crisp 客服设置',
      '',
      `网站 ID：${configured(env.CRISP_WEBSITE_ID)}`,
      `API 身份标识：${configured(env.CRISP_API_IDENTIFIER)}`,
      `API 密钥：${configured(env.CRISP_API_KEY)}`,
      `Webhook 签名密钥：${configured(env.CRISP_WEBHOOK_SECRET)}`,
      '',
      '以上项目由 Worker ENV / Secret 管理，本页面仅显示配置状态。'
    ].join('\n'), [[{ text: '返回主菜单', callback_data: 'm' }]]);
    return;
  }
  if (page === 'cw') {
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE, [[{ text: '返回主菜单', callback_data: 'm' }]]);
    return;
  }
  if (page === 'cwr') {
    await reply(bootstrap, ctx, CHATWOOT_ADMIN_DISABLED_MESSAGE, [[{ text: '返回主菜单', callback_data: 'm' }]]);
    return;
  }
  if (page === 'att') {
    await reply(bootstrap, ctx, [
      '附件设置',
      '',
      valueLine(env, 'ATTACHMENT_MAX_BYTES'), '系统上限：20971520 bytes',
      valueLine(env, 'ATTACHMENT_MAX_COUNT_PER_MESSAGE'), '系统上限：10',
      valueLine(env, 'ATTACHMENT_TTL_SECONDS'), valueLine(env, 'ATTACHMENT_SOURCE_TIMEOUT_MS'),
      valueLine(env, 'ATTACHMENT_DESTINATION_TIMEOUT_MS')
    ].join('\n\n'), [
      [edit('最大文件大小', 'fb'), edit('单消息附件数', 'fc')], [edit('TTL', 'ft'), edit('源超时', 'fs')],
      [edit('目标超时', 'fd')],
      [{ text: '恢复 ENV 默认值', callback_data: 'p:attr' }, { text: '历史 / 回滚', callback_data: 'p:hist' }],
      [{ text: '返回', callback_data: 'm' }]
    ]);
    return;
  }
  if (page === 'attr') {
    await reply(bootstrap, ctx, '选择要移除的附件 D1 覆盖配置：', [
      [{ text: '最大文件大小', callback_data: 'x:fb' }, { text: '单消息附件数', callback_data: 'x:fc' }],
      [{ text: 'TTL', callback_data: 'x:ft' }, { text: '源超时', callback_data: 'x:fs' }],
      [{ text: '目标超时', callback_data: 'x:fd' }], [{ text: '返回附件设置', callback_data: 'p:att' }]
    ]);
    return;
  }
  if (page === 'sys') {
    const snapshot = env.runtimeConfigSnapshot;
    const revisions = Object.entries(snapshot?.versions || {}).map(([key, version]) => `${key}=v${version}`).join(', ') || '无';
    const errors = Object.values(snapshot?.errors || {}).join(', ') || '无';
    const health = snapshot?.health === 'AVAILABLE' ? '可用' : '错误';
    await reply(bootstrap, ctx,
      `系统状态\n\n当前客服平台：Crisp\n运行时配置：${health}\nD1 配置覆盖：${snapshot?.overrideCount || 0}\n` +
      `当前配置版本：${revisions}\n配置错误：${errors}\n` +
      `AI：${env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL ? '已启用' : '未启用'}\n` +
      `客服 Bot：${configured(env.TELEGRAM_BOT_TOKEN)}\n客服群：${configured(env.BOT_GROUP_ID)}\n` +
      `Crisp：${env.CRISP_WEBSITE_ID && env.CRISP_API_IDENTIFIER && env.CRISP_API_KEY ? '已配置' : '未完整配置'}`,
      [[{ text: '返回', callback_data: 'm' }]]
    );
    return;
  }
  if (page === 'hist') {
    const history = await listRuntimeHistory(env, 10);
    const lines = history.map(row => {
      const value = row.value_kind === 'SECRET'
        ? '密钥已更新'
        : row.is_deleted
          ? '已恢复 ENV'
          : row.key === 'CRISP_KEYWORD_RULES'
            ? `关键词规则：${parseCrispKeywordRules(row.value_text || '')?.rules.length ?? '无效'} 条`
            : row.value_text;
      const prefix = isLegacyChatwootRuntimeKey(row.key) ? '历史 Chatwoot 记录\n' : '';
      return `${prefix}#${row.id} ${new Date(row.created_at * 1000).toISOString()}\n${row.key} ${row.action} v${row.version}\n操作人：${row.actor_user_id}\n${value}`;
    });
    const buttons = history.filter(row =>
      !row.is_deleted &&
      !isLegacyChatwootRuntimeKey(row.key) &&
      getRuntimeConfigDefinition(row.key).rollback === 'GENERIC'
    )
      .slice(0, 5).map(row => [{ text: `回滚 ${row.key} v${row.version}`, callback_data: `rb:${row.id}` }]);
    await reply(bootstrap, ctx, `操作历史\n\n${lines.join('\n\n') || '暂无历史'}`, [...buttons, [{ text: '返回', callback_data: 'm' }]]);
    return;
  }
  await showMain(bootstrap, ctx);
}
