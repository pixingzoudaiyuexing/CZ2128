import { Env } from '../../config/env';
import { ProviderDeliveryError, RetryableProcessingError, SafeError } from '../../core/errors';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../../core/provider-retry';
import { OutboundAttemptLifecycle } from '../../core/outbound-operations';
import { insertReliabilityAuditOnce } from '../../core/reliability-audit';
import { logger } from '../../observability/logger';
import { crispFingerprintForOperation } from './fingerprint';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';
const CRISP_AUTOMATED_USER = { nickname: 'CZ2128' };
const CRISP_ERROR_DIAGNOSTIC_MAX_BYTES = 4096;
const CRISP_OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,512}$/;
export type CrispConversationState = 'pending' | 'unresolved' | 'resolved';

type CrispProviderReasonCode = 'invalid_data' | 'invalid_session' | 'UNKNOWN_PROVIDER_REASON';
type CrispProviderResponseState = 'JSON_OBJECT' | 'EMPTY' | 'NON_JSON' | 'TOO_LARGE' | 'READ_ERROR';
type CrispSchemaFieldCode =
  | 'FIELD_TYPE'
  | 'FIELD_FROM'
  | 'FIELD_ORIGIN'
  | 'FIELD_CONTENT'
  | 'FIELD_USER'
  | 'FIELD_USER_TYPE'
  | 'FIELD_USER_ID'
  | 'FIELD_USER_NICKNAME'
  | 'FIELD_USER_AVATAR'
  | 'FIELD_PROPERTIES'
  | 'FIELD_AUTOMATED'
  | 'FIELD_PICKER_ID'
  | 'FIELD_PICKER_TEXT'
  | 'FIELD_PICKER_CHOICES'
  | 'FIELD_CHOICE_VALUE'
  | 'FIELD_CHOICE_LABEL'
  | 'FIELD_CHOICE_SELECTED'
  | 'FIELD_UNKNOWN';
type CrispSchemaIssueCode =
  | 'ISSUE_REQUIRED'
  | 'ISSUE_TYPE'
  | 'ISSUE_ENUM'
  | 'ISSUE_PATTERN'
  | 'ISSUE_LENGTH'
  | 'ISSUE_UNKNOWN_FIELD'
  | 'ISSUE_INVALID'
  | 'ISSUE_UNKNOWN';

interface CrispProviderDiagnostic {
  providerError?: boolean;
  reasonCode: CrispProviderReasonCode;
  responseState: CrispProviderResponseState;
  schemaField: CrispSchemaFieldCode;
  schemaIssue: CrispSchemaIssueCode;
}

type CrispRequestType = 'text' | 'picker' | 'unknown';
type CrispProviderErrorState = 'ERROR_TRUE' | 'ERROR_FALSE' | 'ERROR_UNKNOWN';

function crispRequestType(body: Record<string, unknown>): CrispRequestType {
  return body.type === 'picker' ? 'picker' : body.type === 'text' ? 'text' : 'unknown';
}

function safeCrispOperationId(operationId: string): string | null {
  return CRISP_OPERATION_ID_PATTERN.test(operationId) ? operationId : null;
}

function crispProviderErrorState(providerError: boolean | undefined): CrispProviderErrorState {
  return providerError === true ? 'ERROR_TRUE' : providerError === false ? 'ERROR_FALSE' : 'ERROR_UNKNOWN';
}

function safeCrispSchemaField(message: unknown): CrispSchemaFieldCode {
  if (typeof message !== 'string' || message.length === 0 || message.length > CRISP_ERROR_DIAGNOSTIC_MAX_BYTES) {
    return 'FIELD_UNKNOWN';
  }
  const value = message.toLowerCase();
  const checks: Array<[RegExp, CrispSchemaFieldCode]> = [
    [/\b(?:choice|choices)[._\[\]0-9 -]*selected\b|\bselected\b/, 'FIELD_CHOICE_SELECTED'],
    [/\b(?:choice|choices)[._\[\]0-9 -]*label\b|\blabel\b/, 'FIELD_CHOICE_LABEL'],
    [/\b(?:choice|choices)[._\[\]0-9 -]*value\b/, 'FIELD_CHOICE_VALUE'],
    [/\bchoices\b/, 'FIELD_PICKER_CHOICES'],
    [/\bcontent[._ ]+id\b|\bpicker[._ ]+id\b/, 'FIELD_PICKER_ID'],
    [/\bcontent[._ ]+text\b|\bpicker[._ ]+text\b/, 'FIELD_PICKER_TEXT'],
    [/\buser[._ ]+nickname\b|\bnickname\b/, 'FIELD_USER_NICKNAME'],
    [/\buser[._ ]+avatar\b|\bavatar\b/, 'FIELD_USER_AVATAR'],
    [/\buser[._ ]+user_id\b|\buser_id\b/, 'FIELD_USER_ID'],
    [/\buser[._ ]+type\b/, 'FIELD_USER_TYPE'],
    [/\bproperties\b/, 'FIELD_PROPERTIES'],
    [/\bautomated\b/, 'FIELD_AUTOMATED'],
    [/\bcontent\b/, 'FIELD_CONTENT'],
    [/\borigin\b/, 'FIELD_ORIGIN'],
    [/\bfrom\b/, 'FIELD_FROM'],
    [/\btype\b/, 'FIELD_TYPE'],
    [/\buser\b/, 'FIELD_USER']
  ];
  return checks.find(([pattern]) => pattern.test(value))?.[1] ?? 'FIELD_UNKNOWN';
}

function safeCrispSchemaIssue(message: unknown): CrispSchemaIssueCode {
  if (typeof message !== 'string' || message.length === 0 || message.length > CRISP_ERROR_DIAGNOSTIC_MAX_BYTES) {
    return 'ISSUE_UNKNOWN';
  }
  const value = message.toLowerCase();
  if (/\brequired\b|\bmissing\b/.test(value)) return 'ISSUE_REQUIRED';
  if (/\bunknown field\b|\bunrecognized\b|\bnot allowed\b|\badditional propert/.test(value)) {
    return 'ISSUE_UNKNOWN_FIELD';
  }
  if (/\bmust be (?:a |an )?(?:string|boolean|number|object|array|integer)\b|\bexpected (?:a |an )?(?:string|boolean|number|object|array|integer)\b/.test(value)) {
    return 'ISSUE_TYPE';
  }
  if (/\benum\b|\bone of\b|\ballowed value/.test(value)) return 'ISSUE_ENUM';
  if (/\bpattern\b|\bformat\b/.test(value)) return 'ISSUE_PATTERN';
  if (/\btoo long\b|\btoo short\b|\bmaximum\b|\bminimum\b|\blength\b/.test(value)) return 'ISSUE_LENGTH';
  if (/\binvalid\b|\brejected\b/.test(value)) return 'ISSUE_INVALID';
  return 'ISSUE_UNKNOWN';
}

async function persistCrispHttp400Diagnostic(
  env: Env,
  operationIdInput: string,
  body: Record<string, unknown>,
  diagnostic: CrispProviderDiagnostic
): Promise<void> {
  const operationId = safeCrispOperationId(operationIdInput);
  if (!operationId) return;
  await insertReliabilityAuditOnce(env, {
    id: `crisp-http400-diagnostic:v2:${operationId}`,
    entityType: 'OUTBOUND_OPERATION',
    entityId: operationId,
    action: 'CRISP_HTTP_400_DIAGNOSTIC',
    actorType: 'SYSTEM',
    actorRef: 'system:crisp-adapter',
    oldState: 'HTTP_400',
    newState: `${crispRequestType(body)}:${diagnostic.responseState}:${crispProviderErrorState(diagnostic.providerError)}:${diagnostic.schemaField}:${diagnostic.schemaIssue}`,
    reasonCode: diagnostic.reasonCode,
    createdAt: Math.floor(Date.now() / 1000)
  });
}

function safeCrispReason(reason: unknown): CrispProviderReasonCode {
  if (reason === 'invalid_data' || reason === 'invalid_session') return reason;
  return 'UNKNOWN_PROVIDER_REASON';
}

async function readBoundedCrispError(response: Response): Promise<CrispProviderDiagnostic> {
  if (!response.body) {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'EMPTY', schemaField: 'FIELD_UNKNOWN', schemaIssue: 'ISSUE_UNKNOWN' };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CRISP_ERROR_DIAGNOSTIC_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'TOO_LARGE', schemaField: 'FIELD_UNKNOWN', schemaIssue: 'ISSUE_UNKNOWN' };
      }
      chunks.push(value);
    }
  } catch {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'READ_ERROR', schemaField: 'FIELD_UNKNOWN', schemaIssue: 'ISSUE_UNKNOWN' };
  }

  if (total === 0) {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'EMPTY', schemaField: 'FIELD_UNKNOWN', schemaIssue: 'ISSUE_UNKNOWN' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'NON_JSON', schemaField: 'FIELD_UNKNOWN', schemaIssue: 'ISSUE_UNKNOWN' };
    }
    const record = payload as { error?: unknown; reason?: unknown; data?: unknown };
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as { message?: unknown }
      : undefined;
    const message = record.reason === 'invalid_data' ? data?.message : undefined;
    return {
      ...(typeof record.error === 'boolean' ? { providerError: record.error } : {}),
      reasonCode: safeCrispReason(record.reason),
      responseState: 'JSON_OBJECT',
      schemaField: safeCrispSchemaField(message),
      schemaIssue: safeCrispSchemaIssue(message)
    };
  } catch {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'NON_JSON', schemaField: 'FIELD_UNKNOWN', schemaIssue: 'ISSUE_UNKNOWN' };
  }
}

async function recordCrispHttp400Diagnostic(
  env: Env,
  operationId: string,
  response: Response,
  body: Record<string, unknown>
): Promise<void> {
  const diagnostic = await readBoundedCrispError(response).catch((): CrispProviderDiagnostic => ({
    reasonCode: 'UNKNOWN_PROVIDER_REASON',
    responseState: 'READ_ERROR',
    schemaField: 'FIELD_UNKNOWN',
    schemaIssue: 'ISSUE_UNKNOWN'
  }));
  await persistCrispHttp400Diagnostic(env, operationId, body, diagnostic).catch(() => undefined);
  logger.warn('Crisp outbound provider rejected request', {
    source: 'crisp',
    provider: 'CRISP',
    stage: 'CRISP_PROVIDER_RESPONSE',
    http_status: response.status,
    request_type: crispRequestType(body),
    ...(diagnostic.providerError !== undefined ? { provider_error: diagnostic.providerError } : {}),
    provider_reason_code: diagnostic.reasonCode,
    provider_response_state: diagnostic.responseState
  });
}

function crispAuth(env: Env): string {
  if (!env.CRISP_API_IDENTIFIER || !env.CRISP_API_KEY) {
    throw new ProviderDeliveryError('FINAL', 'OUTBOUND_PRECONDITION_FAILED', { provider: 'CRISP' });
  }
  return `Basic ${btoa(`${env.CRISP_API_IDENTIFIER}:${env.CRISP_API_KEY}`)}`;
}

export async function fetchCrispConversationState(
  env: Env,
  websiteRef: string,
  sessionRef: string
): Promise<CrispConversationState> {
  let authorization: string;
  try {
    authorization = crispAuth(env);
  } catch {
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED', { provider: 'CRISP', stage: 'PREPARE' });
  }
  const url = `${CRISP_API_BASE}/website/${encodeURIComponent(websiteRef)}/conversation/${encodeURIComponent(sessionRef)}/state`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'X-Crisp-Tier': 'plugin'
      }
    });
  } catch {
    throw new RetryableProcessingError('CRISP_STATE_READ_FAILED', 5, {
      provider: 'CRISP',
      stage: 'SOURCE_METADATA'
    });
  }
  if (!response.ok) {
    throw new RetryableProcessingError('CRISP_STATE_READ_FAILED', 5, {
      provider: 'CRISP',
      stage: 'SOURCE_METADATA',
      httpStatus: response.status
    });
  }
  try {
    const payload = await response.json() as { data?: { state?: unknown } };
    const state = payload.data?.state;
    if (state !== 'pending' && state !== 'unresolved' && state !== 'resolved') {
      throw new SafeError('CRISP_STATE_INVALID', { provider: 'CRISP', stage: 'PARSE_RESPONSE' });
    }
    return state;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('CRISP_STATE_INVALID', { provider: 'CRISP', stage: 'PARSE_RESPONSE' });
  }
}

async function sendCrispMessage(
  env: Env,
  websiteRef: string,
  sessionRef: string,
  body: Record<string, unknown>,
  operationId: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ fingerprint: string }> {
  const url = `${CRISP_API_BASE}/website/${encodeURIComponent(websiteRef)}/conversation/${encodeURIComponent(sessionRef)}/message`;
  if (lifecycle) await lifecycle.requestStarted();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: crispAuth(env),
        'Content-Type': 'application/json',
        'X-Crisp-Tier': 'plugin'
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw visibleTransportDeliveryError('CRISP');
  }
  if (lifecycle) await lifecycle.responseObserved(response.status);
  if (!response.ok) {
    if (response.status === 400) {
      await recordCrispHttp400Diagnostic(env, operationId, response, body).catch(() => undefined);
    }
    throw visibleHttpDeliveryError('CRISP', response.status);
  }
  try {
    const payload = await response.json() as { data?: { fingerprint?: unknown; id?: unknown } };
    const fingerprint = payload.data?.fingerprint ?? payload.data?.id;
    if (typeof fingerprint !== 'string' && typeof fingerprint !== 'number') {
      throw invalidVisibleSuccessError('CRISP');
    }
    return { fingerprint: String(fingerprint) };
  } catch (error) {
    if (error instanceof ProviderDeliveryError) throw error;
    throw invalidVisibleSuccessError('CRISP');
  }
}

export async function createCrispMessage(
  env: Env,
  websiteRef: string,
  sessionRef: string,
  content: string,
  outboundOperationId: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ messageId: string }> {
  const fingerprint = await crispFingerprintForOperation(outboundOperationId);
  const result = await sendCrispMessage(env, websiteRef, sessionRef, {
    type: 'text',
    from: 'operator',
    origin: 'chat',
    content,
    fingerprint,
    user: CRISP_AUTOMATED_USER,
    automated: true
  }, outboundOperationId, lifecycle);
  return { messageId: result.fingerprint };
}

export interface CrispPickerChoice {
  value: string;
  label: string;
  selected?: boolean;
}

export async function createCrispPicker(
  env: Env,
  websiteRef: string,
  sessionRef: string,
  id: string,
  text: string,
  choices: CrispPickerChoice[],
  outboundOperationId: string,
  lifecycle?: OutboundAttemptLifecycle
): Promise<{ messageId: string }> {
  const fingerprint = await crispFingerprintForOperation(outboundOperationId);
  const result = await sendCrispMessage(env, websiteRef, sessionRef, {
    type: 'picker',
    from: 'operator',
    origin: 'chat',
    content: { id, text, choices: choices.map(choice => ({ ...choice, selected: choice.selected ?? false })) },
    fingerprint,
    user: CRISP_AUTOMATED_USER,
    automated: true
  }, outboundOperationId, lifecycle);
  return { messageId: result.fingerprint };
}
