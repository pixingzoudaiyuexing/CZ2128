import { Env } from '../config/env';
import { RuntimeConfigKey, RuntimeValueSource } from '../runtime-config/types';

export const OUTBOUND_SUBJECT_TYPES = [
  'MESSAGE',
  'ATTACHMENT',
  'CONVERSATION',
  'AI_RUN',
  'CONTROL_ACK'
] as const;

export type OutboundSubjectType = typeof OUTBOUND_SUBJECT_TYPES[number];

export interface OutboundSubjectIdentity {
  type: OutboundSubjectType;
  ref: string;
}

export interface ChatwootTargetEvidenceV1 {
  version: 1;
  provider: 'chatwoot';
  accountRef: string;
  conversationRef: string;
  sourceId: string;
  apiUrlSource: RuntimeValueSource;
  apiUrlVersion?: number;
  apiOriginFingerprint: string;
}

export type TelegramMethod =
  | 'sendMessage'
  | 'createForumTopic'
  | 'closeForumTopic'
  | 'reopenForumTopic'
  | 'sendPhoto'
  | 'sendVideo'
  | 'sendAudio'
  | 'sendVoice'
  | 'sendDocument';

export interface TelegramTargetEvidenceV1 {
  version: 1;
  provider: 'telegram';
  supportProfileSource: RuntimeValueSource;
  supportProfileVersion?: number;
  botGroupIdSource: RuntimeValueSource;
  botGroupIdVersion?: number;
  groupRef: string;
  threadRef?: string;
  method: TelegramMethod;
}

export type OutboundTargetEvidence = ChatwootTargetEvidenceV1 | TelegramTargetEvidenceV1;

const TELEGRAM_METHODS: readonly TelegramMethod[] = [
  'sendMessage', 'createForumTopic', 'closeForumTopic', 'reopenForumTopic',
  'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument'
];

function runtimeSource(value: RuntimeValueSource): RuntimeValueSource {
  if (value !== 'ENV' && value !== 'D1') throw new Error('Invalid outbound evidence runtime source');
  return value;
}

function runtimeVersion(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid outbound evidence runtime version');
  return value;
}

function finiteRef(value: string, field: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid outbound evidence ${field}`);
  }
  return value;
}

function configMetadata(env: Env, key: RuntimeConfigKey): {
  source: RuntimeValueSource;
  version?: number;
} {
  const source = env.runtimeConfigSnapshot?.sources[key] || 'ENV';
  const version = env.runtimeConfigSnapshot?.versions[key];
  return Number.isSafeInteger(version) && Number(version) >= 1
    ? { source, version: Number(version) }
    : { source };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildChatwootTargetEvidence(
  env: Env,
  accountRef: string,
  conversationRef: string,
  operationId: string
): Promise<ChatwootTargetEvidenceV1> {
  const api = configMetadata(env, 'CHATWOOT_API_URL');
  let origin: string;
  try {
    origin = new URL(env.CHATWOOT_API_URL).origin.toLowerCase();
  } catch {
    origin = `invalid:${api.source}:${api.version || 0}`;
  }
  return {
    version: 1,
    provider: 'chatwoot',
    accountRef: finiteRef(accountRef, 'accountRef'),
    conversationRef: finiteRef(conversationRef, 'conversationRef'),
    sourceId: `cz2128:${finiteRef(operationId, 'operationId')}`,
    apiUrlSource: api.source,
    ...(api.version === undefined ? {} : { apiUrlVersion: api.version }),
    apiOriginFingerprint: await sha256Hex(origin)
  };
}

export function buildTelegramTargetEvidence(
  env: Env,
  groupRef: string,
  threadRef: string | null,
  method: TelegramMethod
): TelegramTargetEvidenceV1 {
  const profile = configMetadata(env, 'TELEGRAM_SUPPORT_PROFILE');
  const group = configMetadata(env, 'BOT_GROUP_ID');
  return {
    version: 1,
    provider: 'telegram',
    supportProfileSource: profile.source,
    ...(profile.version === undefined ? {} : { supportProfileVersion: profile.version }),
    botGroupIdSource: group.source,
    ...(group.version === undefined ? {} : { botGroupIdVersion: group.version }),
    groupRef: finiteRef(groupRef, 'groupRef'),
    ...(threadRef ? { threadRef: finiteRef(threadRef, 'threadRef') } : {}),
    method
  };
}

export function serializeTargetEvidence(evidence: OutboundTargetEvidence): string {
  if (evidence.version !== 1) throw new Error('Unsupported outbound target evidence version');
  if (evidence.provider === 'chatwoot') {
    if (!/^[a-f0-9]{64}$/.test(evidence.apiOriginFingerprint)) {
      throw new Error('Invalid Chatwoot API origin fingerprint');
    }
    return JSON.stringify({
      version: 1,
      provider: 'chatwoot',
      accountRef: finiteRef(evidence.accountRef, 'accountRef'),
      conversationRef: finiteRef(evidence.conversationRef, 'conversationRef'),
      sourceId: finiteRef(evidence.sourceId, 'sourceId'),
      apiUrlSource: runtimeSource(evidence.apiUrlSource),
      ...(runtimeVersion(evidence.apiUrlVersion) === undefined ? {} : { apiUrlVersion: evidence.apiUrlVersion }),
      apiOriginFingerprint: evidence.apiOriginFingerprint
    });
  }
  if (!TELEGRAM_METHODS.includes(evidence.method)) throw new Error('Invalid Telegram evidence method');
  return JSON.stringify({
    version: 1,
    provider: 'telegram',
    supportProfileSource: runtimeSource(evidence.supportProfileSource),
    ...(runtimeVersion(evidence.supportProfileVersion) === undefined ? {} : { supportProfileVersion: evidence.supportProfileVersion }),
    botGroupIdSource: runtimeSource(evidence.botGroupIdSource),
    ...(runtimeVersion(evidence.botGroupIdVersion) === undefined ? {} : { botGroupIdVersion: evidence.botGroupIdVersion }),
    groupRef: finiteRef(evidence.groupRef, 'groupRef'),
    ...(evidence.threadRef === undefined ? {} : { threadRef: finiteRef(evidence.threadRef, 'threadRef') }),
    method: evidence.method
  });
}

export function parseTargetEvidence(value: string): OutboundTargetEvidence {
  const parsed = JSON.parse(value) as OutboundTargetEvidence;
  return JSON.parse(serializeTargetEvidence(parsed)) as OutboundTargetEvidence;
}

export function targetEvidenceMatches(left: string, right: OutboundTargetEvidence): boolean {
  try {
    return serializeTargetEvidence(parseTargetEvidence(left)) === serializeTargetEvidence(right);
  } catch {
    return false;
  }
}
