import type { SupportEvent } from '../core/events';

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
}
