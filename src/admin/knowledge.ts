import { Env } from '../config/env';
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  sanitizeKnowledgeBody,
  sanitizeKnowledgeTitle,
  setKnowledgeEntryEnabled,
  updateKnowledgeEntry
} from '../knowledge/repository';
import { SafeError } from '../core/errors';
import { clearAdminSession, getAdminSession, saveAdminSession } from '../runtime-config/repository';
import { AdminSessionRow } from '../runtime-config/types';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';

export const KNOWLEDGE_ADMIN_PAGE_SIZE = 10;
const ENTRY_ID_PATTERN = /^kb_[a-f0-9]{16}$/;

function requireEntryId(value: string): string {
  if (!ENTRY_ID_PATTERN.test(value)) throw new SafeError('KNOWLEDGE_VALUE_INVALID');
  return value;
}

function requireVersion(value: string): number {
  if (!/^\d{1,9}$/.test(value)) throw new SafeError('KNOWLEDGE_VALUE_INVALID');
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new SafeError('KNOWLEDGE_VALUE_INVALID');
  return version;
}

function previewBody(value: string): string {
  const normalized = value.trim();
  return normalized.length > 2200 ? normalized.slice(0, 2200) + '\n…（正文已截断）' : normalized;
}

async function send(
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  text: string,
  keyboard?: AdminKeyboard
): Promise<void> {
  await sendAdminMessage(bootstrap.token, ctx.chatId, text, keyboard);
}

export async function showKnowledgePage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  page = 0
): Promise<void> {
  if (!Number.isSafeInteger(page) || page < 0 || page > 9999) throw new SafeError('KNOWLEDGE_VALUE_INVALID');
  const offset = page * KNOWLEDGE_ADMIN_PAGE_SIZE;
  const rows = await listKnowledgeEntries(env, KNOWLEDGE_ADMIN_PAGE_SIZE + 1, offset);
  const visible = rows.slice(0, KNOWLEDGE_ADMIN_PAGE_SIZE);
  if (page > 0 && visible.length === 0) throw new SafeError('KNOWLEDGE_NOT_FOUND');

  const keyboard: AdminKeyboard = visible.map(row => [{
    text: `${row.enabled ? '✅' : '⏸'} ${row.title.slice(0, 28)}`,
    callback_data: `b:v:${row.id}`
  }]);
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: '⬅️ 上一页', callback_data: `b:p:${page - 1}` });
  if (rows.length > KNOWLEDGE_ADMIN_PAGE_SIZE) nav.push({ text: '下一页 ➡️', callback_data: `b:p:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '➕ 添加知识', callback_data: 'b:add' }]);
  keyboard.push([{ text: '返回', callback_data: 'm' }]);

  const lines = visible.map((row, index) =>
    `${offset + index + 1}. ${row.enabled ? '✅' : '⏸'} ${row.title}（v${row.version}）`
  );
  await send(
    bootstrap,
    ctx,
    `📚 AI 知识库\n\n已显示 ${visible.length} 条，第 ${page + 1} 页。\nAI 只检索启用条目；知识内容由管理员人工维护，不会从客服回复自动永久学习。\n\n${lines.join('\n') || '暂无知识条目。'}`,
    keyboard
  );
}

export async function showKnowledgeEntry(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  entryId: string
): Promise<void> {
  const id = requireEntryId(entryId);
  const row = await getKnowledgeEntry(env, id);
  if (!row) throw new SafeError('KNOWLEDGE_NOT_FOUND');
  const version = row.version;
  await send(bootstrap, ctx, [
    '📚 知识条目',
    '',
    `状态：${row.enabled ? '✅ 启用' : '⏸ 停用'}`,
    `标题：${row.title}`,
    `版本：v${row.version}`,
    `更新时间：${new Date(row.updated_at * 1000).toISOString()}`,
    '',
    '正文：',
    previewBody(row.body)
  ].join('\n'), [
    [
      { text: '修改标题', callback_data: `b:et:${id}:${version}` },
      { text: '修改正文', callback_data: `b:eb:${id}:${version}` }
    ],
    [{ text: row.enabled ? '停用' : '启用', callback_data: `b:t:${id}:${version}` }],
    [{ text: '🗑 删除', callback_data: `b:d:${id}:${version}` }],
    [{ text: '返回知识库', callback_data: 'p:kb' }]
  ]);
}

async function saveSession(
  env: Env,
  ctx: AdminContext,
  action: string,
  target: string,
  expectedVersion: number,
  candidateValue: string | null = null
): Promise<void> {
  await saveAdminSession(env, {
    admin_user_id: ctx.userId,
    action,
    target,
    expected_version: expectedVersion,
    candidate_value_text: candidateValue,
    candidate_ciphertext: null,
    candidate_nonce: null,
    context_json: null
  });
}

function parseEntryVersionAction(action: string, prefix: string): { id: string; version: number } | null {
  if (!action.startsWith(prefix + ':')) return null;
  const rest = action.slice(prefix.length + 1);
  const split = rest.lastIndexOf(':');
  if (split <= 0) throw new SafeError('KNOWLEDGE_VALUE_INVALID');
  return {
    id: requireEntryId(rest.slice(0, split)),
    version: requireVersion(rest.slice(split + 1))
  };
}

export async function processKnowledgeCallback(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  action: string
): Promise<string> {
  if (action === 'add') {
    await saveSession(env, ctx, 'KNOWLEDGE_ADD_TITLE', 'KNOWLEDGE_NEW', 0);
    await send(bootstrap, ctx, '请输入知识标题（最多 120 字）。');
    return 'KNOWLEDGE_ADD_BEGIN';
  }

  const pageMatch = /^p:(\d{1,4})$/.exec(action);
  if (pageMatch) {
    await showKnowledgePage(env, bootstrap, ctx, Number(pageMatch[1]));
    return 'KNOWLEDGE_PAGE';
  }

  const viewMatch = /^v:(kb_[a-f0-9]{16})$/.exec(action);
  if (viewMatch) {
    await showKnowledgeEntry(env, bootstrap, ctx, viewMatch[1]);
    return 'KNOWLEDGE_VIEW';
  }

  const editTitle = parseEntryVersionAction(action, 'et');
  if (editTitle) {
    const current = await getKnowledgeEntry(env, editTitle.id);
    if (!current) throw new SafeError('KNOWLEDGE_NOT_FOUND');
    if (current.version !== editTitle.version) throw new SafeError('KNOWLEDGE_VERSION_CONFLICT');
    await saveSession(env, ctx, 'KNOWLEDGE_EDIT_TITLE', editTitle.id, editTitle.version);
    await send(bootstrap, ctx, `当前标题：${current.title}\n\n请输入新标题。`);
    return 'KNOWLEDGE_EDIT_TITLE_BEGIN';
  }

  const editBody = parseEntryVersionAction(action, 'eb');
  if (editBody) {
    const current = await getKnowledgeEntry(env, editBody.id);
    if (!current) throw new SafeError('KNOWLEDGE_NOT_FOUND');
    if (current.version !== editBody.version) throw new SafeError('KNOWLEDGE_VERSION_CONFLICT');
    await saveSession(env, ctx, 'KNOWLEDGE_EDIT_BODY', editBody.id, editBody.version);
    await send(bootstrap, ctx, '请输入新的知识正文（最多 12000 字）。');
    return 'KNOWLEDGE_EDIT_BODY_BEGIN';
  }

  const toggle = parseEntryVersionAction(action, 't');
  if (toggle) {
    const current = await getKnowledgeEntry(env, toggle.id);
    if (!current) throw new SafeError('KNOWLEDGE_NOT_FOUND');
    const updated = await setKnowledgeEntryEnabled(
      env,
      toggle.id,
      toggle.version,
      current.enabled !== 1,
      ctx.userId,
      ctx.updateId
    );
    await send(bootstrap, ctx, updated.enabled ? '知识条目已启用。' : '知识条目已停用。', [
      [{ text: '返回条目', callback_data: `b:v:${updated.id}` }]
    ]);
    return updated.enabled ? 'KNOWLEDGE_ENABLED' : 'KNOWLEDGE_DISABLED';
  }

  const deletion = parseEntryVersionAction(action, 'd');
  if (deletion) {
    const current = await getKnowledgeEntry(env, deletion.id);
    if (!current) throw new SafeError('KNOWLEDGE_NOT_FOUND');
    if (current.version !== deletion.version) throw new SafeError('KNOWLEDGE_VERSION_CONFLICT');
    await saveSession(env, ctx, 'KNOWLEDGE_DELETE_CONFIRM', deletion.id, deletion.version);
    await send(bootstrap, ctx, `确认删除知识“${current.title}”？历史审计会保留。\n删除后 AI 将不再检索该条目。`, [[
      { text: '确认删除', callback_data: 'b:dy' },
      { text: '取消', callback_data: 'b:dn' }
    ]]);
    return 'KNOWLEDGE_DELETE_BEGIN';
  }

  if (action === 'dn') {
    const session = await getAdminSession(env, ctx.userId);
    if (!session || session.action !== 'KNOWLEDGE_DELETE_CONFIRM') {
      throw new SafeError('CONFIRMATION_SESSION_MISSING');
    }
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, '已取消知识删除。', [[{ text: '返回知识库', callback_data: 'p:kb' }]]);
    return 'KNOWLEDGE_DELETE_CANCEL';
  }

  if (action === 'dy') {
    const session = await getAdminSession(env, ctx.userId);
    if (!session || session.action !== 'KNOWLEDGE_DELETE_CONFIRM') {
      throw new SafeError('CONFIRMATION_SESSION_MISSING');
    }
    const id = requireEntryId(session.target);
    await deleteKnowledgeEntry(env, id, session.expected_version, ctx.userId, ctx.updateId);
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, '知识条目已删除；历史审计已保留。', [[{ text: '返回知识库', callback_data: 'p:kb' }]]);
    return 'KNOWLEDGE_DELETED';
  }

  throw new SafeError('UNKNOWN_ADMIN_ACTION');
}

export async function processKnowledgeMessage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  session: AdminSessionRow
): Promise<string> {
  if (!ctx.text) throw new SafeError('KNOWLEDGE_VALUE_INVALID');

  if (session.action === 'KNOWLEDGE_ADD_TITLE') {
    const title = sanitizeKnowledgeTitle(ctx.text);
    await saveSession(env, ctx, 'KNOWLEDGE_ADD_BODY', 'KNOWLEDGE_NEW', 0, title);
    await send(bootstrap, ctx, `标题：${title}\n\n请输入知识正文（最多 12000 字）。`);
    return 'KNOWLEDGE_ADD_TITLE';
  }

  if (session.action === 'KNOWLEDGE_ADD_BODY') {
    const title = sanitizeKnowledgeTitle(session.candidate_value_text || '');
    const body = sanitizeKnowledgeBody(ctx.text);
    const row = await createKnowledgeEntry(env, title, body, ctx.userId, ctx.updateId);
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `知识已创建并启用：${row.title}`, [[
      { text: '查看条目', callback_data: `b:v:${row.id}` }
    ]]);
    return 'KNOWLEDGE_CREATED';
  }

  if (session.action === 'KNOWLEDGE_EDIT_TITLE') {
    const id = requireEntryId(session.target);
    const current = await getKnowledgeEntry(env, id);
    if (!current) throw new SafeError('KNOWLEDGE_NOT_FOUND');
    const updated = await updateKnowledgeEntry(
      env,
      id,
      session.expected_version,
      sanitizeKnowledgeTitle(ctx.text),
      current.body,
      ctx.userId,
      ctx.updateId
    );
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `知识标题已更新：${updated.title}`, [[
      { text: '返回条目', callback_data: `b:v:${updated.id}` }
    ]]);
    return 'KNOWLEDGE_TITLE_UPDATED';
  }

  if (session.action === 'KNOWLEDGE_EDIT_BODY') {
    const id = requireEntryId(session.target);
    const current = await getKnowledgeEntry(env, id);
    if (!current) throw new SafeError('KNOWLEDGE_NOT_FOUND');
    const updated = await updateKnowledgeEntry(
      env,
      id,
      session.expected_version,
      current.title,
      sanitizeKnowledgeBody(ctx.text),
      ctx.userId,
      ctx.updateId
    );
    await clearAdminSession(env, ctx.userId);
    await send(bootstrap, ctx, `知识正文已更新：${updated.title}`, [[
      { text: '返回条目', callback_data: `b:v:${updated.id}` }
    ]]);
    return 'KNOWLEDGE_BODY_UPDATED';
  }

  throw new SafeError('CONFIRMATION_REQUIRED');
}
