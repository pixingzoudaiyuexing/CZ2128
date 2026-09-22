import { Env } from '../../config/env';
import { ProviderDeliveryError } from '../../core/errors';
import {
  invalidVisibleSuccessError,
  visibleHttpDeliveryError,
  visibleTransportDeliveryError
} from '../../core/provider-retry';
import { OutboundAttemptLifecycle } from '../../core/outbound-operations';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';
const CRISP_AUTOMATED_USER = { nickname: 'CZ2128' };

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
  if (!response.ok) throw visibleHttpDeliveryError('CRISP', response.status);
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
