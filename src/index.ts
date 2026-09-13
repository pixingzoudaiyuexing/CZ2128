import { verifyChatwootWebhook } from './adapters/chatwoot/webhook';
import { verifyTelegramWebhook } from './adapters/telegram/webhook';
import { SupportEvent } from './core/events';
import { handleQueueEvent } from './queue/consumer';

export interface Env {
  DB: D1Database;
  QUEUE: Queue<SupportEvent>;
  CHATWOOT_WEBHOOK_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_SECRET_PATH: string;
  BOT_GROUP_ID: string;
  CHATWOOT_API_URL: string;
  CHATWOOT_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhooks/chatwoot') {
      const { valid, payload, deliveryId } = await verifyChatwootWebhook(request, env.CHATWOOT_WEBHOOK_SECRET);
      if (!valid || !payload) return new Response('Unauthorized', { status: 401 });

      // Fast-drop known CZ2128 echo using source_id marker
      if (payload.event === 'message_created' && payload.source_id && payload.source_id.startsWith('cz2128:')) {
        return new Response('OK', { status: 200 });
      }

      const eventId = deliveryId || String(payload.id);
      
      await env.QUEUE.send({
        eventId,
        source: 'chatwoot',
        type: payload.event,
        payload,
      });

      return new Response('OK', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname.startsWith('/webhooks/telegram/')) {
      const { valid, payload, updateId } = await verifyTelegramWebhook(
        request,
        env.TELEGRAM_WEBHOOK_SECRET,
        env.TELEGRAM_SECRET_PATH,
        env.BOT_GROUP_ID
      );
      if (!valid || !payload) return new Response('Unauthorized', { status: 401 });

      if (payload.message?.from?.is_bot) {
        return new Response('OK', { status: 200 });
      }

      await env.QUEUE.send({
        eventId: updateId || String(Date.now()),
        source: 'telegram',
        type: 'message_created',
        payload,
      });

      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async queue(batch: MessageBatch<SupportEvent>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await handleQueueEvent(msg.body, env);
        msg.ack();
      } catch (error) {
        console.error('Failed to process message', error);
        msg.retry();
      }
    }
  }
};
