import { createCrispMessage, createCrispPicker, CrispPickerChoice } from '../adapters/crisp/api';
import { crispFingerprintForOperation } from '../adapters/crisp/fingerprint';
import { createTelegramTopic, sendTelegramMessage } from '../adapters/telegram/api';
import { getAIConfig } from '../config/ai';
import { getAttachmentConfig } from '../config/attachments';
import { Env } from '../config/env';
import { checkAutoResume, pauseOperator, pauseOperatorForCrispSelection } from '../core/ai-state';
import { getOrCreateConversation, insertMessage, updateOperatorThreadRef } from '../core/conversation-service';
import { enqueueAttachmentJobs } from '../core/attachment-repository';
import { RetryableProcessingError } from '../core/errors';
import { CrispEvent, CrispMessageEvent } from '../core/events';
import { executeOutboundOperation, getOutboundOperation } from '../core/outbound-operations';
import { buildCrispTargetEvidence, buildTelegramTargetEvidence } from '../core/outbound-evidence';
import { isAiConversationAllowed } from '../config/ai-test-scope';
import { logger } from '../observability/logger';
import {
  loadCrispConversation,
  reconcileCrispLifecycle,
  reconcileCrispLifecycleIdentity
} from './crisp-lifecycle';

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

async function sendCrispTextOperation(
  env: Env,
  conversationId: string,
  websiteRef: string,
  sessionRef: string,
  operationId: string,
  content: string,
  subjectRef: string
): Promise<void> {
  await executeOutboundOperation(
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
): Promise<void> {
  await executeOutboundOperation(
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
  if (isOperator) await pauseOperator(env, conv.id);
  if (content) {
    await insertMessage(
      env, conv.id, 'crisp', payload.messageRef,
      isOperator ? 'OUTBOUND' : 'INBOUND', payload.actorRole, 'TEXT', content
    );
  }

  const wasNewConversation = !conv.operator_thread_ref;
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
    'telegram'
  );

  if (content) {
    await executeOutboundOperation(
      env,
      conv.id,
      'telegram',
      'SEND_MESSAGE',
      async (_opId, lifecycle) => {
        const response = await sendTelegramMessage(env, env.BOT_GROUP_ID, threadRef, content, lifecycle);
        return { providerMessageRef: response.messageId };
      },
      `send_tg_crisp_${payload.messageRef}`,
      {
        subject: { type: 'MESSAGE', ref: `crisp:${payload.messageRef}` },
        targetEvidence: buildTelegramTargetEvidence(env, env.BOT_GROUP_ID, threadRef, 'sendMessage')
      }
    );
  }

  const menu = parseCrispMenu(env.CRISP_MENU_JSON);
  if (!isOperator && wasNewConversation && (menu || env.CRISP_WELCOME_TEXT)) {
    if (menu?.welcome || env.CRISP_WELCOME_TEXT) {
      await sendCrispTextOperation(
        env, conv.id, payload.websiteRef, payload.sessionRef,
        `crisp_welcome:${conv.id}`, menu?.welcome || env.CRISP_WELCOME_TEXT!, `crisp-welcome:${conv.id}`
      );
    }
    if (menu?.picker) {
      await sendCrispPickerOperation(
        env, conv.id, payload.websiteRef, payload.sessionRef,
        `crisp_picker:${conv.id}:${menu.picker.id}`, menu.picker
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