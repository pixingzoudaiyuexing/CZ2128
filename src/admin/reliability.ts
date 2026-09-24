import { Env } from '../config/env';
import { reply } from './ui';
import { AdminBootstrap, AdminContext } from './types';
import { OutboundOperation } from '../core/domain';
import { manualMarkDelivered, manualCancel, reconcileOutboundOperation } from '../core/outbound-reconciliation';
import { manualRetryOutboundOperation, MANUAL_RETRY_REASONS } from '../core/outbound-manual-retry';
import { saveAdminSession, getAdminSession, clearAdminSession } from '../runtime-config/repository';
import { safeErrorCode, SafeError } from '../core/errors';
import { listDlqQuarantine } from '../queue/dlq-quarantine';
import { resolveQueueIdentities } from '../config/queue-identities';
import {
  DlqAiRedriveReason,
  getDlqAiRedriveEligibility,
  requestDlqAiRedrive
} from '../core/dlq-ai-redrive';

interface AdminDlqReceipt {
  id: string;
  queue_name: string;
  event_source: string | null;
  source_event_ref: string | null;
  event_type: string | null;
  conversation_id: string | null;
  operation_id: string | null;
  safe_error_code: string | null;
  status: 'OPEN' | 'RESOLVED';
  delivery_count: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
}

function safeDisplay(value: string | number | null, maximum = 96): string {
  if (value === null) return 'N/A';
  const normalized = String(value).replace(/[\u0000-\u001f\u007f]/g, '');
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}...`;
}

const REDRIVE_REASON_LABELS: Record<DlqAiRedriveReason, string> = {
  ELIGIBLE: '可执行',
  RECEIPT_NOT_FOUND: '未找到 DLQ 回执',
  RECEIPT_RESOLVED: '已解决',
  NOT_AI_TRIGGER: '不是 AI trigger',
  RECEIPT_MALFORMED: 'DLQ 回执格式异常',
  EVENT_ID_INVALID: '无法重建事件 payload',
  CONVERSATION_MISSING: '会话不存在',
  MESSAGE_MISSING: '消息不存在',
  STALE_TRIGGER: '触发已过期',
  AI_RUN_MISSING: 'AI run 不存在',
  AI_RUN_IDENTITY_MISMATCH: 'AI run 身份不匹配',
  AI_RUN_STATE_INELIGIBLE: 'AI run 状态不允许',
  AI_RETRY_NOT_DUE: '尚未到重试时间',
  AI_ATTEMPTS_EXHAUSTED: '尝试次数已耗尽',
  AI_PAUSED: 'AI 已暂停',
  AI_SCOPE_DENIED: 'AI 测试范围不允许',
  HANDOFF_EPOCH_CHANGED: '人工接管 epoch 已变化',
  ACTIVE_GENERATION: '当前仍有生成任务',
  EVENT_RECEIPT_MISSING: '事件回执不存在',
  EVENT_RECEIPT_ACTIVE: '事件仍在处理中',
  EVENT_RECEIPT_PROCESSED: '事件已经处理',
  EVENT_RECEIPT_INCONSISTENT: '事件回执状态不一致',
  OUTBOUND_EVIDENCE_MISSING: '缺少历史出站目标证据',
  OUTBOUND_ACTIVE: '出站操作仍处于活动状态',
  OUTBOUND_RETRY_NOT_DUE: '出站操作尚未到重试时间',
  OUTBOUND_ATTEMPTS_EXHAUSTED: '出站尝试次数已耗尽',
  OUTBOUND_AMBIGUOUS: '出站结果为 AMBIGUOUS，请使用核对或手动重试',
  OUTBOUND_FINAL: '出站操作已终结',
  OUTBOUND_INCONSISTENT: '出站状态不一致'
};

async function showDlqList(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  mode: 'OPEN' | 'RECENT'
): Promise<string> {
  const where = mode === 'OPEN' ? "WHERE status = 'OPEN'" : '';
  const rows = await env.DB.prepare(
    `SELECT id, queue_name, event_source, source_event_ref, event_type, conversation_id,
            operation_id, safe_error_code, status, delivery_count, first_seen_at,
            last_seen_at, resolved_at
     FROM dlq_receipts ${where}
     ORDER BY last_seen_at DESC, id DESC LIMIT 10`
  ).all<AdminDlqReceipt>();
  const receipts = rows.results || [];
  if (receipts.length === 0) {
    await reply(bootstrap, ctx, mode === 'OPEN' ? '当前没有 OPEN 的 DLQ 回执。' : '没有找到 DLQ 回执。', [
      [{ text: '返回可靠性管理', callback_data: 'p:rel' }]
    ]);
    return mode === 'OPEN' ? 'REL_DLQ_OPEN' : 'REL_DLQ_RECENT';
  }

  await saveAdminSession(env, {
    admin_user_id: ctx.userId,
    action: 'RELIABILITY_DLQ_LIST',
    target: 'DLQ_RECEIPT',
    expected_version: 0,
    candidate_value_text: null,
    candidate_ciphertext: null,
    candidate_nonce: null,
    context_json: JSON.stringify({ mode, receiptIds: receipts.map(receipt => receipt.id) })
  });

  const lines = receipts.map((receipt, index) => [
    `${index + 1}. ${receipt.status} ${safeDisplay(receipt.event_source, 24)} / ${safeDisplay(receipt.event_type, 40)}`,
    `事件：${safeDisplay(receipt.source_event_ref, 80)}`,
    `最后出现：${receipt.last_seen_at} | 投递次数：${receipt.delivery_count}`
  ].join('\n'));
  const buttons = receipts.map((receipt, index) => [{
    text: `${index + 1}. ${receipt.status} ${safeDisplay(receipt.event_type, 24)}`,
    callback_data: `r:d:${index}`
  }]);
  await reply(bootstrap, ctx, `${mode === 'OPEN' ? 'OPEN' : '最近'} DLQ（最近 10 条）：\n\n${lines.join('\n\n')}`, [
    ...buttons,
    [{ text: '刷新', callback_data: mode === 'OPEN' ? 'r:dlqo' : 'r:dlqr' }],
    [{ text: '返回可靠性管理', callback_data: 'p:rel' }]
  ]);
  return mode === 'OPEN' ? 'REL_DLQ_OPEN' : 'REL_DLQ_RECENT';
}

async function showDlqDetail(
  env: Env,
  bootstrap: AdminBootstrap,
  ctx: AdminContext,
  receiptId: string,
  mode: 'OPEN' | 'RECENT',
  alert?: string
): Promise<string> {
  const receipt = await env.DB.prepare(
    `SELECT id, queue_name, event_source, source_event_ref, event_type, conversation_id,
            operation_id, safe_error_code, status, delivery_count, first_seen_at,
            last_seen_at, resolved_at
     FROM dlq_receipts WHERE id = ?`
  ).bind(receiptId).first<AdminDlqReceipt>();
  if (!receipt) return showDlqList(env, bootstrap, ctx, mode);
  const eligibility = await getDlqAiRedriveEligibility(env, receipt.id);

  await saveAdminSession(env, {
    admin_user_id: ctx.userId,
    action: 'RELIABILITY_DLQ_DETAIL',
    target: 'DLQ_RECEIPT',
    expected_version: 0,
    candidate_value_text: null,
    candidate_ciphertext: null,
    candidate_nonce: null,
    context_json: JSON.stringify({ mode, receiptId: receipt.id })
  });
  await reply(bootstrap, ctx, [
    ...(alert ? [alert, ''] : []),
    'DLQ 回执',
    '',
    `ID: ${safeDisplay(receipt.id)}`,
    `状态：${receipt.status}`,
    `Queue：${safeDisplay(receipt.queue_name)}`,
    `来源：${safeDisplay(receipt.event_source)}`,
    `事件引用：${safeDisplay(receipt.source_event_ref, 256)}`,
    `事件类型：${safeDisplay(receipt.event_type)}`,
    `会话：${safeDisplay(receipt.conversation_id)}`,
    `操作：${safeDisplay(receipt.operation_id)}`,
    `错误：${safeDisplay(receipt.safe_error_code)}`,
    `投递次数：${receipt.delivery_count}`,
    `首次出现：${receipt.first_seen_at}`,
    `最后出现：${receipt.last_seen_at}`,
    `解决时间：${safeDisplay(receipt.resolved_at)}`,
    `AI 重放：${eligibility.eligible ? '可执行' : `不可执行（${REDRIVE_REASON_LABELS[eligibility.reason]}）`}`
  ].join('\n'), [
    ...(eligibility.eligible ? [[{ text: '重放 AI', callback_data: 'r:dr' }]] : []),
    [{ text: '刷新', callback_data: 'r:dd' }],
    [{ text: '返回 DLQ', callback_data: mode === 'OPEN' ? 'r:dlqo' : 'r:dlqr' }],
    [{ text: '返回可靠性管理', callback_data: 'p:rel' }]
  ]);
  return 'REL_DLQ_DETAIL';
}

async function showDlqQuarantine(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext): Promise<string> {
  const quarantine = await listDlqQuarantine(env.DLQ_QUARANTINE, 10, resolveQueueIdentities(env).dlq);
  const count = quarantine.truncated ? `${quarantine.visibleCount}+` : String(quarantine.visibleCount);
  const lines = quarantine.entries.map((entry, index) => [
    `${index + 1}. ${entry.state}`,
    `ID: ${safeDisplay(entry.quarantineId)}`,
    `Canonical 回执：${safeDisplay(entry.canonicalReceiptId)}`,
    `来源/类型：${safeDisplay(entry.eventSource, 24)} / ${safeDisplay(entry.eventType, 40)}`,
    `Queue 尝试次数：${safeDisplay(entry.queueAttempts)}`,
    `消息时间：${safeDisplay(entry.messageTimestamp)}`,
    `上传时间：${entry.uploadedAt}`,
    `原因：${entry.reason}`
  ].join('\n'));
  const text = [
    '终态 DLQ 隔离区',
    '',
    `可见对象：${count}`,
    `无效的脱敏元数据：${quarantine.invalidMetadataCount}`,
    '',
    ...(lines.length > 0 ? lines : ['没有找到脱敏后的隔离证据。'])
  ].join('\n\n');
  await reply(bootstrap, ctx, text, [
    [{ text: '刷新', callback_data: 'r:dlqq' }],
    [{ text: '返回可靠性管理', callback_data: 'p:rel' }]
  ]);
  return 'REL_DLQ_QUARANTINE';
}

export async function showReliabilityMain(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext) {
  const unresolvedAmbiguous = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM outbound_operations WHERE status = 'AMBIGUOUS' AND reconciliation_status IN ('PENDING', 'STILL_AMBIGUOUS')`
  ).first<{ c: number }>();
  
  const pendingRetries = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM outbound_operations WHERE status = 'FAILED_RETRYABLE'`
  ).first<{ c: number }>();
  
  const manualResolved = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM outbound_operations WHERE reconciliation_status IN ('MANUAL_MARK_DELIVERED', 'MANUAL_CANCELLED', 'MANUAL_RETRY_CREATED')`
  ).first<{ c: number }>();
  
  const aiRetryable = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM ai_runs WHERE status = 'FAILED_RETRYABLE'`
  ).first<{ c: number }>();
  
  const aiExhausted = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM ai_runs WHERE status = 'RETRY_EXHAUSTED'`
  ).first<{ c: number }>();
  
  const aiFinal = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM ai_runs WHERE status = 'FAILED_FINAL'`
  ).first<{ c: number }>();

  const now = Math.floor(Date.now() / 1000);
  const dlqSummary = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM dlq_receipts WHERE status = 'OPEN') AS open_count,
       ((SELECT COUNT(*) FROM dlq_receipts WHERE status = 'OPEN' AND last_seen_at >= ?) +
        (SELECT COUNT(*) FROM dlq_receipts WHERE status = 'RESOLVED' AND last_seen_at >= ?)) AS recent_count,
       MAX(
         COALESCE((SELECT last_seen_at FROM dlq_receipts WHERE status = 'OPEN' ORDER BY last_seen_at DESC LIMIT 1), 0),
         COALESCE((SELECT last_seen_at FROM dlq_receipts WHERE status = 'RESOLVED' ORDER BY last_seen_at DESC LIMIT 1), 0)
       ) AS latest_at`
  ).bind(now - 86400, now - 86400).first<{ open_count: number; recent_count: number; latest_at: number }>();

  const text = [
    `🛡 可靠性管理`,
    ``,
    `未解决 AMBIGUOUS：${unresolvedAmbiguous?.c || 0}`,
    `等待自动重试的出站操作：${pendingRetries?.c || 0}`,
    `人工处理完成：${manualResolved?.c || 0}`,
    `AI FAILED_RETRYABLE: ${aiRetryable?.c || 0}`,
    `AI RETRY_EXHAUSTED: ${aiExhausted?.c || 0}`,
    `AI FAILED_FINAL: ${aiFinal?.c || 0}`,
    `DLQ OPEN: ${dlqSummary?.open_count || 0}`,
    `DLQ 最近 24 小时：${dlqSummary?.recent_count || 0}`,
    `DLQ 最近时间：${dlqSummary?.latest_at || 'N/A'}`
  ].join('\n');

  await reply(bootstrap, ctx, text, [
    [{ text: '⚠️ 不确定投递', callback_data: 'r:unc' }],
    [{ text: '🔎 查询 Operation', callback_data: 'r:look' }],
    [{ text: '🤖 AI 可靠性', callback_data: 'r:ai' }],
    [{ text: '📜 可靠性审计', callback_data: 'r:aud' }],
    [{ text: '☠️ OPEN DLQ', callback_data: 'r:dlqo' }, { text: '最近 DLQ', callback_data: 'r:dlqr' }],
    [{ text: '终态隔离区', callback_data: 'r:dlqq' }],
    [{ text: '🔄 刷新', callback_data: 'p:rel' }],
    [{ text: '返回', callback_data: 'm' }]
  ]);
}

export async function processReliabilityCallback(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, action: string): Promise<string> {
  if (action === 'dlqq') return showDlqQuarantine(env, bootstrap, ctx);
  if (action === 'dlqo') return showDlqList(env, bootstrap, ctx, 'OPEN');
  if (action === 'dlqr') return showDlqList(env, bootstrap, ctx, 'RECENT');
  if (/^d:\d$/.test(action)) {
    const session = await getAdminSession(env, ctx.userId);
    if (session?.action !== 'RELIABILITY_DLQ_LIST' || !session.context_json) {
      return showDlqList(env, bootstrap, ctx, 'OPEN');
    }
    const context = JSON.parse(session.context_json) as { mode?: string; receiptIds?: unknown };
    const mode = context.mode === 'RECENT' ? 'RECENT' : 'OPEN';
    const receiptIds = Array.isArray(context.receiptIds)
      ? context.receiptIds.filter((value): value is string => typeof value === 'string')
      : [];
    const receiptId = receiptIds[Number(action.slice(2))];
    if (!receiptId) return showDlqList(env, bootstrap, ctx, mode);
    return showDlqDetail(env, bootstrap, ctx, receiptId, mode);
  }
  if (action === 'dd') {
    const session = await getAdminSession(env, ctx.userId);
    if (session?.action !== 'RELIABILITY_DLQ_DETAIL' || !session.context_json) {
      return showDlqList(env, bootstrap, ctx, 'OPEN');
    }
    const context = JSON.parse(session.context_json) as { mode?: string; receiptId?: unknown };
    const mode = context.mode === 'RECENT' ? 'RECENT' : 'OPEN';
    return typeof context.receiptId === 'string'
      ? showDlqDetail(env, bootstrap, ctx, context.receiptId, mode)
      : showDlqList(env, bootstrap, ctx, mode);
  }
  if (action === 'dr') {
    const session = await getAdminSession(env, ctx.userId);
    if (session?.action !== 'RELIABILITY_DLQ_DETAIL' || !session.context_json) {
      return showDlqList(env, bootstrap, ctx, 'OPEN');
    }
    const context = JSON.parse(session.context_json) as { mode?: string; receiptId?: unknown };
    const mode = context.mode === 'RECENT' ? 'RECENT' : 'OPEN';
    if (typeof context.receiptId !== 'string') return showDlqList(env, bootstrap, ctx, mode);
    const eligibility = await getDlqAiRedriveEligibility(env, context.receiptId);
    if (!eligibility.eligible) {
      return showDlqDetail(
        env,
        bootstrap,
        ctx,
        context.receiptId,
        mode,
        `AI 重放不可用：${REDRIVE_REASON_LABELS[eligibility.reason]}`
      );
    }
    await saveAdminSession(env, {
      ...session,
      action: 'RELIABILITY_DLQ_REDRIVE_CONFIRM'
    });
    await reply(bootstrap, ctx, [
      '确认请求 AI 重放？',
      '',
      `回执：${safeDisplay(context.receiptId)}`,
      `事件：${safeDisplay(eligibility.event?.eventId || null, 256)}`,
      '在 canonical 处理成功前，该回执会继续保持 OPEN。'
    ].join('\n'), [
      [{ text: '确认重放', callback_data: 'r:dy' }],
      [{ text: '取消', callback_data: 'r:dn' }]
    ]);
    return 'REL_DLQ_REDRIVE_CONFIRM_BEGIN';
  }
  if (action === 'dy' || action === 'dn') {
    const session = await getAdminSession(env, ctx.userId);
    if (session?.action !== 'RELIABILITY_DLQ_REDRIVE_CONFIRM' || !session.context_json) {
      return showDlqList(env, bootstrap, ctx, 'OPEN');
    }
    const context = JSON.parse(session.context_json) as { mode?: string; receiptId?: unknown };
    const mode = context.mode === 'RECENT' ? 'RECENT' : 'OPEN';
    if (typeof context.receiptId !== 'string') return showDlqList(env, bootstrap, ctx, mode);
    if (action === 'dn') {
      return showDlqDetail(env, bootstrap, ctx, context.receiptId, mode, '已取消 AI 重放。');
    }
    const result = await requestDlqAiRedrive(
      env,
      context.receiptId,
      ctx.userId,
      ctx.updateId
    );
    const alert = result.status === 'ENQUEUED'
      ? '已请求 AI 重放。'
      : result.status === 'ALREADY_REQUESTED'
        ? '这条管理员命令已经记录，无需重复提交。'
        : `AI 重放不可用：${REDRIVE_REASON_LABELS[result.eligibility.reason]}`;
    return showDlqDetail(env, bootstrap, ctx, context.receiptId, mode, alert);
  }
  if (action === 'unc') {
    const ops = await env.DB.prepare(
      `SELECT id, destination_provider, operation_type, subject_type FROM outbound_operations WHERE status = 'AMBIGUOUS' AND reconciliation_status IN ('PENDING', 'STILL_AMBIGUOUS') ORDER BY updated_at DESC LIMIT 10`
    ).all<{ id: string; destination_provider: string; operation_type: string; subject_type: string }>();
    
    if (!ops.results || ops.results.length === 0) {
      await reply(bootstrap, ctx, '没有发现不确定投递。', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_UNC';
    }
    
    const lines = ops.results.map(o => `${o.id}\n${o.destination_provider} ${o.operation_type} (${o.subject_type})`);
    
    await reply(bootstrap, ctx, `不确定投递（最多 10 条）：\n\n${lines.join('\n\n')}\n\n请使用“查询 Operation”并粘贴对应 ID。`, [
      [{ text: '🔎 查询 Operation', callback_data: 'r:look' }],
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_UNC';
  }
  
  if (action === 'look') {
    await saveAdminSession(env, {
      admin_user_id: ctx.userId, action: 'RELIABILITY_LOOKUP', target: 'OPERATION',
      expected_version: 0, candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null, context_json: null
    });
    await reply(bootstrap, ctx, '请发送 Operation ID：');
    return 'RELIABILITY_LOOKUP_BEGIN';
  }

  if (action === 'ai') {
    const runs = await env.DB.prepare(
      `SELECT trigger_event_ref, conversation_id, status, attempt_count, next_retry_at, last_error, updated_at FROM ai_runs WHERE status IN ('FAILED_RETRYABLE', 'RETRY_EXHAUSTED', 'FAILED_FINAL', 'CANCELLED_BY_HANDOFF', 'DISCARDED_STALE') ORDER BY updated_at DESC LIMIT 10`
    ).all<any>();
    
    if (!runs.results || runs.results.length === 0) {
      await reply(bootstrap, ctx, '没有发现 AI 可靠性问题。', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_AI';
    }
    
    const lines = runs.results.map(r => 
      `${r.trigger_event_ref}\n会话：${r.conversation_id}\n状态：${r.status}（尝试 ${r.attempt_count}）\n下次重试：${r.next_retry_at}\n错误：${r.last_error}\n更新时间：${r.updated_at}`
    );
    await reply(bootstrap, ctx, `AI 可靠性问题（最多 10 条）：\n\n${lines.join('\n\n')}`, [
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_AI';
  }

  if (action === 'aud') {
    const audits = await env.DB.prepare(
      `SELECT id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at FROM reliability_audit ORDER BY created_at DESC, id DESC LIMIT 10`
    ).all<any>();
    
    if (!audits.results || audits.results.length === 0) {
      await reply(bootstrap, ctx, '没有找到可靠性审计记录。', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_AUD';
    }
    
    const lines = audits.results.map(a => 
      `${a.created_at} | ${a.action}（${a.reason_code}）\n实体：${a.entity_type} ${a.entity_id}\n操作人：${a.actor_type} ${a.actor_ref}\n状态：${a.old_state} -> ${a.new_state}`
    );
    await reply(bootstrap, ctx, `可靠性审计（最近 10 条）：\n\n${lines.join('\n\n')}`, [
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_AUD';
  }
  
  if (action.startsWith('o:')) {
    const cmd = action.slice(2);
    const session = await getAdminSession(env, ctx.userId);
    const operationSessions = new Set([
      'RELIABILITY_INSPECT',
      'RELIABILITY_MARK_PROVIDER_REF',
      'RELIABILITY_MARK_CONFIRM',
      'RELIABILITY_CANCEL_CONFIRM',
      'RELIABILITY_RETRY_CONFIRM'
    ]);
    if (!session || !session.context_json || !operationSessions.has(session.action)) {
      await reply(bootstrap, ctx, '会话已过期或无效。', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_EXPIRED';
    }
    const { operationId, providerRef } = JSON.parse(session.context_json);
    
    if (cmd === 'recon') {
      if (session.action !== 'RELIABILITY_INSPECT') return await showOperationDetails(env, bootstrap, ctx, operationId, '操作无效：状态不匹配');
      try {
        await reconcileOutboundOperation(env, operationId);
        await reply(bootstrap, ctx, '已触发投递核对。');
      } catch (e: any) {
        await reply(bootstrap, ctx, `操作失败：${safeErrorCode(e)}`);
      }
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'mark_begin') {
      if (session.action !== 'RELIABILITY_INSPECT') return await showOperationDetails(env, bootstrap, ctx, operationId, '操作无效：状态不匹配');
      
      const op = await env.DB.prepare('SELECT operation_type FROM outbound_operations WHERE id = ?').bind(operationId).first<{ operation_type: string }>();
      if (op?.operation_type === 'CREATE_TOPIC') {
        await saveAdminSession(env, { ...session, action: 'RELIABILITY_MARK_PROVIDER_REF' });
        await reply(bootstrap, ctx, '请输入该 CREATE_TOPIC 操作实际使用的 Provider message/thread ref：');
        return 'REL_MARK_PROV_REF';
      }
      
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_MARK_CONFIRM' });
      await reply(bootstrap, ctx, `确认将此操作标记为已送达？\n\n原因：OPERATOR_CONFIRMED_DELIVERY`, [
        [{ text: '确认标记已送达', callback_data: 'r:o:mark_yes' }],
        [{ text: '取消', callback_data: 'r:o:cancel_action' }]
      ]);
      return 'REL_MARK_CONFIRM_BEGIN';
    }

    if (cmd === 'mark_yes') {
      if (session.action !== 'RELIABILITY_MARK_CONFIRM') {
         await reply(bootstrap, ctx, '操作无效：确认会话状态不匹配。');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualMarkDelivered(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_CONFIRMED_DELIVERY', providerRef);
        await reply(bootstrap, ctx, '已标记为送达。');
      } catch (e: any) {
        await reply(bootstrap, ctx, `操作失败：${safeErrorCode(e)}`);
      }
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'cancel_begin') {
      if (session.action !== 'RELIABILITY_INSPECT') return await showOperationDetails(env, bootstrap, ctx, operationId, '操作无效：状态不匹配');
      
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_CANCEL_CONFIRM' });
      await reply(bootstrap, ctx, `确认取消此操作？\n此操作不再继续发送，但不代表外部未送达。\n\n原因：OPERATOR_CANCELLED`, [
        [{ text: '确认取消操作', callback_data: 'r:o:cancel_yes' }],
        [{ text: '取消', callback_data: 'r:o:cancel_action' }]
      ]);
      return 'REL_CANCEL_CONFIRM_BEGIN';
    }

    if (cmd === 'cancel_yes') {
      if (session.action !== 'RELIABILITY_CANCEL_CONFIRM') {
         await reply(bootstrap, ctx, '操作无效：确认会话状态不匹配。');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualCancel(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_CANCELLED');
        await reply(bootstrap, ctx, '已取消。');
      } catch (e: any) {
        await reply(bootstrap, ctx, `操作失败：${safeErrorCode(e)}`);
      }
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'retry_begin') {
      if (session.action !== 'RELIABILITY_INSPECT') return await showOperationDetails(env, bootstrap, ctx, operationId, '操作无效：状态不匹配');
      
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_RETRY_CONFIRM' });
      await reply(bootstrap, ctx, `⚠️ 危险: 手动重试可能导致外部可见的重复操作（如重复发信）。\n\n您是否明确接受重复风险并继续重试？\n原因: OPERATOR_ACCEPTS_DUPLICATE_RISK`, [
        [{ text: '我接受风险，确认重试', callback_data: 'r:o:retry_yes' }],
        [{ text: '取消', callback_data: 'r:o:cancel_action' }]
      ]);
      return 'REL_RETRY_CONFIRM_BEGIN';
    }
    
    if (cmd === 'retry_yes') {
      if (session.action !== 'RELIABILITY_RETRY_CONFIRM') {
         await reply(bootstrap, ctx, '操作无效：确认会话状态不匹配。');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualRetryOutboundOperation(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK');
        await reply(bootstrap, ctx, '已执行手动重试。');
      } catch (e: any) {
        await reply(bootstrap, ctx, `操作失败：${safeErrorCode(e)}`);
      }
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'cancel_action') {
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      await reply(bootstrap, ctx, '已取消当前操作。');
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'refresh') {
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
  }

  return 'UNKNOWN_RELIABILITY_ACTION';
}

export async function processReliabilityMessage(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, session: any): Promise<string> {
  const text = ctx.text?.trim() || '';

  if (session.action === 'RELIABILITY_LOOKUP') {
    if (!text || text.length > 100 || /[\u0000-\u001f\u007f]/.test(text)) {
      await reply(bootstrap, ctx, 'ID 格式无效。');
      return 'RELIABILITY_LOOKUP_FAILED';
    }
    return await showOperationDetails(env, bootstrap, ctx, text);
  }
  
  if (session.action === 'RELIABILITY_MARK_PROVIDER_REF') {
    if (!text || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) {
      await reply(bootstrap, ctx, 'Provider ref 格式无效。');
      return 'RELIABILITY_MARK_PROV_REF_FAILED';
    }
    
    const context = JSON.parse(session.context_json || '{}');
    context.providerRef = text;
    
    await saveAdminSession(env, {
      ...session,
      action: 'RELIABILITY_MARK_CONFIRM',
      context_json: JSON.stringify(context)
    });
    
    await reply(bootstrap, ctx, `CREATE_TOPIC Provider ref 已暂存为：${text}\n\n确认将此操作标记为已送达？\n\n原因：OPERATOR_CONFIRMED_DELIVERY`, [
      [{ text: '确认标记已送达', callback_data: 'r:o:mark_yes' }],
      [{ text: '取消', callback_data: 'r:o:cancel_action' }]
    ]);
    return 'RELIABILITY_MARK_CONFIRM_BEGIN';
  }

  throw new SafeError('CONFIRMATION_REQUIRED');
}

export async function showOperationDetails(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, operationId: string, alert?: string): Promise<string> {
  const op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(operationId).first<OutboundOperation>();
  if (!op) {
    await reply(bootstrap, ctx, '未找到该 Operation。');
    await clearAdminSession(env, ctx.userId);
    return 'REL_OP_NOT_FOUND';
  }
  
  const children = await env.DB.prepare('SELECT id FROM outbound_operations WHERE parent_operation_id = ?').bind(operationId).all<{id: string}>();
  let childText = 'N/A';
  if (children.results && children.results.length > 1) {
    throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  } else if (children.results && children.results.length === 1) {
    childText = children.results[0].id;
  }
  
  await saveAdminSession(env, {
    admin_user_id: ctx.userId, action: 'RELIABILITY_INSPECT', target: 'OPERATION',
    expected_version: 0, candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null,
    context_json: JSON.stringify({ operationId })
  });

  const text = [
    ...(alert ? [`⚠️ ${alert}`, ``] : []),
    `ID: ${op.id}`,
    `会话：${op.conversation_id}`,
    `Provider：${op.destination_provider}`,
    `类型：${op.operation_type}`,
    `状态：${op.status}`,
    `核对状态：${op.reconciliation_status}`,
    `业务对象：${op.subject_type} / ${op.subject_ref}`,
    `父 Operation ID：${op.parent_operation_id || 'N/A'}`,
    `子 Operation ID：${childText}`,
    `Provider 消息引用：${op.provider_message_ref || 'N/A'}`,
    `尝试次数：${op.attempt_count}`,
    `request_started_at: ${op.request_started_at}`,
    `response_observed_at: ${op.response_observed_at}`,
    `response_http_status: ${op.response_http_status}`,
    `next_retry_at: ${op.next_retry_at}`,
    `resolved_by: ${op.resolved_by}`,
    `resolved_at: ${op.resolved_at}`,
    `resolution_reason: ${op.resolution_reason}`,
    `updated_at: ${op.updated_at}`
  ].join('\n');

  await reply(bootstrap, ctx, text, [
    [{ text: '🔄 核对投递', callback_data: 'r:o:recon' }, { text: '刷新', callback_data: 'r:o:refresh' }],
    [{ text: '✅ 标记已送达', callback_data: 'r:o:mark_begin' }, { text: '🚫 取消操作', callback_data: 'r:o:cancel_begin' }],
    [{ text: '⚠️ 手动重试', callback_data: 'r:o:retry_begin' }],
    [{ text: '返回可靠性管理', callback_data: 'p:rel' }]
  ]);
  return 'REL_INSPECT';
}
