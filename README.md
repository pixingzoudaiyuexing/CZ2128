# CZ2128

CZ2128 is a bridge connecting Chatwoot and Telegram using Cloudflare Workers.

## Setup
- `npm ci`
- `npx wrangler d1 migrations apply cz2128-db --local`
- `npm run typecheck`
- `npm run lint`
- `npm run test`

Before deployment, replace the local-only D1 database ID in `wrangler.toml` and create both `cz2128-queue` and its `cz2128-dlq` dead-letter queue.

## Environment Variables
- `CHATWOOT_WEBHOOK_SECRET`: Chatwoot webhook signature secret
- `TELEGRAM_WEBHOOK_SECRET`: Telegram secret token
- `TELEGRAM_SECRET_PATH`: Secret path segment for Telegram webhook
- `BOT_GROUP_ID`: Telegram group ID where topics are created
- `CHATWOOT_API_TOKEN` & `CHATWOOT_API_URL`: Chatwoot API credentials
- `TELEGRAM_BOT_TOKEN`: Telegram bot token

## Lifecycle
Listens to `conversation_status_changed` to sync Chatwoot's `open` and `resolved` states to Telegram `reopenForumTopic` and `closeForumTopic`.

## Webhook Identity
- Configure the Chatwoot webhook secret so Chatwoot sends the delivery, timestamp, and HMAC signature headers.
- Configure `TELEGRAM_SECRET_PATH` independently from `TELEGRAM_BOT_TOKEN`.
- Provider webhooks are authenticated and normalized before a versioned event is sent to Cloudflare Queues.
