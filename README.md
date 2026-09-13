# CZ2128

CZ2128 connects Chatwoot and Telegram using Cloudflare Workers and an optional OpenAI-compatible auto-responder.

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
