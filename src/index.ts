import { verifyChatwootWebhook } from './adapters/chatwoot/webhook';
import {
  CrispWebhookPayload,
  crispMessageEventId,
  readCrispPickerSelection,
  verifyCrispWebhook
} from './adapters/crisp/webhook';
import { verifyTelegramWebhook } from './adapters/telegram/webhook';
import { Env } from './config/env';
import { RetryableProcessingError } from './core/errors';
import { SupportEvent } from './core/events';
import { logger } from './observability/logger';
import { handleQueueEvent } from './queue/consumer';
import { getAttachmentConfig } from './config/attachments';
import { discoverChatwootAttachments, discoverTelegramAttachments } from './attachments/discovery';
import { handleAttachmentProxy } from './attachments/proxy';
import { cleanupExpiredAttachments } from './attachments/cleanup';
import { AttachmentDescriptor } from './core/attachments';
import { handleAdminTelegramWebhook } from './admin/handler';
import { resolveEffectiveEnv } from './runtime-config/resolver';
import { boundedQueueRetryDelay } from './core/retry';
import { captureDlqMessage } from './queue/dlq-consumer';
import { persistDlqQuarantine } from './queue/dlq-quarantine';
import { resolveQueueIdentities } from './config/queue-identities';

export type { Env } from './config/env';

async function chatwootFallbackEventId(eventType: string, rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `cw_${eventType}_${hex}`;
}

function hasProviderId(value: unknown): boolean {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'number';
}

function boundedAttachments(
  attachments: AttachmentDescriptor[],
  maxCount: number,
  source: 'chatwoot' | 'telegram'
): AttachmentDescriptor[] {
  if (attachments.length > maxCount) {
    logger.warn('Attachment count exceeds configured limit', {
      source,
      error_category: 'ATTACHMENT_COUNT_LIMIT',
      error_code: 'ATTACHMENT_COUNT_LIMIT',
      stage: 'SOURCE_METADATA'
    });
  }
  return attachments.slice(0, maxCount);
}

function isValidChatwootEvent(payload: Record<string, any>): boolean {
  if (!hasProviderId(payload.account?.id)) return false;
  if (payload.event === 'conversation_status_changed') {
    return hasProviderId(payload.id) && typeof payload.status === 'string';
  }
  if (payload.event !== 'message_created') return false;
  if (!hasProviderId(payload.id) || !hasProviderId(payload.conversation?.id)) return false;
  if (payload.message_type !== 'incoming' && payload.message_type !== 'outgoing') return false;
  if (typeof payload.content !== 'string' && !Array.isArray(payload.attachments)) return false;
  return payload.message_type !== 'incoming' || hasProviderId(payload.sender?.id);
}

function normalizeChatwootEvent(
  payload: Record<string, any>,
  eventId: string,
  attachmentConfig: ReturnType<typeof getAttachmentConfig>
): SupportEvent | null {
  const accountRef = String(payload.account.id);
  if (payload.event === 'conversation_status_changed') {
    if (payload.status !== 'open' && payload.status !== 'resolved') return null;
    return {
      version: 1,
      source: 'chatwoot',
      type: 'conversation_status_changed',
      eventId,
      payload: { accountRef, conversationRef: String(payload.id), status: payload.status }
    };
  }

  if (payload.message_type === 'outgoing' && (payload.private === true || payload.sender?.type !== 'user')) {
    return null;
  }
  const isOutgoing = payload.message_type === 'outgoing';
  const customer = payload.conversation?.meta?.sender || (!isOutgoing ? payload.sender : undefined);
  const conversationRef = String(payload.conversation.id);
  const attachments = boundedAttachments(
    discoverChatwootAttachments(payload, attachmentConfig),
    attachmentConfig.maxCountPerMessage,
    'chatwoot'
  );
  const content = typeof payload.content === 'string' && payload.content.length > 0 ? payload.content : undefined;
  const customerName = typeof customer?.name === 'string' && customer.name.trim() ? customer.name.trim() : undefined;
  return {
    version: 1,
    source: 'chatwoot',
    type: 'message_created',
    eventId,
    payload: {
      accountRef,
      conversationRef,
      customerRef: customer?.id === undefined ? `conversation:${conversationRef}` : String(customer.id),
      messageRef: String(payload.id),
      actorRole: isOutgoing ? 'OPERATOR' : 'CUSTOMER',
      ...(customerName ? { customerName } : {}),
      ...(content ? { content } : {}),
      ...(attachments.length > 0 ? { attachments } : {})
    }
  };
}

export function normalizeCrispEvent(
  payload: Record<string, any>,
  eventId: string,
  expectedWebsiteId?: string
): SupportEvent | null {
  if (expectedWebsiteId && String(payload.data?.website_id) !== expectedWebsiteId) return null;
  if (!['message:send', 'message:received', 'message:updated'].includes(payload.event)) return null;
  const data = payload.data;
  if (typeof data?.website_id !== 'string' || typeof data?.session_id !== 'string') return null;
  const operationMarker = data.properties?.cz2128_operation_id;
  const isCz2128Echo = payload.event === 'message:received' &&
    data.from === 'operator' && data.origin === 'chat' && data.automated === true &&
    data.user?.type === 'operator' && data.user?.user_id === 'cz2128' &&
    typeof operationMarker === 'string' && /^[A-Za-z0-9:_-]{1,512}$/.test(operationMarker);
  if (isCz2128Echo) return null;

  const selection = readCrispPickerSelection(payload as CrispWebhookPayload);
  if (payload.event === 'message:updated' && !selection) return null;
  if (payload.event !== 'message:updated' && data.type !== 'text') return null;
  const content = selection?.label || (typeof data.content === 'string' ? data.content : undefined);
  if (!content) return null;
  const isOperator = payload.event === 'message:received';
  const customerRef = typeof data.user?.user_id === 'string' && data.user.user_id
    ? data.user.user_id
    : `session:${data.session_id}`;
  const customerName = typeof data.user?.nickname === 'string' && data.user.nickname.trim()
    ? data.user.nickname.trim()
    : undefined;
  const messageRef = selection ? eventId : data.fingerprint === undefined
    ? eventId
    : String(data.fingerprint);
  return {
    version: 1,
    source: 'crisp',
    type: 'message_created',
    eventId,
    payload: {
      websiteRef: data.website_id,
      sessionRef: data.session_id,
      customerRef,
      ...(customerName ? { customerName } : {}),
      messageRef,
      actorRole: isOperator ? 'OPERATOR' : 'CUSTOMER',
      content,
      ...(selection ? {
        selection: {
          pickerId: selection.pickerId,
          pickerMessageRef: selection.pickerMessageRef,
          value: selection.value,
          label: selection.label
        }
      } : {})
    }
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/attachments/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const token = url.pathname.slice('/attachments/'.length);
      return handleAttachmentProxy(request, env, token);
    }

    if (url.pathname.startsWith('/webhooks/admin-telegram/')) {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleAdminTelegramWebhook(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/webhooks/chatwoot') {
      const { valid, payload, deliveryId, rawBody } = await verifyChatwootWebhook(request, env.CHATWOOT_WEBHOOK_SECRET);

      if (!valid) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (!payload || !rawBody) {
        return new Response('Malformed event', { status: 400 });
      }

      if (payload.event !== 'message_created' && payload.event !== 'conversation_status_changed') {
        return new Response('Ignored', { status: 200 });
      }

      if (payload.event === 'message_created' && payload.source_id && String(payload.source_id).startsWith('cz2128:')) {
        return new Response('Echo dropped', { status: 200 });
      }

      if (payload.event === 'message_created' && payload.message_type !== 'incoming' && payload.message_type !== 'outgoing') {
        return new Response('Ignored', { status: 200 });
      }

      if (!isValidChatwootEvent(payload)) {
        return new Response('Malformed event', { status: 400 });
      }

      const eventId = deliveryId || await chatwootFallbackEventId(payload.event, rawBody);
      const effectiveEnv = await resolveEffectiveEnv(env);
      const event = normalizeChatwootEvent(payload, eventId, getAttachmentConfig(effectiveEnv));
      if (!event) return new Response('Ignored', { status: 200 });
      await env.QUEUE.send(event);

      return new Response('Accepted', { status: 200 });
    }

    if (url.pathname === '/webhooks/crisp') {
      const verified = await verifyCrispWebhook(request, env.CRISP_WEBHOOK_SECRET, env.CRISP_WEBSITE_ID);
      if (!verified.valid || !verified.payload || !verified.rawBody) {
        logger.warn('Crisp webhook verification rejected', {
          source: 'crisp',
          error_category: verified.failure ?? 'CRISP_VERIFY_UNKNOWN',
          stage: 'CRISP_WEBHOOK_VERIFY',
          result: verified.timestampFormat ?? 'unknown',
          http_status: 401
        });
        return new Response('Unauthorized', { status: 401 });
      }
      const event = normalizeCrispEvent(
        verified.payload,
        await crispMessageEventId(verified.payload, verified.rawBody),
        env.CRISP_WEBSITE_ID
      );
      if (!event) return new Response('Ignored', { status: 200 });
      await env.QUEUE.send(event);
      return new Response('Accepted', { status: 200 });
    }

    if (url.pathname.startsWith('/webhooks/telegram/')) {
      const effectiveEnv = await resolveEffectiveEnv(env);
      if (!effectiveEnv.TELEGRAM_SECRET_PATH || effectiveEnv.TELEGRAM_SECRET_PATH === effectiveEnv.TELEGRAM_BOT_TOKEN) {
        return new Response('Webhook configuration error', { status: 500 });
      }
      const pathSegment = url.pathname.replace('/webhooks/telegram/', '');
      const { valid, payload, updateId } = await verifyTelegramWebhook(
        request,
        pathSegment,
        effectiveEnv.TELEGRAM_SECRET_PATH,
        effectiveEnv.TELEGRAM_WEBHOOK_SECRET,
        effectiveEnv.BOT_GROUP_ID
      );

      if (!valid) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (!updateId) {
        return new Response('Malformed update', { status: 400 });
      }

      const telegramMessage = payload.message || payload.edited_message;
      if (!telegramMessage) {
        return new Response('Ignored', { status: 200 });
      }

      if (!telegramMessage.from || typeof telegramMessage.from.is_bot !== 'boolean') {
        return new Response('Malformed update', { status: 400 });
      }

      if (telegramMessage.from.is_bot) {
        return new Response('Accepted', { status: 200 });
      }

      if (telegramMessage.message_thread_id === undefined || telegramMessage.message_thread_id === null) {
        return new Response('Ignored', { status: 200 });
      }

      const attachmentConfig = getAttachmentConfig(effectiveEnv);
      const attachments = boundedAttachments(
        discoverTelegramAttachments(telegramMessage, attachmentConfig),
        attachmentConfig.maxCountPerMessage,
        'telegram'
      );
      const content = telegramMessage.text || telegramMessage.caption;
      if ((typeof content !== 'string' || content.length === 0) && attachments.length === 0) {
        return new Response('Ignored', { status: 200 });
      }
      if (!hasProviderId(telegramMessage.message_id)) {
        return new Response('Ignored', { status: 200 });
      }
      const supportProfileVersion = effectiveEnv.runtimeConfigSnapshot?.versions.TELEGRAM_SUPPORT_PROFILE ?? 0;

      await env.QUEUE.send({
        version: 1,
        source: 'telegram',
        type: 'message_created',
        eventId: `tg:${supportProfileVersion}:${updateId}`,
        payload: {
          supportProfileVersion,
          updateRef: updateId,
          messageRef: String(telegramMessage.message_id),
          threadRef: String(telegramMessage.message_thread_id),
          ...(typeof content === 'string' && content.length > 0 ? { content } : {}),
          ...(attachments.length > 0 ? { attachments } : {})
        }
      });

      return new Response('Accepted', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    let queueIdentities: ReturnType<typeof resolveQueueIdentities>;
    try {
      queueIdentities = resolveQueueIdentities(env);
    } catch (error) {
      logger.error('Queue identity configuration rejected', error, { source: batch.queue });
      for (const message of batch.messages) {
        message.retry({ delaySeconds: boundedQueueRetryDelay(undefined) });
      }
      return;
    }

    if (batch.queue === queueIdentities.dlq) {
      for (const message of batch.messages) {
        try {
          await captureDlqMessage(env, message, undefined, batch.queue);
          message.ack();
        } catch {
          try {
            const quarantined = await persistDlqQuarantine(env.DLQ_QUARANTINE, message, batch.queue);
            logger.warn('Sanitized DLQ receipt persisted to terminal quarantine', {
              source: batch.queue,
              operation_id: quarantined.quarantineId,
              error_code: 'D1_WRITE_FAILED'
            });
            message.ack();
          } catch (error) {
            logger.error('DLQ receipt and terminal quarantine persistence failed', error, {
              source: batch.queue,
              error_code: 'D1_WRITE_FAILED'
            });
            message.retry({ delaySeconds: boundedQueueRetryDelay(undefined) });
          }
        }
      }
      return;
    }

    if (batch.queue !== queueIdentities.main) {
      logger.warn('Unknown queue batch rejected', { source: batch.queue });
      for (const message of batch.messages) {
        message.retry({ delaySeconds: boundedQueueRetryDelay(undefined) });
      }
      return;
    }

    for (const message of batch.messages) {
      try {
        const effectiveEnv = await resolveEffectiveEnv(env);
        await handleQueueEvent(message.body as SupportEvent, effectiveEnv);
        message.ack();
      } catch (error) {
        const eventId = message.body && typeof message.body === 'object' && 'eventId' in message.body
          && typeof message.body.eventId === 'string'
          ? message.body.eventId
          : undefined;
        logger.error('Failed to process queue message', error, { eventId });
        if (error instanceof RetryableProcessingError) {
          message.retry({ delaySeconds: error.retryAfterSeconds });
        } else {
          message.retry({ delaySeconds: boundedQueueRetryDelay(undefined) });
        }
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpiredAttachments(env));
  }
};
