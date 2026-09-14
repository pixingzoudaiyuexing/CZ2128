import { Env } from '../config/env';
import { AttachmentRow } from './attachments';
import { Conversation, OutboundOperation } from './domain';
import { RetryableProcessingError, SafeError } from './errors';
import { parseTargetEvidence } from './outbound-evidence';
import { auditAfterPreviousChange, d1Changed } from './reliability-audit';

export interface DomainResolutionResult {
  changed: boolean;
  domain: 'NONE' | 'ATTACHMENT' | 'CONVERSATION';
}

async function loadOperation(env: Env, operationId: string): Promise<OutboundOperation> {
  const operation = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
    .bind(operationId).first<OutboundOperation>();
  if (!operation) throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  return operation;
}

function isEffectivelyDelivered(operation: OutboundOperation): boolean {
  return operation.status === 'SENT' || (
    operation.status === 'AMBIGUOUS' &&
    (operation.reconciliation_status === 'CONFIRMED_SENT' ||
      operation.reconciliation_status === 'MANUAL_MARK_DELIVERED')
  );
}

async function stableAuditId(operationId: string, action: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([operationId, action]))
  );
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `domain:${hex}`;
}

async function auditConflict(env: Env, operation: OutboundOperation, reasonCode: string): Promise<never> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO reliability_audit
     (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
     VALUES (?, 'OUTBOUND_OPERATION', ?, 'DOMAIN_STATE_CONFLICT', 'SYSTEM',
             'system:outbound-domain-resolution', NULL, NULL, ?, ?)`
  ).bind(
    await stableAuditId(operation.id, `DOMAIN_STATE_CONFLICT:${reasonCode}`),
    operation.id,
    reasonCode,
    Math.floor(Date.now() / 1000)
  ).run();
  throw new SafeError('OUTBOUND_DOMAIN_STATE_CONFLICT');
}

async function applyWithAudit(
  env: Env,
  operation: OutboundOperation,
  statement: D1PreparedStatement,
  oldState: string,
  newState: string,
  reasonCode: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    statement,
    auditAfterPreviousChange(env, {
      id: await stableAuditId(operation.id, 'DOMAIN_STATE_RESOLVED'),
      entityType: 'OUTBOUND_OPERATION',
      entityId: operation.id,
      action: 'DOMAIN_STATE_RESOLVED',
      actorType: 'SYSTEM',
      actorRef: 'system:outbound-domain-resolution',
      oldState,
      newState,
      reasonCode,
      createdAt: now
    })
  ]);
  if (d1Changed(results[0]) !== d1Changed(results[1])) {
    throw new RetryableProcessingError('D1_RESULT_PERSIST_FAILED', 5);
  }
  return d1Changed(results[0]);
}

async function resolveAttachment(
  env: Env,
  operation: OutboundOperation
): Promise<DomainResolutionResult> {
  if (operation.operation_type !== 'SEND_ATTACHMENT' || !operation.subject_ref) {
    return auditConflict(env, operation, 'ATTACHMENT_OPERATION_IDENTITY_INVALID');
  }
  const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?')
    .bind(operation.subject_ref).first<AttachmentRow>();
  if (
    !row || row.conversation_id !== operation.conversation_id ||
    row.destination_provider !== operation.destination_provider
  ) {
    return auditConflict(env, operation, 'ATTACHMENT_DOMAIN_IDENTITY_CONFLICT');
  }
  try {
    const evidence = operation.target_evidence_json
      ? parseTargetEvidence(operation.target_evidence_json)
      : null;
    if (!evidence || evidence.provider !== operation.destination_provider) {
      return auditConflict(env, operation, 'ATTACHMENT_TARGET_EVIDENCE_INVALID');
    }
  } catch {
    return auditConflict(env, operation, 'ATTACHMENT_TARGET_EVIDENCE_INVALID');
  }
  const providerRef = operation.provider_message_ref;
  if (row.status === 'DELIVERED') {
    if (row.destination_message_ref && providerRef && row.destination_message_ref !== providerRef) {
      return auditConflict(env, operation, 'ATTACHMENT_PROVIDER_REF_CONFLICT');
    }
    if (!row.destination_message_ref && providerRef) {
      const changed = await applyWithAudit(
        env,
        operation,
        env.DB.prepare(
          `UPDATE attachments SET destination_message_ref = ?, last_error = NULL, updated_at = ?
           WHERE id = ? AND status = 'DELIVERED' AND destination_message_ref IS NULL`
        ).bind(providerRef, Math.floor(Date.now() / 1000), row.id),
        'DELIVERED_WITHOUT_PROVIDER_REF',
        'DELIVERED',
        'ATTACHMENT_PROVIDER_REF_REPAIRED'
      );
      return { changed, domain: 'ATTACHMENT' };
    }
    return { changed: false, domain: 'ATTACHMENT' };
  }
  const eligible = row.status === 'STORED' || (
    row.status === 'FAILED_FINAL' && row.last_error === 'ATTACHMENT_DELIVERY_AMBIGUOUS'
  );
  if (!eligible) return auditConflict(env, operation, 'ATTACHMENT_STATE_NOT_DELIVERABLE');

  const changed = await applyWithAudit(
    env,
    operation,
    env.DB.prepare(
      `UPDATE attachments
       SET status = 'DELIVERED', destination_message_ref = COALESCE(?, destination_message_ref),
           last_error = NULL, updated_at = ?
       WHERE id = ? AND conversation_id = ? AND destination_provider = ?
         AND (status = 'STORED' OR (status = 'FAILED_FINAL' AND last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS'))`
    ).bind(
      providerRef,
      Math.floor(Date.now() / 1000),
      row.id,
      operation.conversation_id,
      operation.destination_provider
    ),
    row.status,
    'DELIVERED',
    'ATTACHMENT_EFFECTIVE_DELIVERY'
  );
  if (!changed) return resolveAttachment(env, operation);
  return { changed: true, domain: 'ATTACHMENT' };
}

async function loadConversation(env: Env, operation: OutboundOperation): Promise<Conversation> {
  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
    .bind(operation.conversation_id).first<Conversation>();
  if (!conversation || operation.subject_ref !== conversation.id) {
    return auditConflict(env, operation, 'CONVERSATION_DOMAIN_IDENTITY_CONFLICT');
  }
  return conversation;
}

async function resolveCreateTopic(
  env: Env,
  operation: OutboundOperation,
  conversation: Conversation
): Promise<DomainResolutionResult> {
  const topicRef = operation.provider_message_ref;
  if (!topicRef) return auditConflict(env, operation, 'CREATE_TOPIC_PROVIDER_REF_REQUIRED');
  if (conversation.operator_thread_ref === topicRef) {
    return { changed: false, domain: 'CONVERSATION' };
  }
  if (conversation.operator_thread_ref !== null) {
    return auditConflict(env, operation, 'CREATE_TOPIC_THREAD_CONFLICT');
  }
  const changed = await applyWithAudit(
    env,
    operation,
    env.DB.prepare(
      `UPDATE conversations
       SET operator_thread_ref = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND operator_thread_ref IS NULL AND version = ?`
    ).bind(topicRef, Math.floor(Date.now() / 1000), conversation.id, conversation.version),
    'THREAD_REF_NULL',
    'THREAD_REF_SET',
    'CREATE_TOPIC_EFFECTIVE_DELIVERY'
  );
  if (!changed) return resolveCreateTopic(env, operation, await loadConversation(env, operation));
  return { changed: true, domain: 'CONVERSATION' };
}

async function resolveTopicStatus(
  env: Env,
  operation: OutboundOperation,
  conversation: Conversation,
  nextStatus: 'OPEN' | 'CLOSED'
): Promise<DomainResolutionResult> {
  let evidence;
  try {
    evidence = operation.target_evidence_json ? parseTargetEvidence(operation.target_evidence_json) : null;
  } catch {
    return auditConflict(env, operation, 'CONVERSATION_TARGET_EVIDENCE_INVALID');
  }
  if (
    !evidence || evidence.provider !== 'telegram' || !evidence.threadRef ||
    evidence.threadRef !== conversation.operator_thread_ref
  ) {
    return auditConflict(env, operation, 'CONVERSATION_THREAD_TARGET_CONFLICT');
  }
  if (conversation.operator_thread_status === nextStatus) {
    return { changed: false, domain: 'CONVERSATION' };
  }
  const expectedStatus = nextStatus === 'CLOSED' ? 'OPEN' : 'CLOSED';
  if (conversation.operator_thread_status !== expectedStatus) {
    return auditConflict(env, operation, 'CONVERSATION_STATUS_INVALID');
  }
  const changed = await applyWithAudit(
    env,
    operation,
    env.DB.prepare(
      `UPDATE conversations
       SET operator_thread_status = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND version = ? AND operator_thread_status = ? AND operator_thread_ref = ?`
    ).bind(
      nextStatus,
      Math.floor(Date.now() / 1000),
      conversation.id,
      conversation.version,
      expectedStatus,
      evidence.threadRef
    ),
    expectedStatus,
    nextStatus,
    `${operation.operation_type}_EFFECTIVE_DELIVERY`
  );
  if (!changed) {
    return resolveTopicStatus(env, operation, await loadConversation(env, operation), nextStatus);
  }
  return { changed: true, domain: 'CONVERSATION' };
}

async function resolveConversation(
  env: Env,
  operation: OutboundOperation
): Promise<DomainResolutionResult> {
  if (operation.destination_provider !== 'telegram') {
    return auditConflict(env, operation, 'CONVERSATION_PROVIDER_INVALID');
  }
  let evidence;
  try {
    evidence = operation.target_evidence_json ? parseTargetEvidence(operation.target_evidence_json) : null;
  } catch {
    return auditConflict(env, operation, 'CONVERSATION_TARGET_EVIDENCE_INVALID');
  }
  const expectedMethod = operation.operation_type === 'CREATE_TOPIC'
    ? 'createForumTopic'
    : operation.operation_type === 'CLOSE_TOPIC'
      ? 'closeForumTopic'
      : operation.operation_type === 'REOPEN_TOPIC'
        ? 'reopenForumTopic'
        : null;
  if (!evidence || evidence.provider !== 'telegram' || evidence.method !== expectedMethod) {
    return auditConflict(env, operation, 'CONVERSATION_TARGET_EVIDENCE_INVALID');
  }
  const currentGroup = env.BOT_GROUP_ID;
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.BOT_GROUP_ID ||
    !/^-100\d{1,16}$/.test(currentGroup) ||
    evidence.groupRef !== currentGroup
  ) {
    return auditConflict(env, operation, 'CONVERSATION_GROUP_TARGET_CONFLICT');
  }
  const conversation = await loadConversation(env, operation);
  if (operation.operation_type === 'CREATE_TOPIC') {
    return resolveCreateTopic(env, operation, conversation);
  }
  if (operation.operation_type === 'CLOSE_TOPIC') {
    return resolveTopicStatus(env, operation, conversation, 'CLOSED');
  }
  if (operation.operation_type === 'REOPEN_TOPIC') {
    return resolveTopicStatus(env, operation, conversation, 'OPEN');
  }
  return auditConflict(env, operation, 'CONVERSATION_OPERATION_INVALID');
}

export async function resolveOutboundDomainState(
  env: Env,
  operationId: string
): Promise<DomainResolutionResult> {
  const operation = await loadOperation(env, operationId);
  if (!isEffectivelyDelivered(operation)) {
    throw new SafeError('OUTBOUND_RECONCILIATION_NOT_ELIGIBLE');
  }
  if (operation.subject_type === 'MESSAGE' || operation.subject_type === 'AI_RUN' || operation.subject_type === 'CONTROL_ACK') {
    return { changed: false, domain: 'NONE' };
  }
  if (operation.subject_type === 'ATTACHMENT') return resolveAttachment(env, operation);
  if (operation.subject_type === 'CONVERSATION') return resolveConversation(env, operation);
  return auditConflict(env, operation, 'OUTBOUND_SUBJECT_IDENTITY_MISSING');
}
