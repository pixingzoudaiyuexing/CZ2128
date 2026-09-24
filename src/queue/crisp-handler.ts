import { createCrispMessage, createCrispPicker, CrispPickerChoice } from '../adapters/crisp/api';
import { crispFingerprintForOperation } from '../adapters/crisp/fingerprint';
import { createTelegramTopic, sendTelegramMessage } from '../adapters/telegram/api';
import { getAIConfig } from '../config/ai';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { parseTelegramCustomerRequestOptions, telegramCustomerRequestOptions } from '../config/telegram-customer-ux';
import { checkAutoResume, pauseOperator, pauseOperatorForCrispSelection } from '../core/ai-state';
import { getOrCreateConversation, insertMessage, updateOperatorThreadRef } from '../core/conversation-service';
import { enqueueAttachmentJobs } from '../core/attachment-repository';
import { RetryableProcessingError, SafeError } from '../core/errors';
import { CrispEvent, CrispMessageEvent } from '../core/events';
import {
  executeOutboundOperation,
  finalizeNeverStartedOutboundOperation,
  getOutboundOperation
} from '../core/outbound-operations';
import {
  buildCrispTargetEvidence,
  buildTelegramTargetEvidence,
  targetEvidenceMatches
} from '../core/outbound-evidence';
import { isAiConversationAllowed } from '../config/ai-test-scope';
import { logger } from '../observability/logger';
import {
  loadCrispConversation,
  reconcileCrispLifecycle,
  reconcileCrispLifecycleIdentity
} from './crisp-lifecycle';
import { processCrispKeywordReply } from './crisp-keyword-reply';
import { parseCrispWelcomeConfig, resolveCrispWelcome } from '../config/crisp-welcome';
import { getRuntimeHistoryVersion } from '../runtime-config/repository';
import type { OutboundOperation } from '../core/domain';
import { insertReliabilityAuditOnce } from '../core/reliability-audit';

export interface CrispMenuOption {
  pickerId: string;
  value: string;
  label: string;
  response?: string;
  next?: { id: string; text: string; choices: CrispPickerChoice[] };
  handoff?: boolean;
}

export interface CrispMenuConfig {
  welcome?: string;
  picker?: { id: string; text: string; choices: CrispPickerChoice[] };
  options?: CrispMenuOption[];
}

export function resolveCrispMenuOption(
  menu: CrispMenuConfig | null,
  pickerId: string,
  value: string
): CrispMenuOption | undefined {
  return menu?.options?.find(option => option.pickerId === pickerId && option.value === value);
}

function boundedMenuText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validChoices(value: unknown): value is CrispPickerChoice[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every(choice =>
    choice && boundedMenuText(choice.value, 128) && boundedMenuText(choice.label, 128)
  );
}

export function parseCrispMenu(value: string | undefined): CrispMenuConfig | null {
  if (!value || value.length > 20_000) return null;
  try {
    const parsed = JSON.parse(value) as CrispMenuConfig;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.welcome !== undefined && !boundedMenuText(parsed.welcome, 4000)) return null;
    if (parsed.picker && (
      !boundedMenuText(parsed.picker.id, 128) || !boundedMenuText(parsed.picker.text, 4000) ||
      !validChoices(parsed.picker.choices)
    )) return null;
    if (parsed.options && (
      !Array.isArray(parsed.options) || parsed.options.length > 50 || parsed.options.some(option =>
        !option || !boundedMenuText(option.pickerId, 128) ||
        !boundedMenuText(option.value, 128) || !boundedMenuText(option.label, 128) ||
        (option.response !== undefined && !boundedMenuText(option.response, 4000)) ||
        (option.next !== undefined && (
          !boundedMenuText(option.next.id, 128) || !boundedMenuText(option.next.text, 4000) ||
          !validChoices(option.next.choices)
        ))
      ) || new Set(parsed.options.map(option => `${option.pickerId}\u0000${option.value}`)).size !== parsed.options.length
    )) return null;
    return parsed;
  } catch {
    return null;
  }
}

type CrispBootstrapWelcomeIntent =
  | { kind: 'NONE' }
  | { kind: 'D1'; version: number }
  | { kind: 'LEGACY'; textHash: string }
  | { kind: 'LEGACY_UNKNOWN' };

interface CrispBootstrapPickerIntent {
  id: string;
  menuHash: string;
}

interface CrispBootstrapIntent {
  version: 1;
  welcome: CrispBootstrapWelcomeIntent;
  picker: CrispBootstrapPickerIntent | null;
}

type CrispBootstrapDecision = 'KEYWORD' | 'BOOTSTRAP' | 'SUPPRESSED';

interface BootstrapAuditRow {
  entity_type: string;
  entity_id: string;
  action: string;
  actor_type: string;
  actor_ref: string | null;
  old_state: string | null;
  new_state: string | null;
  reason_code: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function bootstrapAuditId(conversationId: string, kind: 'intent' | 'decision'): Promise<string> {
  return `crisp-bootstrap-${kind}:${await sha256Hex(JSON.stringify([conversationId, kind]))}`;
}

async function bootstrapEventHash(eventId: string): Promise<string> {
  return sha256Hex(JSON.stringify(['crisp-bootstrap-event', eventId]));
}

function canonicalPickerMenu(menu: CrispMenuConfig | null): string | null {
  if (!menu?.picker) return null;
  const choices = (value: CrispPickerChoice[]) => value.map(choice => ({
    value: choice.value,
    label: choice.label,
    selected: choice.selected ?? false
  }));
  return JSON.stringify({
    picker: {
      id: menu.picker.id,
      text: menu.picker.text,
      choices: choices(menu.picker.choices)
    },
    options: (menu.options || []).map(option => ({
      pickerId: option.pickerId,
      value: option.value,
      label: option.label,
      response: option.response ?? null,
      next: option.next ? {
        id: option.next.id,
        text: option.next.text,
        choices: choices(option.next.choices)
      } : null,
      handoff: option.handoff === true
    }))
  });
}

async function pickerMenuHash(menu: CrispMenuConfig | null): Promise<string | null> {
  const canonical = canonicalPickerMenu(menu);
  return canonical === null ? null : sha256Hex(canonical);
}

async function buildBootstrapIntent(
  env: Env,
  menu: CrispMenuConfig | null,
  existingWelcome?: OutboundOperation | null
): Promise<CrispBootstrapIntent> {
  let welcomeIntent: CrispBootstrapWelcomeIntent = { kind: 'NONE' };
  const existingSubject = existingWelcome?.subject_type === 'MESSAGE'
    ? existingWelcome.subject_ref
    : null;
  const existingVersion = existingSubject ? WELCOME_SUBJECT_PATTERN.exec(existingSubject) : null;
  if (existingVersion) {
    const version = Number(existingVersion[1]);
    if (Number.isSafeInteger(version) && version > 0) {
      welcomeIntent = { kind: 'D1', version };
    }
  } else if (existingSubject === `crisp-welcome:${existingWelcome?.conversation_id}`) {
    welcomeIntent = { kind: 'LEGACY_UNKNOWN' };
  } else {
    const welcome = resolveCrispWelcome(env, menu?.welcome);
    if (welcome.status === 'ENABLED' && welcome.text) {
      if (welcome.source === 'D1') {
        const version = Number(env.runtimeConfigSnapshot?.versions.CRISP_WELCOME_CONFIG || 0);
        if (Number.isSafeInteger(version) && version > 0) {
          welcomeIntent = { kind: 'D1', version };
        }
      } else {
        welcomeIntent = { kind: 'LEGACY', textHash: await sha256Hex(welcome.text) };
      }
    }
  }
  const menuHash = await pickerMenuHash(menu);
  return {
    version: 1,
    welcome: welcomeIntent,
    picker: menu?.picker && menuHash ? { id: menu.picker.id, menuHash } : null
  };
}

function parseBootstrapIntent(value: string | null): CrispBootstrapIntent | null {
  if (!value || value.length > 1024) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CrispBootstrapIntent>;
    if (parsed.version !== 1) return null;
    const welcome = parsed.welcome as CrispBootstrapWelcomeIntent | undefined;
    if (
      !welcome ||
      (welcome.kind === 'D1' && (!Number.isSafeInteger(welcome.version) || welcome.version < 1)) ||
      (welcome.kind === 'LEGACY' && !/^[a-f0-9]{64}$/.test(welcome.textHash)) ||
      !['NONE', 'D1', 'LEGACY', 'LEGACY_UNKNOWN'].includes(welcome.kind)
    ) return null;
    const picker = parsed.picker;
    if (picker !== null && (
      !picker ||
      typeof picker.id !== 'string' || !boundedMenuText(picker.id, 128) ||
      typeof picker.menuHash !== 'string' || !/^[a-f0-9]{64}$/.test(picker.menuHash)
    )) return null;
    return { version: 1, welcome, picker: picker || null };
  } catch {
    return null;
  }
}

async function loadBootstrapAudit(env: Env, id: string): Promise<BootstrapAuditRow | null> {
  return env.DB.prepare(
    `SELECT entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code
     FROM reliability_audit WHERE id = ?`
  ).bind(id).first<BootstrapAuditRow>();
}

async function firstEventBootstrapIntent(
  env: Env,
  conversationId: string,
  eventId: string,
  menu: CrispMenuConfig | null,
  mayCreate: boolean
): Promise<CrispBootstrapIntent | null> {
  const id = await bootstrapAuditId(conversationId, 'intent');
  const eventHash = await bootstrapEventHash(eventId);
  if (mayCreate) {
    const existingWelcome = await getOutboundOperation(env, `crisp_welcome:${conversationId}`);
    const intent = await buildBootstrapIntent(env, menu, existingWelcome);
    await insertReliabilityAuditOnce(env, {
      id,
      entityType: 'CONVERSATION',
      entityId: conversationId,
      action: 'CRISP_BOOTSTRAP_INTENT_CREATED',
      actorType: 'SYSTEM',
      actorRef: 'system:crisp-bootstrap',
      oldState: eventHash,
      newState: JSON.stringify(intent),
      reasonCode: 'CRISP_FIRST_CUSTOMER_EVENT',
      createdAt: Math.floor(Date.now() / 1000)
    });
  }

  const row = await loadBootstrapAudit(env, id);
  if (!row) return null;
  if (
    row.entity_type !== 'CONVERSATION' ||
    row.entity_id !== conversationId ||
    row.action !== 'CRISP_BOOTSTRAP_INTENT_CREATED' ||
    row.actor_type !== 'SYSTEM' ||
    row.actor_ref !== 'system:crisp-bootstrap' ||
    row.reason_code !== 'CRISP_FIRST_CUSTOMER_EVENT'
  ) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
  if (row.old_state !== eventHash) return null;
  const intent = parseBootstrapIntent(row.new_state);
  if (!intent) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  return intent;
}

async function loadBootstrapDecision(
  env: Env,
  conversationId: string,
  eventId: string
): Promise<CrispBootstrapDecision | null> {
  const id = await bootstrapAuditId(conversationId, 'decision');
  const row = await loadBootstrapAudit(env, id);
  if (!row) return null;
  const eventHash = await bootstrapEventHash(eventId);
  if (
    row.entity_type !== 'CONVERSATION' ||
    row.entity_id !== conversationId ||
    row.action !== 'CRISP_BOOTSTRAP_DECISION_FIXED' ||
    row.actor_type !== 'SYSTEM' ||
    row.actor_ref !== 'system:crisp-bootstrap' ||
    row.reason_code !== 'CRISP_FIRST_CUSTOMER_EVENT' ||
    row.old_state !== eventHash ||
    (row.new_state !== 'KEYWORD' && row.new_state !== 'BOOTSTRAP' && row.new_state !== 'SUPPRESSED')
  ) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
  return row.new_state;
}

async function persistBootstrapDecision(
  env: Env,
  conversationId: string,
  eventId: string,
  decision: CrispBootstrapDecision
): Promise<CrispBootstrapDecision> {
  const id = await bootstrapAuditId(conversationId, 'decision');
  await insertReliabilityAuditOnce(env, {
    id,
    entityType: 'CONVERSATION',
    entityId: conversationId,
    action: 'CRISP_BOOTSTRAP_DECISION_FIXED',
    actorType: 'SYSTEM',
    actorRef: 'system:crisp-bootstrap',
    oldState: await bootstrapEventHash(eventId),
    newState: decision,
    reasonCode: 'CRISP_FIRST_CUSTOMER_EVENT',
    createdAt: Math.floor(Date.now() / 1000)
  });
  const fixed = await loadBootstrapDecision(env, conversationId, eventId);
  if (fixed !== decision) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  return fixed;
}

async function automationStillEnabled(env: Env, conversationId: string): Promise<boolean> {
  const current = await env.DB.prepare(
    'SELECT ai_mode FROM conversations WHERE id = ?'
  ).bind(conversationId).first<{ ai_mode: string }>();
  return current?.ai_mode === 'ENABLED';
}

function bootstrapOperationTerminal(operation: OutboundOperation): boolean {
  return operation.status === 'SENT' ||
    operation.status === 'FAILED_FINAL' ||
    (
      operation.status === 'AMBIGUOUS' &&
      (operation.reconciliation_status === 'CONFIRMED_SENT' ||
        operation.reconciliation_status === 'MANUAL_MARK_DELIVERED')
    );
}

async function assertPausedBootstrapHasNoUnresolvedOperation(
  env: Env,
  conversationId: string,
  intent: CrispBootstrapIntent
): Promise<void> {
  const ids = [`crisp_welcome:${conversationId}`];
  if (intent.picker) ids.push(`crisp_picker:${conversationId}:${intent.picker.id}`);
  for (const id of ids) {
    const operation = await getOutboundOperation(env, id);
    if (operation && !bootstrapOperationTerminal(operation)) {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
  }
}

const WELCOME_SUBJECT_PATTERN = /^crisp-welcome:v([1-9]\d*)$/;

async function historicalWelcomeText(env: Env, version: number): Promise<string | null> {
  const history = await getRuntimeHistoryVersion(env, 'CRISP_WELCOME_CONFIG', version);
  if (!history?.value_text || history.value_kind !== 'PLAIN') return null;
  return parseCrispWelcomeConfig(history.value_text)?.text || null;
}

async function welcomeTextForD1Intent(env: Env, version: number): Promise<string | null> {
  if (
    env.runtimeConfigSnapshot?.sources.CRISP_WELCOME_CONFIG === 'D1' &&
    Number(env.runtimeConfigSnapshot.versions.CRISP_WELCOME_CONFIG || 0) === version
  ) {
    const current = parseCrispWelcomeConfig(env.runtimeConfigSnapshot.values.CRISP_WELCOME_CONFIG);
    if (current?.enabled) return current.text;
  }
  return historicalWelcomeText(env, version);
}

type UnrecoverableWelcomeReason =
  | 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'
  | 'CRISP_WELCOME_LEGACY_CONFIG_CHANGED';

async function welcomeFinalizationAuditId(
  operationId: string,
  reason: UnrecoverableWelcomeReason
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([operationId, reason]))
  );
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `crisp-welcome-finalized:${hex}`;
}

function assertWelcomeOperationIdentity(
  operation: OutboundOperation,
  conversationId: string,
  websiteRef: string,
  sessionRef: string
): void {
  if (
    operation.id !== `crisp_welcome:${conversationId}` ||
    operation.conversation_id !== conversationId ||
    operation.destination_provider !== 'crisp' ||
    operation.operation_type !== 'SEND_MESSAGE'
  ) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }

  const legacySubject = `crisp-welcome:${conversationId}`;
  const hasNoSubject = operation.subject_type === null && operation.subject_ref === null;
  const hasWelcomeSubject = operation.subject_type === 'MESSAGE' &&
    operation.subject_ref !== null &&
    (operation.subject_ref === legacySubject || WELCOME_SUBJECT_PATTERN.test(operation.subject_ref));
  if (!hasNoSubject && !hasWelcomeSubject) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }

  if (
    operation.target_evidence_json !== null &&
    !targetEvidenceMatches(
      operation.target_evidence_json,
      buildCrispTargetEvidence(websiteRef, sessionRef)
    )
  ) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
}

async function settleUnrecoverableWelcomeOperation(
  env: Env,
  operation: OutboundOperation,
  conversationId: string,
  websiteRef: string,
  sessionRef: string,
  reason: UnrecoverableWelcomeReason
): Promise<null> {
  assertWelcomeOperationIdentity(operation, conversationId, websiteRef, sessionRef);

  if (operation.status === 'SENT' || operation.status === 'FAILED_FINAL') {
    return null;
  }
  if (
    operation.status === 'AMBIGUOUS' &&
    (operation.reconciliation_status === 'CONFIRMED_SENT' ||
      operation.reconciliation_status === 'MANUAL_MARK_DELIVERED')
  ) {
    return null;
  }
  if (operation.status === 'SENDING' || operation.status === 'AMBIGUOUS') {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }

  const result = await finalizeNeverStartedOutboundOperation(
    env,
    operation,
    'OUTBOUND_PRECONDITION_FAILED',
    {
      id: await welcomeFinalizationAuditId(operation.id, reason),
      action: 'CRISP_WELCOME_UNSENT_FINALIZED',
      actorRef: 'system:crisp-welcome',
      reasonCode: reason
    }
  );
  if (result.changed || result.operation.status === 'SENT' || result.operation.status === 'FAILED_FINAL') {
    return null;
  }

  throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
}

async function resolveWelcomeOperation(
  env: Env,
  menu: CrispMenuConfig | null,
  conversationId: string,
  websiteRef: string,
  sessionRef: string,
  existingOverride?: OutboundOperation | null,
  bootstrapIntent?: CrispBootstrapWelcomeIntent
): Promise<{ text: string; subjectRef: string } | null> {
  const operationId = `crisp_welcome:${conversationId}`;
  const existing = existingOverride === undefined
    ? await getOutboundOperation(env, operationId)
    : existingOverride;
  if (existing) {
    const match = existing.subject_type === 'MESSAGE' && existing.subject_ref
      ? WELCOME_SUBJECT_PATTERN.exec(existing.subject_ref)
      : null;
    if (match) {
      const version = Number(match[1]);
      if (bootstrapIntent?.kind === 'D1' && bootstrapIntent.version !== version) {
        throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      }
      if (bootstrapIntent?.kind === 'LEGACY' || bootstrapIntent?.kind === 'NONE') {
        throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      }
      const text = Number.isSafeInteger(version) ? await welcomeTextForD1Intent(env, version) : null;
      if (!text) {
        return settleUnrecoverableWelcomeOperation(
          env, existing, conversationId, websiteRef, sessionRef, 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'
        );
      }
      return { text, subjectRef: existing.subject_ref! };
    }
    if (existing.subject_ref === `crisp-welcome:${conversationId}`) {
      if (bootstrapIntent?.kind === 'LEGACY_UNKNOWN') {
        const legacy = resolveCrispWelcome(env, menu?.welcome);
        return settleUnrecoverableWelcomeOperation(
          env,
          existing,
          conversationId,
          websiteRef,
          sessionRef,
          legacy.source === 'D1'
            ? 'CRISP_WELCOME_LEGACY_CONFIG_CHANGED'
            : 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'
        );
      }
      if (bootstrapIntent?.kind === 'D1' || bootstrapIntent?.kind === 'NONE') {
        return settleUnrecoverableWelcomeOperation(
          env, existing, conversationId, websiteRef, sessionRef, 'CRISP_WELCOME_LEGACY_CONFIG_CHANGED'
        );
      }
      const legacy = resolveCrispWelcome(env, menu?.welcome);
      if (legacy.source === 'D1') {
        return settleUnrecoverableWelcomeOperation(
          env, existing, conversationId, websiteRef, sessionRef, 'CRISP_WELCOME_LEGACY_CONFIG_CHANGED'
        );
      }
      if (bootstrapIntent?.kind === 'LEGACY') {
        if (
          legacy.status !== 'ENABLED' ||
          !legacy.text ||
          await sha256Hex(legacy.text) !== bootstrapIntent.textHash
        ) {
          return settleUnrecoverableWelcomeOperation(
            env, existing, conversationId, websiteRef, sessionRef, 'CRISP_WELCOME_LEGACY_CONFIG_CHANGED'
          );
        }
        return { text: legacy.text, subjectRef: existing.subject_ref };
      }
      return legacy.status === 'ENABLED' && legacy.text
        ? { text: legacy.text, subjectRef: existing.subject_ref }
        : settleUnrecoverableWelcomeOperation(
            env, existing, conversationId, websiteRef, sessionRef, 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'
          );
    }
    return settleUnrecoverableWelcomeOperation(
      env, existing, conversationId, websiteRef, sessionRef, 'CRISP_WELCOME_HISTORY_UNRECOVERABLE'
    );
  }

  if (bootstrapIntent) {
    if (bootstrapIntent.kind === 'NONE') return null;
    if (bootstrapIntent.kind === 'LEGACY_UNKNOWN') {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
    if (bootstrapIntent.kind === 'D1') {
      const text = await welcomeTextForD1Intent(env, bootstrapIntent.version);
      if (!text) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      return { text, subjectRef: `crisp-welcome:v${bootstrapIntent.version}` };
    }
    const legacy = resolveCrispWelcome(env, menu?.welcome);
    if (
      legacy.source === 'D1' ||
      legacy.status !== 'ENABLED' ||
      !legacy.text ||
      await sha256Hex(legacy.text) !== bootstrapIntent.textHash
    ) {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
    return { text: legacy.text, subjectRef: `crisp-welcome:${conversationId}` };
  }

  const welcome = resolveCrispWelcome(env, menu?.welcome);
  if (welcome.status !== 'ENABLED' || !welcome.text) return null;
  if (welcome.source === 'D1') {
    const version = Number(env.runtimeConfigSnapshot?.versions.CRISP_WELCOME_CONFIG || 0);
    if (!Number.isSafeInteger(version) || version < 1) return null;
    return { text: welcome.text, subjectRef: `crisp-welcome:v${version}` };
  }
  return { text: welcome.text, subjectRef: `crisp-welcome:${conversationId}` };
}

async function sendCrispTextOperation(
  env: Env,
  conversationId: string,
  websiteRef: string,
  sessionRef: string,
  operationId: string,
  content: string,
  subjectRef: string
): Promise<{ status: string; providerMessageRef?: string }> {
  return executeOutboundOperation(
    env,
    conversationId,
    'crisp',
    'SEND_MESSAGE',
    async (_opId, lifecycle) => {
      const response = await createCrispMessage(
        env, websiteRef, sessionRef, content, operationId, lifecycle
      );
      return { providerMessageRef: response.messageId };
    },
    operationId,
    {
      subject: { type: 'MESSAGE', ref: subjectRef },
      targetEvidence: buildCrispTargetEvidence(websiteRef, sessionRef)
    }
  );
}

async function sendCrispPickerOperation(
  env: Env,
  conversationId: string,
  websiteRef: string,
  sessionRef: string,
  operationId: string,
  picker: { id: string; text: string; choices: CrispPickerChoice[] }
): Promise<{ status: string; providerMessageRef?: string }> {
  return executeOutboundOperation(
    env,
    conversationId,
    'crisp',
    'SEND_MESSAGE',
    async (opId, lifecycle) => {
      const response = await createCrispPicker(
        env, websiteRef, sessionRef, picker.id, picker.text, picker.choices, String(opId), lifecycle
      );
      return { providerMessageRef: response.messageId };
    },
    operationId,
    {
      subject: { type: 'MESSAGE', ref: `picker:${picker.id}` },
      targetEvidence: buildCrispTargetEvidence(websiteRef, sessionRef)
    }
  );
}

async function processBootstrapPicker(
  env: Env,
  conversationId: string,
  websiteRef: string,
  sessionRef: string,
  intent: CrispBootstrapPickerIntent | null,
  menu: CrispMenuConfig | null
): Promise<void> {
  if (!intent) return;
  const operationId = `crisp_picker:${conversationId}:${intent.id}`;
  const existing = await getOutboundOperation(env, operationId);
  if (existing && bootstrapOperationTerminal(existing)) return;
  if (existing?.status === 'AMBIGUOUS') {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }

  const currentHash = await pickerMenuHash(menu);
  if (!menu?.picker || menu.picker.id !== intent.id || currentHash !== intent.menuHash) {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }

  const result = await sendCrispPickerOperation(
    env,
    conversationId,
    websiteRef,
    sessionRef,
    operationId,
    menu.picker
  );
  if (result.status !== 'SENT' && result.status !== 'FAILED_FINAL') {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
}

async function ensureTelegramTopic(
  env: Env,
  conversationId: string,
  customerName: string | undefined,
  sessionRef: string,
  existingThreadRef: string | null
): Promise<string | null> {
  if (existingThreadRef) return existingThreadRef;
  const result = await executeOutboundOperation(
    env,
    conversationId,
    'telegram',
    'CREATE_TOPIC',
    async (_opId, lifecycle) => {
      const title = `${customerName || 'Crisp customer'} | Crisp ${sessionRef}`.slice(0, 128);
      const response = await createTelegramTopic(env, env.BOT_GROUP_ID, title, lifecycle);
      return { providerMessageRef: response.messageThreadId };
    },
    `create_topic_${conversationId}`,
    {
      subject: { type: 'CONVERSATION', ref: conversationId },
      targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, null, 'createForumTopic')
    }
  );
  if (result.status !== 'SENT' || !result.providerMessageRef) {
    logger.warn('Crisp topic creation not SENT', { conversation_id: conversationId });
    return null;
  }
  return updateOperatorThreadRef(env, conversationId, result.providerMessageRef);
}

async function isOwnCrispEcho(
  env: Env,
  conversationId: string,
  payload: CrispMessageEvent['payload']
): Promise<boolean> {
  if (payload.actorRole !== 'OPERATOR' || payload.automated !== true) return false;

  if (payload.operationMarker) {
    const operation = await getOutboundOperation(env, payload.operationMarker);
    if (operation && operation.conversation_id === conversationId &&
        operation.destination_provider === 'crisp' &&
        (operation.operation_type === 'SEND_MESSAGE' || operation.operation_type === 'SEND_ATTACHMENT')) {
      if (operation.provider_message_ref) {
        if (operation.provider_message_ref === payload.messageRef) return true;
      } else if ((operation.status === 'SENDING' || operation.status === 'AMBIGUOUS') &&
                 operation.request_started_at !== null) {
        return true;
      }
    }
  }

  const sent = await env.DB.prepare(
    `SELECT id FROM outbound_operations
     WHERE conversation_id = ? AND destination_provider = 'crisp'
       AND operation_type IN ('SEND_MESSAGE', 'SEND_ATTACHMENT')
       AND status = 'SENT' AND provider_message_ref = ?
     LIMIT 1`
  ).bind(conversationId, payload.messageRef).first<{ id: string }>();
  if (sent) return true;

  const inFlight = await env.DB.prepare(
    `SELECT id FROM outbound_operations
     WHERE conversation_id = ? AND destination_provider = 'crisp'
       AND operation_type IN ('SEND_MESSAGE', 'SEND_ATTACHMENT')
       AND status IN ('SENDING', 'AMBIGUOUS') AND request_started_at IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 16`
  ).bind(conversationId).all<{ id: string }>();
  for (const operation of inFlight.results || []) {
    if (String(await crispFingerprintForOperation(operation.id)) === payload.messageRef) return true;
  }
  return false;
}

export async function processCrispEvent(event: CrispEvent, env: Env): Promise<void> {
  if (event.type === 'conversation_state_changed') {
    await reconcileCrispLifecycle(event, env);
    return;
  }
  const payload = event.payload;
  const content = payload.content || '';
  let conv = await getOrCreateConversation(
    env, 'crisp', payload.websiteRef, payload.sessionRef, payload.customerRef
  );
  if (conv.operator_thread_ref && conv.operator_thread_status === 'CLOSED') {
    await reconcileCrispLifecycleIdentity({
      websiteRef: payload.websiteRef,
      sessionRef: payload.sessionRef,
      eventId: `crisp-message-reconcile:${event.eventId}`
    }, env);
    const reconciled = await loadCrispConversation(env, payload.websiteRef, payload.sessionRef);
    if (!reconciled || reconciled.operator_thread_status !== 'OPEN') {
      throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 5, {
        provider: 'CRISP',
        stage: 'RECONCILE'
      });
    }
    conv = reconciled;
  }
  const isOperator = payload.actorRole === 'OPERATOR';
  if (await isOwnCrispEcho(env, conv.id, payload)) {
    logger.info('Crisp self echo suppressed', {
      conversation_id: conv.id,
      operation_id: payload.operationMarker || 'provider-fingerprint',
      result: 'SUPPRESSED'
    });
    return;
  }
  const wasNewConversation = !conv.operator_thread_ref;
  if (!isOperator && await checkAutoResume(env, conv)) {
    const resumed = await loadCrispConversation(env, payload.websiteRef, payload.sessionRef);
    if (resumed) conv = resumed;
  }
  const customerUx = !isOperator ? telegramCustomerRequestOptions(env, conv) : null;
  const customerUxJson = customerUx ? JSON.stringify(customerUx) : undefined;
  const menu = parseCrispMenu(env.CRISP_MENU_JSON);
  const bootstrapIntent = !isOperator
    ? await firstEventBootstrapIntent(env, conv.id, event.eventId, menu, wasNewConversation)
    : null;

  if (isOperator) await pauseOperator(env, conv.id, 'CRISP_OPERATOR');
  if (content) {
    await insertMessage(
      env, conv.id, 'crisp', payload.messageRef,
      isOperator ? 'OUTBOUND' : 'INBOUND', payload.actorRole, 'TEXT', content
    );
  }

  const threadRef = await ensureTelegramTopic(
    env, conv.id, payload.customerName, payload.sessionRef, conv.operator_thread_ref
  );
  if (!threadRef) return;

  await enqueueAttachmentJobs(
    env,
    getAttachmentConfig(env),
    conv.id,
    'crisp',
    payload.messageRef,
    payload.attachments || [],
    'telegram',
    undefined,
    customerUxJson
  );

  if (content) {
    await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'SEND_MESSAGE',
      async (_opId, lifecycle) => {
        const frozen = parseTelegramCustomerRequestOptions(lifecycle.requestOptionsJson);
        const response = await sendTelegramMessage(
          env,
          env.BOT_GROUP_ID,
          threadRef,
          content,
          lifecycle,
          frozen ? {
            disableNotification: frozen.disableNotification,
            ...(frozen.controls === 'AI_TOGGLE_V1' ? {
              replyMarkup: {
                inline_keyboard: [[
                  { text: '开启 AI', callback_data: 'ai:on' },
                  { text: '关闭 AI', callback_data: 'ai:off' }
                ]]
              }
            } : {})
          } : undefined
        );
        return { providerMessageRef: response.messageId };
      },
      `send_tg_crisp_${payload.messageRef}`,
      {
        subject: { type: 'MESSAGE', ref: `crisp:${payload.messageRef}` },
        targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, threadRef, 'sendMessage'),
        ...(customerUx ? { requestOptions: customerUx } : {})
      }
    );
  }

  let keywordHandled = false;
  let bootstrapDecision: CrispBootstrapDecision | null = null;
  if (!isOperator && bootstrapIntent) {
    bootstrapDecision = await loadBootstrapDecision(env, conv.id, event.eventId);
    if (bootstrapDecision === null) {
      keywordHandled = await processCrispKeywordReply(event, env, conv);
      bootstrapDecision = await persistBootstrapDecision(
        env,
        conv.id,
        event.eventId,
        keywordHandled
          ? 'KEYWORD'
          : await automationStillEnabled(env, conv.id)
            ? 'BOOTSTRAP'
            : 'SUPPRESSED'
      );
    } else if (bootstrapDecision === 'KEYWORD') {
      keywordHandled = await processCrispKeywordReply(event, env, conv);
      if (!keywordHandled) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
  } else {
    keywordHandled = await processCrispKeywordReply(event, env, conv);
  }

  if (!isOperator && bootstrapIntent && bootstrapDecision === 'BOOTSTRAP') {
    if (!await automationStillEnabled(env, conv.id)) {
      await assertPausedBootstrapHasNoUnresolvedOperation(env, conv.id, bootstrapIntent);
    } else {
      const welcome = await resolveWelcomeOperation(
        env,
        menu,
        conv.id,
        payload.websiteRef,
        payload.sessionRef,
        undefined,
        bootstrapIntent.welcome
      );
      if (welcome) {
        const welcomeResult = await sendCrispTextOperation(
          env, conv.id, payload.websiteRef, payload.sessionRef,
          `crisp_welcome:${conv.id}`, welcome.text, welcome.subjectRef
        );
        if (welcomeResult.status !== 'SENT' && welcomeResult.status !== 'FAILED_FINAL') {
          throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
        }
      }
      await processBootstrapPicker(
        env,
        conv.id,
        payload.websiteRef,
        payload.sessionRef,
        bootstrapIntent.picker,
        menu
      );
    }
  }

  if (!isOperator && payload.selection && menu?.options) {
    const selected = resolveCrispMenuOption(menu, payload.selection.pickerId, payload.selection.value);
    if (selected?.response) {
      await sendCrispTextOperation(
        env, conv.id, payload.websiteRef, payload.sessionRef,
        `crisp_option:${event.eventId}:response`, selected.response, `crisp-option:${event.eventId}`
      );
    }
    if (selected?.next) {
      await sendCrispPickerOperation(
        env, conv.id, payload.websiteRef, payload.sessionRef,
        `crisp_option:${event.eventId}:picker:${selected.next.id}`, selected.next
      );
    }
    if (selected?.handoff) {
      const handoffResult = await pauseOperatorForCrispSelection(env, conv.id, event.eventId);
      if (env.hooks?.afterCrispHandoffStateApplied) {
        await env.hooks.afterCrispHandoffStateApplied(env, conv.id, event.eventId, handoffResult);
      }
      await executeOutboundOperation(
        env,
        conv.id,
        'telegram',
        'SEND_MESSAGE',
        async (_opId, lifecycle) => {
          const response = await sendTelegramMessage(
            env,
            env.BOT_GROUP_ID,
            threadRef,
            `Crisp customer requested human support: ${selected.label}`,
            lifecycle
          );
          return { providerMessageRef: response.messageId };
        },
        `crisp_handoff_tg:${event.eventId}`,
        {
          subject: { type: 'MESSAGE', ref: `crisp-handoff:${event.eventId}` },
          targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, threadRef, 'sendMessage')
        }
      );
    }
  }

  const aiConfigured = !env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG && getAIConfig(env).enabled;
  if (
    !keywordHandled &&
    !isOperator &&
    content &&
    !payload.selection &&
    aiConfigured &&
    isAiConversationAllowed(env, conv.id) &&
    await checkAutoResume(env, conv)
  ) {
    await env.QUEUE.send({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: `ai_trigger:${conv.id}:${payload.messageRef}`,
      payload: { convId: conv.id, messageId: payload.messageRef }
    });
  }
}
