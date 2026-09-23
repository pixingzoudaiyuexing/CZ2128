import { createCrispMessage } from '../adapters/crisp/api';
import {
  findEnabledCrispKeywordRule,
  parseCrispKeywordRules,
  CrispKeywordRule
} from '../config/crisp-keywords';
import { Env } from '../config/env';
import { Conversation, OutboundOperation } from '../core/domain';
import { CancelledBeforeDeliveryError, SafeError } from '../core/errors';
import { CrispMessageEvent } from '../core/events';
import { executeOutboundOperation, getOutboundOperation } from '../core/outbound-operations';
import { buildCrispTargetEvidence } from '../core/outbound-evidence';
import { getRuntimeHistoryVersion } from '../runtime-config/repository';

const SUBJECT_PATTERN = /^crisp-keyword:v([1-9]\d*):(kw_[a-z0-9]{16})$/;

async function keywordOperationId(conversationId: string, messageRef: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([conversationId, messageRef]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return `crisp_keyword:${hex}`;
}

function keywordSubject(version: number, ruleId: string): string {
  return `crisp-keyword:v${version}:${ruleId}`;
}

function parseKeywordSubject(operation: OutboundOperation): { version: number; ruleId: string } | null {
  if (operation.subject_type !== 'MESSAGE' || !operation.subject_ref) return null;
  const match = SUBJECT_PATTERN.exec(operation.subject_ref);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? { version, ruleId: match[2] } : null;
}

async function loadHistoricalRule(
  env: Env,
  version: number,
  ruleId: string
): Promise<CrispKeywordRule | null> {
  const history = await getRuntimeHistoryVersion(env, 'CRISP_KEYWORD_RULES', version);
  if (!history?.value_text || history.value_kind !== 'PLAIN') return null;
  const config = parseCrispKeywordRules(history.value_text);
  return config?.rules.find(rule => rule.id === ruleId) || null;
}

async function automationStillEnabled(env: Env, conversationId: string): Promise<boolean> {
  const current = await env.DB.prepare(
    'SELECT ai_mode FROM conversations WHERE id = ?'
  ).bind(conversationId).first<{ ai_mode: Conversation['ai_mode'] }>();
  return current?.ai_mode === 'ENABLED';
}

async function sendKeywordOperation(
  env: Env,
  event: CrispMessageEvent,
  conversation: Conversation,
  operationId: string,
  version: number,
  rule: CrispKeywordRule
): Promise<void> {
  await executeOutboundOperation(
    env,
    conversation.id,
    'crisp',
    'SEND_MESSAGE',
    async (opId, lifecycle) => {
      if (!await automationStillEnabled(env, conversation.id)) {
        throw new CancelledBeforeDeliveryError();
      }
      const response = await createCrispMessage(
        env,
        event.payload.websiteRef,
        event.payload.sessionRef,
        rule.reply,
        String(opId),
        lifecycle
      );
      return { providerMessageRef: response.messageId };
    },
    operationId,
    {
      subject: { type: 'MESSAGE', ref: keywordSubject(version, rule.id) },
      targetEvidence: buildCrispTargetEvidence(event.payload.websiteRef, event.payload.sessionRef)
    }
  );
}

export async function processCrispKeywordReply(
  event: CrispMessageEvent,
  env: Env,
  conversation: Conversation
): Promise<boolean> {
  const payload = event.payload;
  if (
    payload.actorRole !== 'CUSTOMER' ||
    !payload.content ||
    payload.selection ||
    (payload.attachments?.length || 0) > 0
  ) return false;

  const operationId = await keywordOperationId(conversation.id, payload.messageRef);
  const existing = await getOutboundOperation(env, operationId);
  if (existing) {
    const identity = parseKeywordSubject(existing);
    if (!identity) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    if (existing.status === 'SENT' || existing.status === 'AMBIGUOUS' || existing.status === 'FAILED_FINAL') {
      return true;
    }
    const historicalRule = await loadHistoricalRule(env, identity.version, identity.ruleId);
    if (!historicalRule) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    await sendKeywordOperation(env, event, conversation, operationId, identity.version, historicalRule);
    return true;
  }

  if (!await automationStillEnabled(env, conversation.id)) return false;
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CRISP_KEYWORD_RULES
  ) return false;

  const raw = env.runtimeConfigSnapshot?.values.CRISP_KEYWORD_RULES;
  const version = Number(env.runtimeConfigSnapshot?.versions.CRISP_KEYWORD_RULES || 0);
  if (!raw || !Number.isSafeInteger(version) || version < 1) return false;
  const config = parseCrispKeywordRules(raw);
  if (!config) return false;
  const rule = findEnabledCrispKeywordRule(config, payload.content);
  if (!rule) return false;

  await sendKeywordOperation(env, event, conversation, operationId, version, rule);
  return true;
}
