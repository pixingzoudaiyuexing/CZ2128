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
const ENV_SUBJECT_PATTERN = /^crisp-keyword:env:(kw_[a-z0-9]{16}):([a-f0-9]{64})$/;

type KeywordSubjectIdentity =
  | { source: 'D1'; version: number; ruleId: string }
  | { source: 'ENV'; ruleId: string; fingerprint: string };

async function keywordOperationId(conversationId: string, messageRef: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([conversationId, messageRef]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return `crisp_keyword:${hex}`;
}

function keywordSubject(version: number, ruleId: string): string {
  return `crisp-keyword:v${version}:${ruleId}`;
}

async function keywordRuleFingerprint(rule: CrispKeywordRule): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([rule.id, rule.keyword, rule.reply, rule.enabled]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function envKeywordSubject(rule: CrispKeywordRule): Promise<string> {
  return `crisp-keyword:env:${rule.id}:${await keywordRuleFingerprint(rule)}`;
}

function parseKeywordSubject(operation: OutboundOperation): KeywordSubjectIdentity | null {
  if (operation.subject_type !== 'MESSAGE' || !operation.subject_ref) return null;
  const d1Match = SUBJECT_PATTERN.exec(operation.subject_ref);
  if (d1Match) {
    const version = Number(d1Match[1]);
    return Number.isSafeInteger(version) ? { source: 'D1', version, ruleId: d1Match[2] } : null;
  }
  const envMatch = ENV_SUBJECT_PATTERN.exec(operation.subject_ref);
  return envMatch ? { source: 'ENV', ruleId: envMatch[1], fingerprint: envMatch[2] } : null;
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

async function loadCurrentEnvRule(
  env: Env,
  ruleId: string,
  fingerprint: string
): Promise<CrispKeywordRule | null> {
  if (env.runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES !== 'ENV') return null;
  const config = parseCrispKeywordRules(env.runtimeConfigSnapshot.values.CRISP_KEYWORD_RULES);
  const rule = config?.rules.find(item => item.id === ruleId);
  if (!rule || await keywordRuleFingerprint(rule) !== fingerprint) return null;
  return rule;
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
  subjectRef: string,
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
      subject: { type: 'MESSAGE', ref: subjectRef },
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
    const frozenRule = identity.source === 'D1'
      ? await loadHistoricalRule(env, identity.version, identity.ruleId)
      : await loadCurrentEnvRule(env, identity.ruleId, identity.fingerprint);
    if (!frozenRule) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    await sendKeywordOperation(env, event, conversation, operationId, existing.subject_ref!, frozenRule);
    return true;
  }

  if (!await automationStillEnabled(env, conversation.id)) return false;
  if (
    env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG ||
    env.runtimeConfigSnapshot?.errors.CRISP_KEYWORD_RULES
  ) return false;

  const raw = env.runtimeConfigSnapshot?.values.CRISP_KEYWORD_RULES;
  const source = env.runtimeConfigSnapshot?.sources.CRISP_KEYWORD_RULES || 'ENV';
  const version = Number(env.runtimeConfigSnapshot?.versions.CRISP_KEYWORD_RULES || 0);
  if (!raw || !Number.isSafeInteger(version)) return false;
  if ((source === 'D1' && version < 1) || (source === 'ENV' && version !== 0)) return false;
  const config = parseCrispKeywordRules(raw);
  if (!config) return false;
  const rule = findEnabledCrispKeywordRule(config, payload.content);
  if (!rule) return false;

  const subjectRef = source === 'D1'
    ? keywordSubject(version, rule.id)
    : await envKeywordSubject(rule);
  await sendKeywordOperation(env, event, conversation, operationId, subjectRef, rule);
  return true;
}
