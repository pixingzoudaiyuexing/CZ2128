import { Env } from '../config/env';
import { reply } from './ui';
import { AdminBootstrap, AdminContext } from './types';
import { OutboundOperation, AiRunStatus } from '../core/domain';
import { manualMarkDelivered, manualCancel, reconcileOutboundOperation } from '../core/outbound-reconciliation';
import { manualRetryOutboundOperation, MANUAL_RETRY_REASONS } from '../core/outbound-manual-retry';
import { resolveOutboundDomainState } from '../core/outbound-domain-resolution';
import { saveAdminSession, getAdminSession, clearAdminSession } from '../runtime-config/repository';
import { SafeErrorCode } from '../core/error-taxonomy';
import { safeErrorCode, SafeError } from '../core/errors';

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

  const text = [
    `🛡 Reliability Control Plane`,
    ``,
    `Unresolved AMBIGUOUS: ${unresolvedAmbiguous?.c || 0}`,
    `Pending automatic outbound retries: ${pendingRetries?.c || 0}`,
    `Manual resolutions: ${manualResolved?.c || 0}`,
    `AI FAILED_RETRYABLE: ${aiRetryable?.c || 0}`,
    `AI RETRY_EXHAUSTED: ${aiExhausted?.c || 0}`,
    `AI FAILED_FINAL: ${aiFinal?.c || 0}`
  ].join('\n');

  await reply(bootstrap, ctx, text, [
    [{ text: '⚠️ Uncertain Deliveries', callback_data: 'r:unc' }],
    [{ text: '🔎 Lookup Operation', callback_data: 'r:look' }],
    [{ text: '🤖 AI Reliability', callback_data: 'r:ai' }],
    [{ text: '📜 Reliability Audit', callback_data: 'r:aud' }],
    [{ text: '🔄 Refresh', callback_data: 'p:rel' }],
    [{ text: '返回', callback_data: 'm' }]
  ]);
}

export async function processReliabilityCallback(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, action: string): Promise<string> {
  if (action === 'unc') {
    const ops = await env.DB.prepare(
      `SELECT id, destination_provider, operation_type, subject_type FROM outbound_operations WHERE status = 'AMBIGUOUS' AND reconciliation_status IN ('PENDING', 'STILL_AMBIGUOUS') ORDER BY updated_at DESC LIMIT 10`
    ).all<{ id: string; destination_provider: string; operation_type: string; subject_type: string }>();
    
    if (!ops.results || ops.results.length === 0) {
      await reply(bootstrap, ctx, 'No uncertain deliveries found.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_UNC';
    }
    
    const lines = ops.results.map(o => `${o.id}\n${o.destination_provider} ${o.operation_type} (${o.subject_type})`);
    
    await reply(bootstrap, ctx, `Uncertain Deliveries (Top 10):\n\n${lines.join('\n\n')}\n\nPlease use "Lookup Operation" and paste the ID.`, [
      [{ text: '🔎 Lookup Operation', callback_data: 'r:look' }],
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
      await reply(bootstrap, ctx, 'No AI reliability issues found.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_AI';
    }
    
    const lines = runs.results.map(r => 
      `${r.trigger_event_ref}\nConv: ${r.conversation_id}\nStatus: ${r.status} (attempt ${r.attempt_count})\nNext: ${r.next_retry_at}\nError: ${r.last_error}\nUpdated: ${r.updated_at}`
    );
    await reply(bootstrap, ctx, `AI Reliability Issues (Top 10):\n\n${lines.join('\n\n')}`, [
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_AI';
  }

  if (action === 'aud') {
    const audits = await env.DB.prepare(
      `SELECT id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at FROM reliability_audit ORDER BY created_at DESC, id DESC LIMIT 10`
    ).all<any>();
    
    if (!audits.results || audits.results.length === 0) {
      await reply(bootstrap, ctx, 'No reliability audit logs found.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_AUD';
    }
    
    const lines = audits.results.map(a => 
      `${a.created_at} | ${a.action} (${a.reason_code})\nEntity: ${a.entity_type} ${a.entity_id}\nActor: ${a.actor_type} ${a.actor_ref}\nState: ${a.old_state} -> ${a.new_state}`
    );
    await reply(bootstrap, ctx, `Reliability Audit (Latest 10):\n\n${lines.join('\n\n')}`, [
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_AUD';
  }
  
  if (action.startsWith('o:')) {
    const cmd = action.slice(2);
    const session = await getAdminSession(env, ctx.userId);
    if (!session || !session.context_json || !session.action.startsWith('RELIABILITY_')) {
      await reply(bootstrap, ctx, 'Session expired or invalid.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_EXPIRED';
    }
    const { operationId, providerRef } = JSON.parse(session.context_json);
    
    if (cmd === 'recon') {
      if (session.action !== 'RELIABILITY_INSPECT') return await showOperationDetails(env, bootstrap, ctx, operationId, '操作无效：状态不匹配');
      try {
        await reconcileOutboundOperation(env, operationId);
        await reply(bootstrap, ctx, 'Reconciliation triggered.');
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
        await reply(bootstrap, ctx, '请输入该 CREATE_TOPIC 操作实际使用的 provider message/thread ref：');
        return 'REL_MARK_PROV_REF';
      }
      
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_MARK_CONFIRM' });
      await reply(bootstrap, ctx, `确认将此操作标记为已送达 (Mark Delivered)？\n\n原因: OPERATOR_CONFIRMED_DELIVERY`, [
        [{ text: '确认标记已送达', callback_data: 'r:o:mark_yes' }],
        [{ text: '取消', callback_data: 'r:o:cancel_action' }]
      ]);
      return 'REL_MARK_CONFIRM_BEGIN';
    }

    if (cmd === 'mark_yes') {
      if (session.action !== 'RELIABILITY_MARK_CONFIRM') {
         await reply(bootstrap, ctx, '操作无效：Confirmation session mismatch.');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualMarkDelivered(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_CONFIRMED_DELIVERY', providerRef);
        await reply(bootstrap, ctx, 'Marked as delivered.');
      } catch (e: any) {
        await reply(bootstrap, ctx, `操作失败：${safeErrorCode(e)}`);
      }
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'cancel_begin') {
      if (session.action !== 'RELIABILITY_INSPECT') return await showOperationDetails(env, bootstrap, ctx, operationId, '操作无效：状态不匹配');
      
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_CANCEL_CONFIRM' });
      await reply(bootstrap, ctx, `确认取消此操作 (Cancel)？\n此操作不再继续发送，但不代表外部未送达。\n\n原因: OPERATOR_CANCELLED`, [
        [{ text: '确认取消操作', callback_data: 'r:o:cancel_yes' }],
        [{ text: '取消', callback_data: 'r:o:cancel_action' }]
      ]);
      return 'REL_CANCEL_CONFIRM_BEGIN';
    }

    if (cmd === 'cancel_yes') {
      if (session.action !== 'RELIABILITY_CANCEL_CONFIRM') {
         await reply(bootstrap, ctx, '操作无效：Confirmation session mismatch.');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualCancel(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_CANCELLED');
        await reply(bootstrap, ctx, 'Cancelled.');
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
         await reply(bootstrap, ctx, '操作无效：Confirmation session mismatch.');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualRetryOutboundOperation(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK');
        await reply(bootstrap, ctx, 'Retry executed.');
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
      await reply(bootstrap, ctx, 'Invalid ID format.');
      return 'RELIABILITY_LOOKUP_FAILED';
    }
    return await showOperationDetails(env, bootstrap, ctx, text);
  }
  
  if (session.action === 'RELIABILITY_MARK_PROVIDER_REF') {
    if (!text || !/^[1-9]\d{0,15}$/.test(text)) {
      await reply(bootstrap, ctx, 'Invalid provider ref format.');
      return 'RELIABILITY_MARK_PROV_REF_FAILED';
    }
    
    const context = JSON.parse(session.context_json || '{}');
    context.providerRef = text;
    
    await saveAdminSession(env, {
      ...session,
      action: 'RELIABILITY_MARK_CONFIRM',
      context_json: JSON.stringify(context)
    });
    
    await reply(bootstrap, ctx, `CREATE_TOPIC provider ref 已暂存为: ${text}\n\n确认将此操作标记为已送达 (Mark Delivered)？\n\n原因: OPERATOR_CONFIRMED_DELIVERY`, [
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
    await reply(bootstrap, ctx, 'Operation not found.');
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
    `Conversation: ${op.conversation_id}`,
    `Provider: ${op.destination_provider}`,
    `Type: ${op.operation_type}`,
    `Status: ${op.status}`,
    `Recon Status: ${op.reconciliation_status}`,
    `Subject: ${op.subject_type} / ${op.subject_ref}`,
    `Parent ID: ${op.parent_operation_id || 'N/A'}`,
    `Child ID: ${childText}`,
    `Provider msg ref: ${op.provider_message_ref || 'N/A'}`,
    `Attempts: ${op.attempt_count}`,
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
    [{ text: '🔄 Reconcile', callback_data: 'r:o:recon' }, { text: 'Refresh', callback_data: 'r:o:refresh' }],
    [{ text: '✅ Mark Delivered', callback_data: 'r:o:mark_begin' }, { text: '🚫 Cancel', callback_data: 'r:o:cancel_begin' }],
    [{ text: '⚠️ Manual Retry', callback_data: 'r:o:retry_begin' }],
    [{ text: '返回 Reliability', callback_data: 'p:rel' }]
  ]);
  return 'REL_INSPECT';
}
