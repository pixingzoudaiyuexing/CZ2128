import { Env } from '../config/env';
import { reply } from './ui';
import { AdminBootstrap, AdminContext } from './types';
import { OutboundOperation } from '../core/domain';
import { manualMarkDelivered, manualCancel, reconcileOutboundOperation } from '../core/outbound-reconciliation';
import { manualRetryOutboundOperation, MANUAL_RETRY_REASONS } from '../core/outbound-manual-retry';
import { resolveOutboundDomainState } from '../core/outbound-domain-resolution';
import { saveAdminSession, getAdminSession, clearAdminSession } from '../runtime-config/repository';
import { SafeError } from '../core/errors';

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
    `Recently manually resolved: ${manualResolved?.c || 0}`,
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
      `SELECT id, destination_provider, operation_type, subject_type FROM outbound_operations WHERE status = 'AMBIGUOUS' AND reconciliation_status IN ('PENDING', 'STILL_AMBIGUOUS') ORDER BY updated_at ASC LIMIT 10`
    ).all<{ id: string; destination_provider: string; operation_type: string; subject_type: string }>();
    
    if (!ops.results || ops.results.length === 0) {
      await reply(bootstrap, ctx, 'No uncertain deliveries found.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_UNC';
    }
    
    const lines = ops.results.map(o => `${o.id}\n${o.destination_provider} ${o.operation_type} (${o.subject_type})`);
    const buttons = ops.results.map(o => [{ text: `Inspect ${o.id.split('-')[0]}`, callback_data: `r:o:${o.id.split('-')[0]}` }]);
    
    // Actually UUIDs inside callbacks are too long, so I'll just ask them to type it, or just use r:o:<first-8-chars>
    // but first 8 chars might collide. 
    // To strictly avoid callback length issues and binding problems:
    await reply(bootstrap, ctx, `Uncertain Deliveries (Top 10):\n\n${lines.join('\n\n')}\n\nPlease use "Lookup Operation" and paste the ID, or reply with the Operation ID.`, [
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
      `SELECT trigger_event_ref, status, attempt_count, next_retry_at FROM ai_runs WHERE status IN ('FAILED_RETRYABLE', 'RETRY_EXHAUSTED', 'FAILED_FINAL') ORDER BY updated_at DESC LIMIT 10`
    ).all<any>();
    
    if (!runs.results || runs.results.length === 0) {
      await reply(bootstrap, ctx, 'No AI reliability issues found.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_AI';
    }
    
    const lines = runs.results.map(r => `${r.trigger_event_ref} | ${r.status} (attempts: ${r.attempt_count})`);
    await reply(bootstrap, ctx, `AI Reliability Issues (Top 10):\n\n${lines.join('\n')}`, [
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_AI';
  }

  if (action === 'aud') {
    const audits = await env.DB.prepare(
      `SELECT id, entity_type, entity_id, action, reason_code, created_at FROM reliability_audit ORDER BY created_at DESC, id DESC LIMIT 10`
    ).all<any>();
    
    if (!audits.results || audits.results.length === 0) {
      await reply(bootstrap, ctx, 'No reliability audit logs found.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_AUD';
    }
    
    const lines = audits.results.map(a => `${new Date(a.created_at * 1000).toISOString()} | ${a.action} (${a.reason_code})\n${a.entity_type} ${a.entity_id}`);
    await reply(bootstrap, ctx, `Reliability Audit (Latest 10):\n\n${lines.join('\n\n')}`, [
      [{ text: '返回', callback_data: 'p:rel' }]
    ]);
    return 'REL_AUD';
  }
  
  if (action.startsWith('o:')) {
    // This is from session-based action
    const cmd = action.slice(2);
    const session = await getAdminSession(env, ctx.userId);
    if (!session || session.action !== 'RELIABILITY_INSPECT' && session.action !== 'RELIABILITY_RETRY_CONFIRM' || !session.context_json) {
      await reply(bootstrap, ctx, 'Session expired or invalid.', [[{ text: '返回', callback_data: 'p:rel' }]]);
      return 'REL_EXPIRED';
    }
    const { operationId } = JSON.parse(session.context_json);
    
    if (cmd === 'recon') {
      try {
        await reconcileOutboundOperation(env, operationId);
        await reply(bootstrap, ctx, 'Reconciliation triggered.');
      } catch (e: any) {
        await reply(bootstrap, ctx, `Reconciliation failed: ${e.message}`);
      }
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'mark') {
      try {
        await manualMarkDelivered(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_CONFIRMED_DELIVERY');
        await reply(bootstrap, ctx, 'Marked as delivered.');
      } catch (e: any) {
        await reply(bootstrap, ctx, `Failed: ${e.message}`);
      }
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'cancel') {
      try {
        await manualCancel(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_CANCELLED');
        await reply(bootstrap, ctx, 'Cancelled.');
      } catch (e: any) {
        await reply(bootstrap, ctx, `Failed: ${e.message}`);
      }
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'retry') {
      // Need duplicate risk confirmation
      await saveAdminSession(env, {
        ...session,
        action: 'RELIABILITY_RETRY_CONFIRM'
      });
      await reply(bootstrap, ctx, `⚠️ DANGER: Manual retry can cause visible external side-effects (e.g., duplicate message).\n\nDo you explicitly accept the duplicate risk?`, [
        [{ text: 'Yes, Accept Risk & Retry', callback_data: 'r:o:retry_yes' }],
        [{ text: 'No, Cancel', callback_data: 'r:o:retry_no' }]
      ]);
      return 'REL_RETRY_CONFIRM';
    }
    
    if (cmd === 'retry_yes') {
      if (session.action !== 'RELIABILITY_RETRY_CONFIRM') {
         await reply(bootstrap, ctx, 'Invalid session state for retry confirm.');
         return await showOperationDetails(env, bootstrap, ctx, operationId);
      }
      try {
        await manualRetryOutboundOperation(env, operationId, { type: 'ADMIN', ref: ctx.userId }, 'OPERATOR_ACCEPTS_DUPLICATE_RISK');
        await reply(bootstrap, ctx, 'Retry executed.');
      } catch (e: any) {
        await reply(bootstrap, ctx, `Retry failed: ${e.message}`);
      }
      // Reset session action
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'retry_no') {
      await saveAdminSession(env, { ...session, action: 'RELIABILITY_INSPECT' });
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
    
    if (cmd === 'refresh') {
      return await showOperationDetails(env, bootstrap, ctx, operationId);
    }
  }

  return 'UNKNOWN_RELIABILITY_ACTION';
}

export async function processReliabilityMessage(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, session: any): Promise<string> {
  if (session.action === 'RELIABILITY_LOOKUP') {
    const operationId = ctx.text?.trim();
    if (!operationId) {
      await reply(bootstrap, ctx, 'Invalid ID format.');
      return 'RELIABILITY_LOOKUP_FAILED';
    }
    return await showOperationDetails(env, bootstrap, ctx, operationId);
  }
  throw new Error('CONFIRMATION_REQUIRED');
}

export async function showOperationDetails(env: Env, bootstrap: AdminBootstrap, ctx: AdminContext, operationId: string): Promise<string> {
  const op = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?').bind(operationId).first<OutboundOperation>();
  if (!op) {
    await reply(bootstrap, ctx, 'Operation not found.');
    await clearAdminSession(env, ctx.userId);
    return 'REL_OP_NOT_FOUND';
  }
  
  await saveAdminSession(env, {
    admin_user_id: ctx.userId, action: 'RELIABILITY_INSPECT', target: 'OPERATION',
    expected_version: 0, candidate_value_text: null, candidate_ciphertext: null, candidate_nonce: null,
    context_json: JSON.stringify({ operationId })
  });

  const text = [
    `ID: ${op.id}`,
    `Provider: ${op.destination_provider}`,
    `Type: ${op.operation_type}`,
    `Status: ${op.status}`,
    `Recon Status: ${op.reconciliation_status}`,
    `Subject: ${op.subject_type} / ${op.subject_ref}`,
    `Parent ID: ${op.parent_operation_id || 'N/A'}`
  ].join('\n');

  // We do not render the target_evidence_json or secrets per privacy rules.
  await reply(bootstrap, ctx, text, [
    [{ text: '🔄 Reconcile', callback_data: 'r:o:recon' }, { text: 'Refresh', callback_data: 'r:o:refresh' }],
    [{ text: '✅ Mark Delivered', callback_data: 'r:o:mark' }, { text: '🚫 Cancel', callback_data: 'r:o:cancel' }],
    [{ text: '⚠️ Manual Retry', callback_data: 'r:o:retry' }],
    [{ text: '返回 Reliability', callback_data: 'p:rel' }]
  ]);
  return 'REL_INSPECT';
}
