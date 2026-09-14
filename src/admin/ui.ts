import { Env } from '../config/env';
import { getRuntimeConfigDefinition } from '../runtime-config/registry';
import { listRuntimeHistory } from '../runtime-config/repository';
import { maskSecret, runtimeSource } from '../runtime-config/resolver';
import { RuntimeConfigKey } from '../runtime-config/types';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';

const mainKeyboard: AdminKeyboard = [
  [{ text: '🤖 AI', callback_data: 'p:ai' }, { text: '💬 Telegram', callback_data: 'p:tg' }],
  [{ text: '🟦 Chatwoot', callback_data: 'p:cw' }, { text: '📎 Attachments', callback_data: 'p:att' }],
  [{ text: '⚙️ System', callback_data: 'p:sys' }, { text: '📜 History', callback_data: 'p:hist' }]
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
  return `${getRuntimeConfigDefinition(key).label}:\n${value}\nSource: ${runtimeSource(snapshot, key)}`;
}

export async function showMain(bootstrap: AdminBootstrap, ctx: AdminContext): Promise<void> {
  await reply(bootstrap, ctx, 'CZ2128 控制中心', mainKeyboard);
}

export async function showPage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  page: string
): Promise<void> {
  const edit = (text: string, code: string) => ({ text, callback_data: `e:${code}` });
  if (page === 'ai') {
    await reply(bootstrap, ctx, [
      valueLine(env, 'AI_BASE_URL'), valueLine(env, 'AI_MODEL'), valueLine(env, 'AI_API_KEY', true),
      valueLine(env, 'AI_REQUEST_TIMEOUT_MS'), valueLine(env, 'AI_CONTEXT_MAX_MESSAGES'),
      valueLine(env, 'AI_CONTEXT_MAX_CHARS'), valueLine(env, 'AI_GENERATION_LEASE_SECONDS'),
      valueLine(env, 'AI_OPERATOR_PAUSE_TIMEOUT_SECONDS')
    ].join('\n\n'), [
      [edit('修改 API 地址', 'ab'), edit('修改 Model', 'am')],
      [edit('修改 API Key', 'ak'), edit('修改 System Prompt', 'ap')],
      [edit('请求超时', 'at'), edit('上下文消息数', 'acm')],
      [edit('上下文字符数', 'acc'), edit('Generation Lease', 'agl')],
      [edit('人工暂停超时', 'aop'), { text: '测试 AI', callback_data: 't:ai' }],
      [{ text: '恢复 Env 默认', callback_data: 'p:air' }, { text: '历史 / 回滚', callback_data: 'p:hist' }],
      [{ text: '返回', callback_data: 'm' }]
    ]);
    return;
  }
  if (page === 'air') {
    await reply(bootstrap, ctx, '选择要移除的 AI D1 override：', [
      [{ text: 'API 地址', callback_data: 'x:ab' }, { text: 'Model', callback_data: 'x:am' }],
      [{ text: 'API Key', callback_data: 'x:ak' }, { text: 'System Prompt', callback_data: 'x:ap' }],
      [{ text: '请求超时', callback_data: 'x:at' }, { text: '上下文消息', callback_data: 'x:acm' }],
      [{ text: '上下文字符', callback_data: 'x:acc' }, { text: 'Generation Lease', callback_data: 'x:agl' }],
      [{ text: '人工暂停超时', callback_data: 'x:aop' }], [{ text: '返回 AI', callback_data: 'p:ai' }]
    ]);
    return;
  }
  if (page === 'tg') {
    await reply(bootstrap, ctx,
      `客服 Bot: ${env.TELEGRAM_BOT_TOKEN ? 'configured' : 'unavailable'}\n` +
      `Source: ${runtimeSource(env.runtimeConfigSnapshot, 'TELEGRAM_SUPPORT_PROFILE')}\n\n` +
      `${valueLine(env, 'BOT_GROUP_ID')}\n\nBot token: ${maskSecret(env.TELEGRAM_BOT_TOKEN)}`,
      [[{ text: '轮换客服 Bot', callback_data: 'e:tbot' }], [{ text: '迁移客服群', callback_data: 'e:tgroup' }], [{ text: '返回', callback_data: 'm' }]]
    );
    return;
  }
  if (page === 'cw') {
    await reply(bootstrap, ctx, [
      valueLine(env, 'CHATWOOT_API_URL'), valueLine(env, 'CHATWOOT_API_TOKEN', true),
      valueLine(env, 'CHATWOOT_ATTACHMENT_ALLOWED_HOSTS'),
      '注意：修改 Chatwoot API 地址不会自动重配外部 webhook 或签名 secret。'
    ].join('\n\n'), [
      [edit('修改 API 地址', 'cu'), edit('修改 API Token', 'ct')], [edit('修改附件 Hosts', 'ch')],
      [{ text: '恢复 Env 默认', callback_data: 'p:cwr' }, { text: '历史 / 回滚', callback_data: 'p:hist' }],
      [{ text: '返回', callback_data: 'm' }]
    ]);
    return;
  }
  if (page === 'cwr') {
    await reply(bootstrap, ctx, '选择要移除的 Chatwoot D1 override：', [
      [{ text: 'API 地址', callback_data: 'x:cu' }, { text: 'API Token', callback_data: 'x:ct' }],
      [{ text: '附件 Hosts', callback_data: 'x:ch' }], [{ text: '返回 Chatwoot', callback_data: 'p:cw' }]
    ]);
    return;
  }
  if (page === 'att') {
    await reply(bootstrap, ctx, [
      valueLine(env, 'ATTACHMENT_MAX_BYTES'), 'Hard cap: 20971520 bytes',
      valueLine(env, 'ATTACHMENT_MAX_COUNT_PER_MESSAGE'), 'Hard cap: 10',
      valueLine(env, 'ATTACHMENT_TTL_SECONDS'), valueLine(env, 'ATTACHMENT_SOURCE_TIMEOUT_MS'),
      valueLine(env, 'ATTACHMENT_DESTINATION_TIMEOUT_MS')
    ].join('\n\n'), [
      [edit('最大文件大小', 'fb'), edit('单消息附件数', 'fc')], [edit('TTL', 'ft'), edit('源超时', 'fs')],
      [edit('目标超时', 'fd')],
      [{ text: '恢复 Env 默认', callback_data: 'p:attr' }, { text: '历史 / 回滚', callback_data: 'p:hist' }],
      [{ text: '返回', callback_data: 'm' }]
    ]);
    return;
  }
  if (page === 'attr') {
    await reply(bootstrap, ctx, '选择要移除的附件 D1 override：', [
      [{ text: '最大文件大小', callback_data: 'x:fb' }, { text: '单消息附件数', callback_data: 'x:fc' }],
      [{ text: 'TTL', callback_data: 'x:ft' }, { text: '源超时', callback_data: 'x:fs' }],
      [{ text: '目标超时', callback_data: 'x:fd' }], [{ text: '返回 Attachments', callback_data: 'p:att' }]
    ]);
    return;
  }
  if (page === 'sys') {
    const snapshot = env.runtimeConfigSnapshot;
    const revisions = Object.entries(snapshot?.versions || {}).map(([key, version]) => `${key}=v${version}`).join(', ') || 'none';
    const errors = Object.values(snapshot?.errors || {}).join(', ') || 'none';
    await reply(bootstrap, ctx,
      `Runtime Config: ${snapshot?.health || 'ERROR'}\nConfig overrides: ${snapshot?.overrideCount || 0}\n` +
      `Current revisions: ${revisions}\nConfig errors: ${errors}\n` +
      `AI: ${env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL ? 'ENABLED' : 'DISABLED'}\n` +
      `Support Bot: ${env.TELEGRAM_BOT_TOKEN ? 'configured' : 'unavailable'}\nSupport Group: ${env.BOT_GROUP_ID || 'unavailable'}\n` +
      `Chatwoot: ${env.CHATWOOT_API_URL && env.CHATWOOT_API_TOKEN ? 'configured' : 'unavailable'}\nPhase: 3.5`,
      [[{ text: '返回', callback_data: 'm' }]]
    );
    return;
  }
  if (page === 'hist') {
    const history = await listRuntimeHistory(env, 10);
    const lines = history.map(row => {
      const value = row.value_kind === 'SECRET' ? 'SECRET UPDATED' : row.is_deleted ? 'ENV RESTORED' : row.value_text;
      return `#${row.id} ${new Date(row.created_at * 1000).toISOString()}\n${row.key} ${row.action} v${row.version}\nactor ${row.actor_user_id}\n${value}`;
    });
    const buttons = history.filter(row => !row.is_deleted && getRuntimeConfigDefinition(row.key).rollback === 'GENERIC')
      .slice(0, 5).map(row => [{ text: `回滚 ${row.key} v${row.version}`, callback_data: `rb:${row.id}` }]);
    await reply(bootstrap, ctx, lines.join('\n\n') || '暂无历史', [...buttons, [{ text: '返回', callback_data: 'm' }]]);
    return;
  }
  await showMain(bootstrap, ctx);
}
