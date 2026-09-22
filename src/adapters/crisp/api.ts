import { Env } from '../../config/env';
import { ProviderDeliveryError } from '../../core/errors';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../../core/provider-retry';
import { OutboundAttemptLifecycle } from '../../core/outbound-operations';
import { insertReliabilityAuditOnce } from '../../core/reliability-audit';
import { logger } from '../../observability/logger';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';
const CRISP_AUTOMATED_USER = { nickname: 'CZ2128' };
const CRISP_ERROR_DIAGNOSTIC_MAX_BYTES = 4096;
const CRISP_OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,512}$/;

type CrispProviderReasonCode = 'invalid_data' | 'invalid_session' | 'UNKNOWN_PROVIDER_REASON';
type CrispProviderResponseState = 'JSON_OBJECT' | 'EMPTY' | 'NON_JSON' | 'TOO_LARGE' | 'READ_ERROR';

interface CrispProviderDiagnostic {
  providerError?: boolean;
  reasonCode: CrispProviderReasonCode;
  responseState: CrispProviderResponseState;
}

type CrispRequestType = 'text' | 'picker' | 'unknown';
type CrispProviderErrorState = 'ERROR_TRUE' | 'ERROR_FALSE' | 'ERROR_UNKNOWN';

function crispRequestType(body: Record<string, unknown>): CrispRequestType {
  return body.type === 'picker' ? 'picker' : body.type === 'text' ? 'text' : 'unknown';
}

function crispOperationId(body: Record<string, unknown>): string | null {
  const properties = body.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const operationId = (properties as { cz2128_operation_id?: unknown }).cz2128_operation_id;
  return typeof operationId === 'string' && CRISP_OPERATION_ID_PATTERN.test(operationId) ? operationId : null;
}

function crispProviderErrorState(providerError: boolean | undefined): CrispProviderErrorState {
  return providerError === true ? 'ERROR_TRUE' : providerError === false ? 'ERROR_FALSE' : 'ERROR_UNKNOWN';
}

async function persistCrispHttp400Diagnostic(
  env: Env,
  body: Record<string, unknown>,
  diagnostic: CrispProviderDiagnostic
): Promise<void> {
  const operationId = crispOperationId(body);
  if (!operationId) return;
  await insertReliabilityAuditOnce(env, {
    id: `crisp-http400-diagnostic:v1:${operationId}`,
    entityType: 'OUTBOUND_OPERATION',
    entityId: operationId,
    action: 'CRISP_HTTP_400_DIAGNOSTIC',
    actorType: 'SYSTEM',
    actorRef: 'system:crisp-adapter',
    oldState: 'HTTP_400',
    newState: `${crispRequestType(body)}:${diagnostic.responseState}:${crispProviderErrorState(diagnostic.providerError)}`,
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
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'EMPTY' };
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
        return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'READ_ERROR' };
  }

  if (total === 0) {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'EMPTY' };
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
      return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'NON_JSON' };
    }
    const record = payload as { error?: unknown; reason?: unknown };
    return {
      ...(typeof record.error === 'boolean' ? { providerError: record.error } : {}),
      reasonCode: safeCrispReason(record.reason),
      responseState: 'JSON_OBJECT'
    };
  } catch {
    return { reasonCode: 'UNKNOWN_PROVIDER_REASON', responseState: 'NON_JSON' };
  }
}

async function recordCrispHttp400Diagnostic(
  env: Env,
  response: Response,
  body: Record<string, unknown>
): Promise<void> {
  const diagnostic = await readBoundedCrispError(response).catch((): CrispProviderDiagnostic => ({
    reasonCode: 'UNKNOWN_PROVIDER_REASON',
    responseState: 'READ_ERROR'
  }));
  await persistCrispHttp400Diagnostic(env, body, diagnostic).catch(() => undefined);
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

async function sendCrispMessage(
  env: Env,
  websiteRef: string,
  sessionRef: string,
  body: Record<string, unknown>,
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
    if (response.status === 400) await recordCrispHttp400Diagnostic(env, response, body).catch(() => undefined);
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
  const result = await sendCrispMessage(env, websiteRef, sessionRef, {
    type: 'text',
    from: 'operator',
    origin: 'chat',
    content,
    user: CRISP_AUTOMATED_USER,
    automated: true,
    properties: { cz2128_operation_id: outboundOperationId }
  }, lifecycle);
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
  const result = await sendCrispMessage(env, websiteRef, sessionRef, {
    type: 'picker',
    from: 'operator',
    origin: 'chat',
    content: { id, text, choices: choices.map(choice => ({ ...choice, selected: choice.selected ?? false })) },
    user: CRISP_AUTOMATED_USER,
    automated: true,
    properties: { cz2128_operation_id: outboundOperationId }
  }, lifecycle);
  return { messageId: result.fingerprint };
}
