import { createChatwootMessage } from '../adapters/chatwoot/api';
import {
  closeTelegramTopic,
  createTelegramTopic,
  reopenTelegramTopic,
  sendTelegramMessage
} from '../adapters/telegram/api';
import {
  deliverAttachmentToChatwoot,
  deliverAttachmentToTelegram,
  loadAttachmentBuffer,
  telegramAttachmentMethod
} from '../attachments/delivery';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { AttachmentRow } from './attachments';
import { Conversation, Message, OutboundOperation } from './domain';
import { RetryableProcessingError, SafeError } from './errors';
import {
  buildChatwootTargetEvidence,
  buildTelegramTargetEvidence,
  manualRetryDestinationMatches,
  OutboundSubjectIdentity,
  OutboundTargetEvidence,
  serializeTargetEvidence,
  targetEvidenceMatches
} from './outbound-evidence';
import { resolveOutboundDomainState } from './outbound-domain-resolution';
import { executeOutboundOperation, OutboundAttemptLifecycle } from './outbound-operations';
import { auditAfterPreviousChange, d1Changed } from './reliability-audit';

export const MANUAL_RETRY_REASONS = ['OPERATOR_ACCEPTS_DUPLICATE_RISK'] as const;
export type ManualRetryReason = typeof MANUAL_RETRY_REASONS[number];

export interface ManualRetryActor {
  type: 'ADMIN';
  ref: string;
}

export interface ManualRetryResult {
  parentOperationId: string;
  childOperationId: string;
  childStatus: OutboundOperation['status'] | 'SENT';
  providerMessageRef?: string;
  created: boolean;
}

interface RetryPlan {
  subject: OutboundSubjectIdentity;
  targetEvidence: OutboundTargetEvidence;
  leaseSeconds?: number;
  action: (
    operationId: string,
    lifecycle: OutboundAttemptLifecycle
  ) => Promise<{ providerMessageRef?: string }>;
}

interface CreationGuard {
  sql: string;
  params: Array<string | number>;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function manualRetryChildId(parentOperationId: string): Promise<string> {
  return `manual_retry:${await sha256Hex(parentOperationId)}`;
}

function boundedActorRef(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
  return normalized;
}

async function loadOperation(env: Env, operationId: string): Promise<OutboundOperation> {
  const operation = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
    .bind(operationId).first<OutboundOperation>();
  if (!operation) throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  return operation;
}

async function loadConversation(env: Env, operation: OutboundOperation): Promise<Conversation> {
  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?')
    .bind(operation.conversation_id).first<Conversation>();
  if (!conversation) throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
  return conversation;
}

async function directChildren(env: Env, parentOperationId: string): Promise<OutboundOperation[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM outbound_operations WHERE parent_operation_id = ? ORDER BY id'
  ).bind(parentOperationId).all<OutboundOperation>();
  return rows.results || [];
}

function assertChildIdentity(parent: OutboundOperation, child: OutboundOperation, expectedId: string): void {
  if (
    child.id !== expectedId || child.parent_operation_id !== parent.id ||
    child.conversation_id !== parent.conversation_id ||
    child.destination_provider !== parent.destination_provider ||
    child.operation_type !== parent.operation_type ||
    child.subject_type !== parent.subject_type || child.subject_ref !== parent.subject_ref
  ) {
    throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  }
}

function assertSupportedParent(parent: OutboundOperation): asserts parent is OutboundOperation & {
  subject_type: 'MESSAGE' | 'ATTACHMENT' | 'CONVERSATION';
  subject_ref: string;
} {
  if (
    parent.status !== 'AMBIGUOUS' || !parent.subject_ref || !parent.target_evidence_json ||
    !['MESSAGE', 'ATTACHMENT', 'CONVERSATION'].includes(parent.subject_type || '')
  ) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
}

function canonicalTopicTitle(conversation: Conversation): string {
  const raw = `Customer ${conversation.customer_ref} | Chatwoot #${conversation.helpdesk_conversation_ref}`;
  const sanitized = raw.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return Array.from(sanitized).slice(0, 128).join('') || 'Customer conversation';
}

async function prepareMessageRetry(
  env: Env,
  parent: OutboundOperation & { subject_ref: string },
  conversation: Conversation,
  childId: string
): Promise<RetryPlan> {
  if (parent.operation_type !== 'SEND_MESSAGE') {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
  let provider: 'chatwoot' | 'telegram';
  let providerMessageRef: string;
  if (parent.subject_ref.startsWith('chatwoot:')) {
    provider = 'chatwoot';
    providerMessageRef = parent.subject_ref.slice('chatwoot:'.length);
    if (parent.destination_provider !== 'telegram') {
      throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
    }
  } else if (parent.subject_ref.startsWith('telegram:')) {
    provider = 'telegram';
    providerMessageRef = parent.subject_ref.slice('telegram:'.length);
    if (parent.destination_provider !== 'chatwoot') {
      throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
    }
  } else {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
  }
  if (!providerMessageRef) throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
  const message = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE conversation_id = ? AND provider = ? AND provider_message_ref = ?
       AND message_type = 'TEXT' AND text_content IS NOT NULL`
  ).bind(parent.conversation_id, provider, providerMessageRef).first<Message>();
  if (!message || message.text_content === null) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
  }

  if (parent.destination_provider === 'telegram') {
    if (!conversation.operator_thread_ref) {
      throw new SafeError('OUTBOUND_MANUAL_RETRY_TARGET_CHANGED');
    }
    const targetEvidence = buildTelegramTargetEvidence(
      env, env.BOT_GROUP_ID, conversation.operator_thread_ref, 'sendMessage'
    );
    return {
      subject: { type: 'MESSAGE', ref: parent.subject_ref },
      targetEvidence,
      action: async (_operationId, lifecycle) => {
        const response = await sendTelegramMessage(
          env, env.BOT_GROUP_ID, conversation.operator_thread_ref, message.text_content!, lifecycle
        );
        return { providerMessageRef: response.messageId };
      }
    };
  }

  const targetEvidence = await buildChatwootTargetEvidence(
    env,
    conversation.helpdesk_account_ref,
    conversation.helpdesk_conversation_ref,
    childId
  );
  return {
    subject: { type: 'MESSAGE', ref: parent.subject_ref },
    targetEvidence,
    action: async (operationId, lifecycle) => {
      const response = await createChatwootMessage(
        env,
        conversation.helpdesk_account_ref,
        conversation.helpdesk_conversation_ref,
        message.text_content!,
        operationId,
        lifecycle
      );
      return { providerMessageRef: response.messageId };
    }
  };
}

async function prepareAttachmentRetry(
  env: Env,
  parent: OutboundOperation & { subject_ref: string },
  conversation: Conversation,
  childId: string
): Promise<RetryPlan> {
  if (parent.operation_type !== 'SEND_ATTACHMENT') {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
  const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?')
    .bind(parent.subject_ref).first<AttachmentRow>();
  if (
    !row || row.conversation_id !== parent.conversation_id ||
    row.destination_provider !== parent.destination_provider
  ) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_PAYLOAD_UNAVAILABLE');
  }
  const retryableState = row.status === 'STORED' || (
    row.status === 'FAILED_FINAL' && row.last_error === 'ATTACHMENT_DELIVERY_AMBIGUOUS'
  );
  if (!retryableState) throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at === null || row.expires_at <= now) {
    throw new SafeError('ATTACHMENT_EXPIRED');
  }
  const config = getAttachmentConfig(env);
  const bytes = await loadAttachmentBuffer(env.ATTACHMENTS_BUCKET, row, config.maxBytes);

  if (row.destination_provider === 'telegram') {
    if (!conversation.operator_thread_ref) {
      throw new SafeError('OUTBOUND_MANUAL_RETRY_TARGET_CHANGED');
    }
    const targetEvidence = buildTelegramTargetEvidence(
      env,
      env.BOT_GROUP_ID,
      conversation.operator_thread_ref,
      telegramAttachmentMethod(row).method
    );
    return {
      subject: { type: 'ATTACHMENT', ref: row.id },
      targetEvidence,
      leaseSeconds: config.outboundLeaseSeconds,
      action: async (_operationId, lifecycle) => deliverAttachmentToTelegram(
        env, config, row, conversation.operator_thread_ref!, bytes, lifecycle
      )
    };
  }

  const targetEvidence = await buildChatwootTargetEvidence(
    env,
    conversation.helpdesk_account_ref,
    conversation.helpdesk_conversation_ref,
    childId
  );
  return {
    subject: { type: 'ATTACHMENT', ref: row.id },
    targetEvidence,
    leaseSeconds: config.outboundLeaseSeconds,
    action: async (operationId, lifecycle) => deliverAttachmentToChatwoot(
      env,
      config,
      row,
      conversation.helpdesk_account_ref,
      conversation.helpdesk_conversation_ref,
      operationId,
      bytes,
      lifecycle
    )
  };
}

function prepareConversationRetry(
  env: Env,
  parent: OutboundOperation & { subject_ref: string },
  conversation: Conversation
): RetryPlan {
  if (
    parent.subject_ref !== conversation.id || parent.destination_provider !== 'telegram' ||
    !['CREATE_TOPIC', 'CLOSE_TOPIC', 'REOPEN_TOPIC'].includes(parent.operation_type)
  ) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
  if (parent.operation_type === 'CREATE_TOPIC') {
    if (conversation.operator_thread_ref !== null) {
      throw new SafeError('OUTBOUND_MANUAL_RETRY_TARGET_CHANGED');
    }
    return {
      subject: { type: 'CONVERSATION', ref: conversation.id },
      targetEvidence: buildTelegramTargetEvidence(
        env, env.BOT_GROUP_ID, null, 'createForumTopic'
      ),
      action: async (_operationId, lifecycle) => {
        const response = await createTelegramTopic(
          env, env.BOT_GROUP_ID, canonicalTopicTitle(conversation), lifecycle
        );
        return { providerMessageRef: response.messageThreadId };
      }
    };
  }
  if (!conversation.operator_thread_ref) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_TARGET_CHANGED');
  }
  if (parent.operation_type === 'CLOSE_TOPIC') {
    return {
      subject: { type: 'CONVERSATION', ref: conversation.id },
      targetEvidence: buildTelegramTargetEvidence(
        env, env.BOT_GROUP_ID, conversation.operator_thread_ref, 'closeForumTopic'
      ),
      action: async (_operationId, lifecycle) => {
        await closeTelegramTopic(
          env, env.BOT_GROUP_ID, conversation.operator_thread_ref!, lifecycle
        );
        return {};
      }
    };
  }
  return {
    subject: { type: 'CONVERSATION', ref: conversation.id },
    targetEvidence: buildTelegramTargetEvidence(
      env, env.BOT_GROUP_ID, conversation.operator_thread_ref, 'reopenForumTopic'
    ),
    action: async (_operationId, lifecycle) => {
      await reopenTelegramTopic(
        env, env.BOT_GROUP_ID, conversation.operator_thread_ref!, lifecycle
      );
      return {};
    }
  };
}

async function prepareRetry(
  env: Env,
  parent: OutboundOperation & {
    subject_type: 'MESSAGE' | 'ATTACHMENT' | 'CONVERSATION';
    subject_ref: string;
  },
  childId: string
): Promise<RetryPlan> {
  const conversation = await loadConversation(env, parent);
  const plan = parent.subject_type === 'MESSAGE'
    ? await prepareMessageRetry(env, parent, conversation, childId)
    : parent.subject_type === 'ATTACHMENT'
      ? await prepareAttachmentRetry(env, parent, conversation, childId)
      : prepareConversationRetry(env, parent, conversation);
  if (!manualRetryDestinationMatches(parent.target_evidence_json!, plan.targetEvidence)) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_TARGET_CHANGED');
  }
  return plan;
}

async function createChildAtomically(
  env: Env,
  parent: OutboundOperation & {
    subject_type: 'MESSAGE' | 'ATTACHMENT' | 'CONVERSATION';
    subject_ref: string;
  },
  childId: string,
  targetEvidence: OutboundTargetEvidence,
  actorRef: string,
  reason: ManualRetryReason
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const targetEvidenceJson = serializeTargetEvidence(targetEvidence);
  const guard = creationGuard(parent, targetEvidence, now);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO outbound_operations
       (id, conversation_id, destination_provider, operation_type, status,
        provider_message_ref, attempt_count, lease_until, lease_token, last_error,
        created_at, updated_at, request_started_at, response_observed_at,
        response_http_status, next_retry_at, retry_after_seconds, reconciliation_status,
        resolved_by, resolved_at, resolution_reason, parent_operation_id,
        subject_type, subject_ref, target_evidence_json)
       SELECT ?, conversation_id, destination_provider, operation_type, 'PENDING',
              NULL, 0, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, 'NOT_REQUIRED',
              NULL, NULL, NULL, id, subject_type, subject_ref, ?
       FROM outbound_operations
       WHERE id = ? AND status = 'AMBIGUOUS'
         AND reconciliation_status = ?
         ${guard.sql}
         AND NOT EXISTS (
           SELECT 1 FROM outbound_operations child WHERE child.parent_operation_id = outbound_operations.id
         )
       ON CONFLICT (id) DO NOTHING`
    ).bind(
      childId,
      now,
      now,
      targetEvidenceJson,
      parent.id,
      parent.reconciliation_status,
      ...guard.params
    ),
    env.DB.prepare(
      `UPDATE outbound_operations
       SET reconciliation_status = 'MANUAL_RETRY_CREATED', resolved_by = ?, resolved_at = ?,
           resolution_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'AMBIGUOUS'
         AND reconciliation_status = ?
         AND changes() = 1
         AND EXISTS (
           SELECT 1 FROM outbound_operations child
           WHERE child.id = ? AND child.parent_operation_id = outbound_operations.id
         )`
    ).bind(
      `admin:${actorRef}`,
      now,
      reason,
      now,
      parent.id,
      parent.reconciliation_status,
      childId
    ),
    auditAfterPreviousChange(env, {
      id: `manual-retry:${await sha256Hex(parent.id)}`,
      entityType: 'OUTBOUND_OPERATION',
      entityId: parent.id,
      action: 'MANUAL_RETRY_CHILD_CREATED',
      actorType: 'ADMIN',
      actorRef,
      oldState: parent.reconciliation_status,
      newState: 'MANUAL_RETRY_CREATED',
      reasonCode: reason,
      createdAt: now
    })
  ]);
  const inserted = d1Changed(results[0]);
  const transitioned = d1Changed(results[1]);
  const audited = d1Changed(results[2]);
  if (inserted !== transitioned || transitioned !== audited) {
    throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  }
  return inserted;
}

function creationGuard(
  parent: OutboundOperation & {
    subject_type: 'MESSAGE' | 'ATTACHMENT' | 'CONVERSATION';
    subject_ref: string;
  },
  targetEvidence: OutboundTargetEvidence,
  now: number
): CreationGuard {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (targetEvidence.provider === 'chatwoot') {
    clauses.push(
      `AND EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.id = outbound_operations.conversation_id
           AND c.helpdesk_account_ref = ? AND c.helpdesk_conversation_ref = ?
       )`
    );
    params.push(targetEvidence.accountRef, targetEvidence.conversationRef);
  } else if (parent.operation_type === 'CREATE_TOPIC') {
    clauses.push(
      `AND EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.id = outbound_operations.conversation_id AND c.operator_thread_ref IS NULL
       )`
    );
  } else {
    clauses.push(
      `AND EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.id = outbound_operations.conversation_id AND c.operator_thread_ref = ?
       )`
    );
    params.push(targetEvidence.threadRef || '');
  }

  if (parent.subject_type === 'ATTACHMENT') {
    clauses.push(
      `AND EXISTS (
         SELECT 1 FROM attachments a
         WHERE a.id = outbound_operations.subject_ref
           AND a.conversation_id = outbound_operations.conversation_id
           AND a.destination_provider = outbound_operations.destination_provider
           AND a.expires_at > ?
           AND (a.status = 'STORED' OR
                (a.status = 'FAILED_FINAL' AND a.last_error = 'ATTACHMENT_DELIVERY_AMBIGUOUS'))
       )`
    );
    params.push(now);
  } else if (parent.subject_type === 'MESSAGE') {
    const separator = parent.subject_ref.indexOf(':');
    const provider = parent.subject_ref.slice(0, separator);
    const providerMessageRef = parent.subject_ref.slice(separator + 1);
    clauses.push(
      `AND EXISTS (
         SELECT 1 FROM messages m
         WHERE m.conversation_id = outbound_operations.conversation_id
           AND m.provider = ? AND m.provider_message_ref = ?
           AND m.message_type = 'TEXT' AND m.text_content IS NOT NULL
       )`
    );
    params.push(provider, providerMessageRef);
  } else {
    clauses.push('AND outbound_operations.subject_ref = outbound_operations.conversation_id');
  }
  return { sql: clauses.join('\n'), params };
}

async function loadSingleChild(
  env: Env,
  parent: OutboundOperation,
  expectedId: string
): Promise<OutboundOperation> {
  const children = await directChildren(env, parent.id);
  if (children.length !== 1) throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  assertChildIdentity(parent, children[0], expectedId);
  return children[0];
}

async function executeChild(
  env: Env,
  parent: OutboundOperation,
  child: OutboundOperation,
  plan: RetryPlan,
  created: boolean
): Promise<ManualRetryResult> {
  if (!child.target_evidence_json || !targetEvidenceMatches(child.target_evidence_json, plan.targetEvidence)) {
    throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  }
  const alreadyDelivered = child.status === 'SENT' || (
    child.status === 'AMBIGUOUS' &&
    (child.reconciliation_status === 'CONFIRMED_SENT' ||
      child.reconciliation_status === 'MANUAL_MARK_DELIVERED')
  );
  if (alreadyDelivered) {
    await resolveOutboundDomainState(env, child.id);
    return {
      parentOperationId: parent.id,
      childOperationId: child.id,
      childStatus: 'SENT',
      ...(child.provider_message_ref ? { providerMessageRef: child.provider_message_ref } : {}),
      created
    };
  }
  if (child.status === 'AMBIGUOUS' || child.status === 'FAILED_FINAL') {
    return {
      parentOperationId: parent.id,
      childOperationId: child.id,
      childStatus: child.status,
      created
    };
  }
  const execution = await executeOutboundOperation(
    env,
    child.conversation_id,
    child.destination_provider,
    child.operation_type,
    plan.action,
    child.id,
    {
      ...(plan.leaseSeconds === undefined ? {} : { leaseSeconds: plan.leaseSeconds }),
      subject: plan.subject,
      targetEvidence: plan.targetEvidence
    }
  );
  if (execution.status === 'SENT') await resolveOutboundDomainState(env, child.id);
  return {
    parentOperationId: parent.id,
    childOperationId: child.id,
    childStatus: execution.status as OutboundOperation['status'] | 'SENT',
    ...(execution.providerMessageRef ? { providerMessageRef: execution.providerMessageRef } : {}),
    created
  };
}

export async function manualRetryOutboundOperation(
  env: Env,
  operationId: string,
  actor: ManualRetryActor,
  reason: ManualRetryReason
): Promise<ManualRetryResult> {
  if (actor.type !== 'ADMIN' || !MANUAL_RETRY_REASONS.includes(reason)) {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
  let parent = await loadOperation(env, operationId);
  assertSupportedParent(parent);
  const childId = await manualRetryChildId(parent.id);
  const children = await directChildren(env, parent.id);
  if (children.length > 1) throw new SafeError('INTERNAL_INVARIANT_VIOLATION');

  if (parent.reconciliation_status === 'MANUAL_RETRY_CREATED') {
    if (children.length !== 1) throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
    const child = children[0];
    assertChildIdentity(parent, child, childId);
    if (child.status === 'SENT' || child.status === 'FAILED_FINAL' || child.status === 'AMBIGUOUS') {
      const delivered = child.status === 'SENT' || (
        child.status === 'AMBIGUOUS' &&
        (child.reconciliation_status === 'CONFIRMED_SENT' ||
          child.reconciliation_status === 'MANUAL_MARK_DELIVERED')
      );
      if (delivered) await resolveOutboundDomainState(env, child.id);
      return {
        parentOperationId: parent.id,
        childOperationId: child.id,
        childStatus: delivered ? 'SENT' : child.status,
        ...(child.provider_message_ref ? { providerMessageRef: child.provider_message_ref } : {}),
        created: false
      };
    }
    const plan = await prepareRetry(env, parent, childId);
    return executeChild(env, parent, child, plan, false);
  }

  if (parent.reconciliation_status !== 'PENDING' && parent.reconciliation_status !== 'STILL_AMBIGUOUS') {
    throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
  }
  if (children.length !== 0) throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  const actorRef = boundedActorRef(actor.ref);
  let plan = await prepareRetry(env, parent, childId);
  let created = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    created = await createChildAtomically(
      env, parent, childId, plan.targetEvidence, actorRef, reason
    );
    parent = await loadOperation(env, operationId);
    assertSupportedParent(parent);
    if (parent.reconciliation_status === 'MANUAL_RETRY_CREATED') break;
    if (
      attempt === 0 && !created &&
      (parent.reconciliation_status === 'PENDING' ||
        parent.reconciliation_status === 'STILL_AMBIGUOUS')
    ) {
      const racedChildren = await directChildren(env, parent.id);
      if (racedChildren.length !== 0) throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
      plan = await prepareRetry(env, parent, childId);
      continue;
    }
    if (
      parent.reconciliation_status !== 'PENDING' &&
      parent.reconciliation_status !== 'STILL_AMBIGUOUS'
    ) {
      throw new SafeError('OUTBOUND_MANUAL_RETRY_NOT_ELIGIBLE');
    }
    throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  }
  if (parent.reconciliation_status !== 'MANUAL_RETRY_CREATED') {
    throw new SafeError('INTERNAL_INVARIANT_VIOLATION');
  }
  const child = await loadSingleChild(env, parent, childId);
  return executeChild(env, parent, child, plan, created);
}
