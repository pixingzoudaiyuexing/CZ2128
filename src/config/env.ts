import type { SupportEvent } from '../core/events';

export interface Env {
  hooks?: {
    beforeGenerationLeaseClaim?: (env: Env, convId: string) => Promise<void>;
    beforeAiRunSuccessPersist?: (env: Env, convId: string) => Promise<void>;
    beforeAiDispatchPreflight?: (env: Env, convId: string) => Promise<void>;
    beforeVisibleSend?: (
      env: Env,
      accountRef: string,
      conversationRef: string,
      content: string,
      operationId: string
    ) => Promise<{ id?: number | string; messageId?: number | string }>;
  };
  DB: D1Database;
  QUEUE: Queue<SupportEvent>;
  CHATWOOT_WEBHOOK_SECRET: string;
  CHATWOOT_API_TOKEN: string;
  CHATWOOT_API_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_SECRET_PATH: string;
  BOT_GROUP_ID: string;
  ATTACHMENTS_BUCKET: R2Bucket;
  ATTACHMENT_MAX_BYTES?: string;
  ATTACHMENT_MAX_COUNT_PER_MESSAGE?: string;
  ATTACHMENT_TTL_SECONDS?: string;
  ATTACHMENT_SOURCE_TIMEOUT_MS?: string;
  ATTACHMENT_DESTINATION_TIMEOUT_MS?: string;
  CHATWOOT_ATTACHMENT_ALLOWED_HOSTS?: string;
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
