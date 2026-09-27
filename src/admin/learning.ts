import { Env } from '../config/env';
import { getNotionLearningConfig } from '../learning/notion-api';
import {
  pullLearningCandidateReview,
  syncLearningCandidateToNotion,
  validateNotionLearningSources
} from '../learning/notion';
import { publishApprovedLearningCandidate } from '../learning/publish';
import {
  LEARNING_ADMIN_PAGE_SIZE,
  getLearningCandidate,
  listLearningCandidates,
  listLearningHistory
} from '../learning/repository';
import { LearningCandidateRow } from '../learning/types';
import { sendAdminMessage } from './telegram';
import { AdminBootstrap, AdminContext, AdminKeyboard } from './types';

const CANDIDATE_ID = /^lrn_[A-Za-z0-9_-]{8,60}$/;

async function send(
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  text: string,
  keyboard?: AdminKeyboard
): Promise<void> {
  await sendAdminMessage(bootstrap.token, ctx.chatId, text, keyboard);
}

function requireCandidateId(value: string): string {
  if (!CANDIDATE_ID.test(value)) throw new Error('LEARNING_CANDIDATE_ID_INVALID');
  return value;
}

function statusLabel(row: LearningCandidateRow): string {
  return `${row.review_status} / ${row.extraction_status} / ${row.notion_sync_status}`;
}

function boundedPreview(value: string | null, limit = 900): string {
  if (!value) return '—';
  const normalized = value.trim();
  return normalized.length > limit ? normalized.slice(0, limit) + '…' : normalized;
}

export async function showLearningPage(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  page = 0
): Promise<void> {
  if (!Number.isSafeInteger(page) || page < 0 || page > 9999) throw new Error('LEARNING_PAGE_INVALID');
  const offset = page * LEARNING_ADMIN_PAGE_SIZE;
  const rows = await listLearningCandidates(env, LEARNING_ADMIN_PAGE_SIZE + 1, offset);
  const visible = rows.slice(0, LEARNING_ADMIN_PAGE_SIZE);
  const notion = getNotionLearningConfig(env);
  const notionState = notion.state === 'READY' ? '已配置' : notion.state === 'DISABLED' ? '未启用' : '配置异常';

  const keyboard: AdminKeyboard = visible.map(row => [{
    text: `${row.risk_level === 'HIGH' ? '⚠️' : row.review_status === 'PUBLISHED' ? '✅' : '📝'} ${row.id.slice(0, 22)}`,
    callback_data: `l:v:${row.id}`
  }]);
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: '⬅️ 上一页', callback_data: `l:p:${page - 1}` });
  if (rows.length > LEARNING_ADMIN_PAGE_SIZE) nav.push({ text: '下一页 ➡️', callback_data: `l:p:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([
    { text: '同步学习候选', callback_data: 'l:sync' },
    { text: '拉取审核结果', callback_data: 'l:pull' }
  ]);
  keyboard.push([
    { text: '同步状态', callback_data: 'l:status' },
    { text: '检查 Notion 数据源', callback_data: 'l:src' }
  ]);
  keyboard.push([{ text: '返回', callback_data: 'm' }]);

  const lines = visible.map((row, index) =>
    `${offset + index + 1}. ${row.id}｜${row.risk_level}｜${statusLabel(row)}｜v${row.version}`
  );
  await send(
    bootstrap,
    ctx,
    [
      '🧠 学习候选 / Notion',
      '',
      `Notion：${notionState}`,
      `本页候选：${visible.length}`,
      'D1 是 canonical truth；Notion 仅用于编辑/审核，客服与 AI 在线请求不依赖 Notion。',
      '',
      lines.join('\n') || '暂无学习候选。'
    ].join('\n'),
    keyboard
  );
}

async function showCandidate(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  candidateId: string
): Promise<void> {
  const id = requireCandidateId(candidateId);
  const row = await getLearningCandidate(env, id);
  if (!row) throw new Error('LEARNING_CANDIDATE_NOT_FOUND');
  const history = await listLearningHistory(env, id, 8);
  const lines = history.map(item =>
    `${item.action} v${item.candidate_version} ${item.review_status} ${item.detail_code || ''}`.trim()
  );
  await send(bootstrap, ctx, [
    '🧠 学习候选',
    '',
    `ID：${row.id}`,
    `状态：${statusLabel(row)}`,
    `风险：${row.risk_level}`,
    `版本：v${row.version}`,
    `来源会话：${row.source_conversation_id}`,
    `来源消息：${row.source_human_message_id}`,
    `Notion Page：${row.notion_page_id || '—'}`,
    `已同步候选版本：${row.last_synced_candidate_version ?? '—'}`,
    `D1 Knowledge：${row.published_knowledge_id || '—'}${row.published_knowledge_version ? ` v${row.published_knowledge_version}` : ''}`,
    '',
    'Question：',
    boundedPreview(row.extracted_question || row.sanitized_question),
    '',
    'Proposed Answer：',
    boundedPreview(row.extracted_answer || row.sanitized_answer),
    '',
    '最近审计：',
    lines.join('\n') || '—'
  ].join('\n'), [
    [
      { text: '同步到 Notion', callback_data: `l:s:${id}` },
      { text: '拉取审核', callback_data: `l:r:${id}` }
    ],
    [{ text: '返回候选列表', callback_data: 'p:learn' }]
  ]);
}

async function syncBatch(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id
       FROM learning_candidates
      WHERE notion_sync_status IN ('PENDING', 'ERROR')
        AND review_status <> 'REJECTED'
      ORDER BY updated_at ASC, id ASC
      LIMIT 10`
  ).all<{ id: string }>();
  for (const row of rows.results) await syncLearningCandidateToNotion(env, row.id);
  return rows.results.length;
}

async function pullBatch(env: Env): Promise<{ reviewed: number; published: number }> {
  const rows = await env.DB.prepare(
    `SELECT id
       FROM learning_candidates
      WHERE notion_sync_status = 'SYNCED'
        AND review_status IN ('CAPTURED', 'NEEDS_REVIEW')
        AND notion_page_id IS NOT NULL
        AND last_synced_candidate_version = version
      ORDER BY updated_at ASC, id ASC
      LIMIT 10`
  ).all<{ id: string }>();
  let published = 0;
  for (const row of rows.results) {
    const reviewed = await pullLearningCandidateReview(env, row.id);
    if (reviewed.review_status === 'APPROVED') {
      const result = await publishApprovedLearningCandidate(env, reviewed.id);
      if (result.review_status === 'PUBLISHED') {
        published += 1;
        await syncLearningCandidateToNotion(env, result.id);
      }
    }
  }
  return { reviewed: rows.results.length, published };
}

export async function processLearningCallback(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  code: string
): Promise<string> {
  if (code === 'status') {
    await showLearningPage(env, bootstrap, ctx, 0);
    return 'LEARNING_STATUS';
  }
  if (code === 'sync') {
    const count = await syncBatch(env);
    await send(bootstrap, ctx, `学习候选同步已执行：本次最多 10 条，实际处理 ${count} 条。`);
    await showLearningPage(env, bootstrap, ctx, 0);
    return 'LEARNING_SYNC_BATCH';
  }
  if (code === 'pull') {
    const result = await pullBatch(env);
    await send(
      bootstrap,
      ctx,
      `审核拉取已执行：本次最多 10 条，读取 ${result.reviewed} 条；新增发布 ${result.published} 条。`
    );
    await showLearningPage(env, bootstrap, ctx, 0);
    return 'LEARNING_REVIEW_PULL_BATCH';
  }
  if (code === 'src') {
    const state = await validateNotionLearningSources(env);
    await send(
      bootstrap,
      ctx,
      state === 'READY'
        ? 'Notion Learning Candidates / Knowledge Sources 数据源配置与第一版 editorial schema 检查通过。'
        : 'Notion 学习集成当前未启用。'
    );
    return 'LEARNING_NOTION_SOURCE_VALIDATE';
  }
  if (code.startsWith('p:')) {
    const rawPage = code.slice(2);
    if (!/^\d{1,4}$/.test(rawPage)) throw new Error('LEARNING_PAGE_INVALID');
    await showLearningPage(env, bootstrap, ctx, Number(rawPage));
    return 'LEARNING_PAGE';
  }
  if (code.startsWith('v:')) {
    await showCandidate(env, bootstrap, ctx, code.slice(2));
    return 'LEARNING_VIEW';
  }
  if (code.startsWith('s:')) {
    const id = requireCandidateId(code.slice(2));
    await syncLearningCandidateToNotion(env, id);
    await showCandidate(env, bootstrap, ctx, id);
    return 'LEARNING_SYNC_ONE';
  }
  if (code.startsWith('r:')) {
    const id = requireCandidateId(code.slice(2));
    const reviewed = await pullLearningCandidateReview(env, id);
    if (reviewed.review_status === 'APPROVED') {
      const published = await publishApprovedLearningCandidate(env, id);
      if (published.review_status === 'PUBLISHED') await syncLearningCandidateToNotion(env, id);
    }
    await showCandidate(env, bootstrap, ctx, id);
    return 'LEARNING_REVIEW_PULL_ONE';
  }
  throw new Error('UNKNOWN_LEARNING_ACTION');
}

