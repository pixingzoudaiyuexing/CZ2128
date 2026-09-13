import { verifyChatwootWebhook } from './adapters/chatwoot/webhook';
import { verifyTelegramWebhook } from './adapters/telegram/webhook';
import { SupportEvent } from './core/events';
import { handleQueueEvent } from './queue/consumer';
import { RetryLaterError } from './core/events';
import { logger } from './observability/logger';

export interface Env {
  DB: D1Database;
  QUEUE: Queue<SupportEvent>;
  CHATWOOT_WEBHOOK_SECRET: string;
  CHATWOOT_API_TOKEN: string;
  CHATWOOT_API_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_SECRET_PATH: string;
  BOT_GROUP_ID: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_REQUEST_TIMEOUT_MS?: string;
  AI_CONTEXT_MAX_MESSAGES?: string;
  AI_CONTEXT_MAX_CHARS?: string;
  AI_GENERATION_LEASE_SECONDS?: string;
  AI_OPERATOR_PAUSE_TIMEOUT_SECONDS?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/webhooks/chatwoot') {
      const { valid, payload, deliveryId } = await verifyChatwootWebhook(request, env.CHATWOOT_WEBHOOK_SECRET);
      
      if (!valid) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Fast drop echoes
      if (payload.event === 'message_created' && payload.source_id && String(payload.source_id).startsWith('cz2128:')) {
        return new Response('Echo dropped', { status: 200 });
      }

      const eventId = deliveryId || `cw_${payload.account?.id}_${payload.event}_${payload.id}`;

      await env.QUEUE.send({
        source: 'chatwoot',
        type: payload.event,
        eventId,
        payload
      });

      return new Response('Accepted', { status: 200 });
    }

    if (url.pathname.startsWith('/webhooks/telegram/')) {
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
      
      const isBot = payload.message?.from?.is_bot || payload.edited_message?.from?.is_bot || false;
      if (isBot) {
        // Safe fast-drop for bot messages
        return new Response('Accepted', { status: 200 });
      }

      await env.QUEUE.send({
        source: 'telegram',
        type: 'message_created',
        eventId: `tg_${updateId}`,
        payload
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
        message.retry();
      }
    }
  }
};
