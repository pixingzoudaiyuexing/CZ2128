import type { SupportEvent } from '../core/events';

export interface Env {
  hooks?: {
    beforeGenerationLeaseClaim?: (env: Env, convId: string) => Promise<void>;
    beforeAiLeaseAcquire?: (env: Env, convId: string) => Promise<void>;
    beforeAiContextBuild?: (env: Env, convId: string) => Promise<void>;
    beforeAiRunSuccessPersist?: (env: Env, convId: string) => Promise<void>;
    beforeAiDispatchPreflight?: (env: Env, convId: string) => Promise<void>;
    beforeAiTelegramDispatchPreflight?: (env: Env, convId: string) => Promise<void>;
    beforeStaleOutboundConvergence?: (env: Env, eventId: string) => Promise<void>;
    afterChatwootLifecycleSnapshot?: (
      env: Env,
      eventId: string,
      targetStatus: 'OPEN' | 'CLOSED',
      latestOperationId: string | null
    ) => Promise<void>;
    beforeAbandonedOutboundConvergence?: (
      env: Env,
      eventId: string,
      reason: 'DISCARDED_STALE' | 'CANCELLED_BY_HANDOFF'
    ) => Promise<void>;
    beforeVisibleSend?: (
      env: Env,
      accountRef: string,
      conversationRef: string,
      content: string,
      operationId: string,
      lifecycle?: import('../core/outbound-operations').OutboundAttemptLifecycle
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
  DLQ_QUARANTINE: R2Bucket;
  EXPECTED_MAIN_QUEUE_NAME?: string;
  EXPECTED_DLQ_QUEUE_NAME?: string;
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
  RUNTIME_CONFIG_MASTER_KEY?: string;
  ADMIN_TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_SECRET_PATH?: string;
  ADMIN_TELEGRAM_USER_IDS?: string;
  runtimeConfigSnapshot?: import('../runtime-config/types').RuntimeConfigSnapshot;
}
