# CZ2128

CZ2128 connects Chatwoot and Telegram using Cloudflare Workers and an optional OpenAI-compatible auto-responder.

Phases 1-3.5 are complete and merged. Phase 4A, Phase 4B-2B and Phase 4B-2C are complete and frozen; Phase 4B-1 and Phase 4B-2A are complete. Phase 4B-2C-3 and Phase 4B-3 are complete, frozen and merged. Phase 4B-4A is implemented and in review; Phase 4B-4 overall is in progress. Phase 4B-4B, 4B-5, and 4C remain NOT STARTED. Code completion is not production validation: real R2 staging remains incomplete, and the Admin Bot, Support Bot rotation, Telegram group migration, Telegram/Chatwoot providers and Queue/D1 concurrency remain untested in staging.

## Durable AI Reliability
- One AI trigger has at most three `generateChatCompletion()` invocations. The durable attempt count advances only immediately before the provider boundary.
- Retryable failures use `FAILED_RETRYABLE` and a persisted `next_retry_at`; the third retryable failure becomes terminal `RETRY_EXHAUSTED`. Provider 4xx and invalid local context become `FAILED_FINAL`.
- Human handoff wins. Generation-owned CAS prevents a late old generation from overwriting a reclaimed run or reviving AI after handoff.
- New runtime code never writes legacy `FAILED`. The schema still accepts it for rolling deployment and new Workers lazily normalize old rows.
- Durable `SUCCESS` text is reused for outbound continuation and explicit `AI_RUN` manual retry. Effective Chatwoot delivery repairs one AI context message; Telegram mirror delivery does not create a duplicate context entry.
- The migration set remains `0001` through `0005`; there is no `0006`.

## Manual Retry and Domain Resolution
- Internal manual retry supports ambiguous `MESSAGE`, `ATTACHMENT` and Telegram topic lifecycle operations after an operator explicitly accepts duplicate risk.
- The original operation remains `AMBIGUOUS`; one deterministic child records the new provider-visible side-effect identity and uses the existing outbound lease/attempt lifecycle.
- Message content is reconstructed from durable `messages`, attachment bytes from unexpired private R2 state, and topic creation from a durable canonical title. Payload content is not copied into target evidence or reliability audit.
- Target drift blocks child creation. Chatwoot children use a new child-scoped `source_id`; Telegram group, thread, method and runtime generation must remain compatible.
- Effective delivery repairs attachment/topic domain state through idempotent D1 CAS without another provider action.
- Telegram topic repair additionally requires the operation's persisted group identity to match the current effective `BOT_GROUP_ID`, preventing old-group topic references from returning after support-group migration.
- The private Telegram Admin Bot exposes confirmed manual reconciliation, mark-delivered, cancel and manual-retry operations through the frozen core services. It also provides read-only sanitized DLQ inspection; redrive remains a later phase.

## Reliability Control Plane
- Phase 4B-3 is complete, merged and frozen.
- The existing private Telegram Admin Bot and authorization/session/idempotency boundaries are reused; there is no Web Admin, public reliability API or new authentication system.
- Reliability summary, uncertain operations, operation details, audit and AI Reliability are bounded administrative reads. AI Reliability is read-only.
- Manual reconciliation, mark-delivered, cancel and duplicate-risk manual retry are active. Operation identity and CREATE_TOPIC provider references remain in expiring Admin session state rather than callback payloads.
- `CONFIRMED_NOT_SENT` is inactive. DLQ redrive, Durable Objects and migration `0006` are absent.

## DLQ Capture and Inspection
- `cz2128-queue` and `cz2128-dlq` are consumed by the same Worker and separated only through `batch.queue`; normal queue handling remains unchanged.
- The DLQ path uses only D1 and Cloudflare message metadata. It never invokes normal event processing, provider adapters, R2 downloads or Queue sends.
- Raw bodies, message/AI content, private URLs, attachment credentials, provider bodies and free-form exceptions are never persisted or displayed.
- One deterministic sanitized receipt is atomically upserted through the existing `0005` schema. The raw Cloudflare message is ACKed only after durable persistence succeeds.
- The authenticated private Telegram Admin Bot provides bounded read-only DLQ summary, latest-ten list and detail views. Redrive is deferred to Phase 4B-4B and no redrive button or action exists.

## Setup
- `npm ci`
- `npx wrangler d1 migrations apply cz2128-db --local`
- `npm run typecheck`
- `npm run lint`
- `npm run test`

Before deployment, replace the local-only D1 database ID in `wrangler.toml` and create both `cz2128-queue` and its `cz2128-dlq` dead-letter queue.

## Environment Variables
Core:
- `CHATWOOT_WEBHOOK_SECRET`: Chatwoot webhook signature secret
- `TELEGRAM_WEBHOOK_SECRET`: Telegram secret token
- `TELEGRAM_SECRET_PATH`: Secret path segment for Telegram webhook
- `BOT_GROUP_ID`: Telegram group ID where topics are created
- `CHATWOOT_API_TOKEN` and `CHATWOOT_API_URL`: Chatwoot API credentials
- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `CHATWOOT_ATTACHMENT_ALLOWED_HOSTS`: comma-separated exact HTTPS storage/CDN hosts permitted for Chatwoot attachment redirects

Optional attachment limits:
- `ATTACHMENT_MAX_BYTES`: maximum bytes per attachment, capped at 20 MiB
- `ATTACHMENT_MAX_COUNT_PER_MESSAGE`: maximum attachments processed per provider message, capped at 10
- `ATTACHMENT_TTL_SECONDS`: business retention, capped at 86400 seconds
- `ATTACHMENT_SOURCE_TIMEOUT_MS`: source download timeout, default 30000
- `ATTACHMENT_DESTINATION_TIMEOUT_MS`: destination upload timeout, default 30000

Optional AI configuration:
- `AI_BASE_URL`: OpenAI-compatible API base URL, for example `https://api.openai.com/v1`
- `AI_API_KEY`: API key
- `AI_MODEL`: model name
- `AI_SYSTEM_PROMPT`: system instructions
- `AI_REQUEST_TIMEOUT_MS`: request timeout, bounded by runtime validation
- `AI_CONTEXT_MAX_MESSAGES`: recent message limit, default 20
- `AI_CONTEXT_MAX_CHARS`: context character limit, default 12000
- `AI_GENERATION_LEASE_SECONDS`: generation lease duration
- `AI_OPERATOR_PAUSE_TIMEOUT_SECONDS`: operator pause timeout, default 3600

Bootstrap-only runtime control plane:
- `RUNTIME_CONFIG_MASTER_KEY`: exactly 32 random bytes encoded as unpadded base64url
- `ADMIN_TELEGRAM_BOT_TOKEN`: dedicated Admin Bot token; never reuse the Support Bot
- `ADMIN_TELEGRAM_WEBHOOK_SECRET`: Admin Bot webhook secret token
- `ADMIN_TELEGRAM_SECRET_PATH`: independent opaque Admin webhook path
- `ADMIN_TELEGRAM_USER_IDS`: comma-separated exact positive Telegram user IDs

Generate independent base64url values locally, then configure them as Cloudflare secrets rather than committing them:

```bash
openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_'
npx wrangler secret put RUNTIME_CONFIG_MASTER_KEY
npx wrangler secret put ADMIN_TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TELEGRAM_SECRET_PATH
npx wrangler secret put ADMIN_TELEGRAM_USER_IDS
```

The Admin Bot webhook is `/webhooks/admin-telegram/<ADMIN_TELEGRAM_SECRET_PATH>`. It also requires `X-Telegram-Bot-Api-Secret-Token`, a private chat and an allowlisted numeric user ID. Bootstrap fields, Chatwoot webhook signing and Cloudflare bindings cannot be modified through the bot.

Runtime overrides cover AI provider/settings, the atomic Support Telegram profile, support-group migration, Chatwoot API settings and attachment limits. Missing keys fall back to env. Existing encrypted overrides fail closed if they cannot authenticate or decrypt. Support Bot rotation and group migration are confirmed workflows; generic rollback is intentionally unavailable for those side-effectful keys.

## Webhook Identity
- Configure the Chatwoot webhook secret so Chatwoot sends delivery, timestamp and HMAC signature headers.
- Configure `TELEGRAM_SECRET_PATH` independently from `TELEGRAM_BOT_TOKEN`.
- Provider webhooks are authenticated and normalized before a versioned event is sent to Cloudflare Queues.

## Conversation Behavior
- One Chatwoot conversation maps to one Telegram forum topic.
- Chatwoot `resolved` closes the topic; `open` reopens it.
- A Telegram or Chatwoot human reply pauses AI as `PAUSED_OPERATOR`.
- Telegram `/ai_off` sets `PAUSED_MANUAL`; `/ai_on` enables AI for future customer messages.
- `PAUSED_OPERATOR` can auto-resume only when a new customer event arrives after the configured timeout.
- Missing AI configuration does not stop the human Chatwoot/Telegram bridge.
- AI context represents customer text as `user`, generated answers as `assistant`, and human operator replies as labeled `system` messages.

## Temporary Attachments
- `ATTACHMENTS_BUCKET` is a private R2 binding for `cz2128-attachments`.
- Source downloads are limited to 20 MiB and stream into bounded R2 multipart chunks.
- Telegram and Chatwoot destinations receive multipart uploads, one attachment at a time.
- `GET` and `HEAD /attachments/:token` use a 256-bit opaque bearer token; D1 stores only its SHA-256 hash.
- The proxy supports one `Range` request and returns `Cache-Control: private, no-store` plus `X-Content-Type-Options: nosniff`.
- Hourly scheduled cleanup removes expired R2 objects and then deletes their D1 rows in batches of 100.

Deployment prerequisites:

```bash
npx wrangler r2 bucket create cz2128-attachments
npx wrangler r2 bucket lifecycle add cz2128-attachments attachment-retention attachments/ --expire-days 7 --abort-multipart-days 7
```

Review the bucket and lifecycle configuration before running these commands. Phase 3 development does not create or modify production Cloudflare resources. Real R2, Telegram and Chatwoot attachment flows require staging validation before production use.

Pre-production attachment validation must cover real R2 write/multipart/read/Range/delete; Telegram `getFile` and every configured multipart send method; Chatwoot download redirects and `attachments[]`; proxy GET/HEAD/Range/headers; hourly cleanup; Queue/D1 concurrency; and peak memory under a 20 MiB `ArrayBuffer` -> `Blob` -> `FormData` upload. The seven-day R2 lifecycle must be applied and verified. DNS rebinding through an explicitly trusted allowlisted hostname and extreme R2 I/O stalls beyond the event lease remain residual risks to validate operationally.
