# CZ2128

CZ2128 is a bridge connecting Chatwoot and Telegram using Cloudflare Workers, featuring an AI auto-responder.

## Setup
- `npm install`
- `npx wrangler d1 migrations apply cz2128-db --local`
- `npm run test`

## Environment Variables
Core:
- `CHATWOOT_WEBHOOK_SECRET`: Chatwoot webhook signature secret
- `TELEGRAM_WEBHOOK_SECRET`: Telegram secret token
- `TELEGRAM_SECRET_PATH`: Secret path segment for Telegram webhook
- `BOT_GROUP_ID`: Telegram group ID where topics are created
- `CHATWOOT_API_TOKEN` & `CHATWOOT_API_URL`: Chatwoot API credentials
- `TELEGRAM_BOT_TOKEN`: Telegram bot token

AI Configuration (OpenAI-compatible):
- `AI_BASE_URL`: Complete base URL for completions, e.g., `https://api.openai.com/v1`
- `AI_API_KEY`: API Key
- `AI_MODEL`: Model name, e.g., `gpt-4o`
- `AI_SYSTEM_PROMPT`: Custom instructions
- `AI_CONTEXT_MAX_MESSAGES`: Max recent messages (default 20)
- `AI_CONTEXT_MAX_CHARS`: Max characters roughly (default 12000)

## AI Handoff Behavior
- AI is enabled by default.
- If an operator replies in Telegram or Chatwoot, AI pauses automatically (`PAUSED_OPERATOR`).
- Operators can send `/ai_off` in Telegram to pause manually (`PAUSED_MANUAL`).
- Operators can send `/ai_on` in Telegram to resume (`ENABLED`).
- Auto-resume occurs if `AI_OPERATOR_PAUSE_TIMEOUT_SECONDS` (default 3600s) elapses since the last operator reply and a new customer message arrives. `PAUSED_MANUAL` never auto-resumes.
- If AI API is misconfigured or fails, the system safely falls back to Human-Only mode without breaking the Chatwoot <-> Telegram bridge.
