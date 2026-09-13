import { verifyChatwootWebhook } from './adapters/chatwoot/webhook';
import { verifyTelegramWebhook } from './adapters/telegram/webhook';
import { SupportEvent } from './core/events';
import { handleQueueEvent } from './queue/consumer';
import { logger } from './observability/logger';
import { RetryableProcessingError } from './core/errors';
import { Env } from './config/env';

export type { Env } from './config/env';

async function chatwootFallbackEventId(eventType: string, rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `cw_${eventType}_${hex}`;
}

function hasProviderId(value: unknown): boolean {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'number';
}

function isValidChatwootEvent(payload: Record<string, any>): boolean {
  if (!hasProviderId(payload.account?.id)) return false;
  if (payload.event === 'conversation_status_changed') {
    return hasProviderId(payload.id) && typeof payload.status === 'string';
  }
  if (payload.event !== 'message_created') return false;
  if (!hasProviderId(payload.id) || !hasProviderId(payload.conversation?.id)) return false;
  if (payload.message_type !== 'incoming' && payload.message_type !== 'outgoing') return false;
  if (typeof payload.content !== 'string') return false;
  return payload.message_type !== 'incoming' || hasProviderId(payload.sender?.id);
}

function normalizeChatwootEvent(payload: Record<string, any>, eventId: string): SupportEvent | null {
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
  return {
    version: 1,
    source: 'chatwoot',
    type: 'message_created',
    eventId,
    payload: {
      accountRef,
      conversationRef,
      customerRef: customer?.id === undefined ? `conversation:${conversationRef}` : String(customer.id),
      customerName: typeof customer?.name === 'string' && customer.name.trim() ? customer.name.trim() : undefined,
      messageRef: String(payload.id),
      content: payload.content,
      actorRole: isOutgoing ? 'OPERATOR' : 'CUSTOMER'
    }
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

      // Fast-drop only after the signature has been verified.
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
      const event = normalizeChatwootEvent(payload, eventId);
      if (!event) return new Response('Ignored', { status: 200 });
      await env.QUEUE.send(event);

      return new Response('Accepted', { status: 200 });
    }

    if (url.pathname.startsWith('/webhooks/telegram/')) {
      if (!env.TELEGRAM_SECRET_PATH || env.TELEGRAM_SECRET_PATH === env.TELEGRAM_BOT_TOKEN) {
        return new Response('Webhook configuration error', { status: 500 });
      }
      const pathSegment = url.pathname.replace('/webhooks/telegram/', '');
      const { valid, payload, updateId } = await verifyTelegramWebhook(
        request, 
        pathSegment, 
        env.TELEGRAM_SECRET_PATH, 
        env.TELEGRAM_WEBHOOK_SECRET,
        env.BOT_GROUP_ID
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

      const content = telegramMessage.text || telegramMessage.caption;
      if (typeof content !== 'string' || content.length === 0 || !hasProviderId(telegramMessage.message_id)) {
        return new Response('Ignored', { status: 200 });
      }

      await env.QUEUE.send({
        version: 1,
        source: 'telegram',
        type: 'message_created',
        eventId: `tg_${updateId}`,
        payload: {
          updateRef: updateId,
          messageRef: String(telegramMessage.message_id),
          threadRef: String(telegramMessage.message_thread_id),
          content
        }
      });

      return new Response('Accepted', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async queue(batch: MessageBatch<SupportEvent>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleQueueEvent(message.body, env);
        message.ack();
      } catch (error) {
        logger.error('Failed to process queue message', error, { eventId: message.body.eventId });
        if (error instanceof RetryableProcessingError) {
          message.retry({ delaySeconds: error.retryAfterSeconds });
        } else {
          message.retry();
        }
      }
    }
  }
};
