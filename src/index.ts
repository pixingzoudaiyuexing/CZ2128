import { verifyChatwootWebhook } from './adapters/chatwoot/webhook';
import { verifyTelegramWebhook } from './adapters/telegram/webhook';
import { SupportEvent } from './core/events';

export interface Env {
  DB: D1Database;
  QUEUE: Queue<SupportEvent>;
  CHATWOOT_WEBHOOK_SECRET: string;
  CHATWOOT_API_TOKEN: string;
  CHATWOOT_API_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  BOT_GROUP_ID: string;
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

      // 快速回声消除
      if (payload.event === 'message_created' && payload.source_id && payload.source_id.startsWith('cz2128:')) {
        return new Response('Echo dropped', { status: 200 });
      }

      // Event fallback: combination of account + event type + payload id
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
      const { valid, payload } = await verifyTelegramWebhook(request, pathSegment, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET);

      if (!valid) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Telegram fallback
      const updateId = payload.update_id;
      if (!updateId) {
        return new Response('Malformed update', { status: 400 });
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
  }
};
