# CZ2128 Architecture

Status: **DRAFT — pending independent Gemini review and final Primary decision**

## 1. Architectural Goal

CZ2128 is a support gateway, not a Chatwoot fork and not a Telegram bot with extra features.

The core must remain usable if the first helpdesk or operator channel is replaced later.

```text
Customer
  |
  v
Chatwoot Widget / Chatwoot
  |
  | signed webhook + REST API
  v
CZ2128 Support Gateway
  |
  +--> Telegram operator channel
  +--> OpenAI-compatible AI provider
  +--> D1 canonical state/history
  +--> Queues reliable async processing
  +--> R2 temporary attachments
  +--> optional external integrations later
```

## 2. Runtime Baseline

Recommended V1 stack:

- TypeScript
- Cloudflare Workers
- D1 as canonical relational state
- Cloudflare Queues for reliable asynchronous processing and retries
- R2 for temporary images/files
- KV only if a measured cache use-case appears; not required for V1 correctness
- Durable Objects deferred unless real concurrency tests prove D1 + idempotency insufficient

The HTTP Worker should stay thin: authenticate, validate, normalize, enqueue, acknowledge.

## 3. Core Boundaries

### Core domain

Core code works with normalized concepts:

- `Conversation`
- `Message`
- `Customer`
- `Operator`
- `Attachment`
- `AIState`
- `SupportEvent`

It must not require Chatwoot-specific field names.

### Helpdesk adapter

First implementation: `ChatwootAdapter`

Responsibilities:

- Verify/normalize Chatwoot webhook events
- Fetch conversation/contact metadata when needed
- Send outbound messages
- Upload/send attachments when appropriate
- Translate Chatwoot IDs into core provider references

### Operator channel

First implementation: `TelegramChannel`

Responsibilities:

- Verify Telegram webhook secret
- Map one support conversation to one forum topic
- Render customer metadata and state
- Forward operator text/images/files
- Provide `/ai_on` and `/ai_off` controls/buttons
- Apply notification/silent policy

### AI provider

First implementation: OpenAI-compatible Chat Completions adapter.

Responsibilities:

- Accept normalized context
- Apply configured system policy
- Return text output
- Never own conversation persistence or handoff state

### Attachment store

First implementation: R2.

Responsibilities:

- Private object storage
- Random opaque object keys
- Metadata in D1
- Expiring gateway download/image URLs
- Application-enforced expiration
- R2 lifecycle deletion as cleanup backstop

## 4. Request / Event Flow

### Chatwoot ingress

```text
POST /webhooks/chatwoot
  -> read raw body
  -> verify HMAC signature and timestamp
  -> derive stable provider delivery/event ID
  -> validate payload
  -> normalize SupportEvent
  -> enqueue
  -> return 2xx quickly
```

Chatwoot delivery IDs should be preferred for webhook idempotency when present.

### Telegram ingress

```text
POST /webhooks/telegram/<opaque-path>
  -> verify Telegram secret-token header
  -> validate chat/group
  -> use update_id as ingress idempotency key
  -> normalize SupportEvent
  -> enqueue
  -> return 2xx quickly
```

### Queue consumer

```text
Queue event
  -> create/check event receipt in D1
  -> load canonical conversation state
  -> apply state transition
  -> perform required outbound action(s)
  -> persist provider message IDs/results
  -> mark event complete
```

Retries must be safe because event receipts and outbound provider IDs prevent duplicate visible replies.

## 5. Canonical Data Model (Draft)

D1 is the system of record for gateway-owned state.

Suggested tables:

### `conversations`

- `id`
- `helpdesk_provider`
- `helpdesk_account_ref`
- `helpdesk_conversation_ref`
- `customer_ref`
- `operator_channel`
- `operator_thread_ref`
- `ai_mode`
- `ai_paused_by`
- `last_operator_reply_at`
- `created_at`
- `updated_at`
- `version`

Unique key: helpdesk provider/account/conversation reference.

### `messages`

- `id`
- `conversation_id`
- `provider`
- `provider_message_ref`
- `direction`
- `actor_role`
- `message_type`
- `text_content`
- `created_at`

Provider message reference should be unique where available.

### `event_receipts`

- `source`
- `source_event_ref`
- `status`
- `attempt_count`
- `last_error`
- `processed_at`

Unique key: `(source, source_event_ref)`.

### `attachments`

- `id`
- `conversation_id`
- `message_id`
- `r2_key`
- `original_name`
- `content_type`
- `size_bytes`
- `access_token_hash`
- `expires_at`
- `deleted_at`
- `created_at`

### `learning_candidates`

Deferred for later use, but reserve the domain concept rather than relying on append-only JSONL forever.

## 6. AI State Machine

V1 states are intentionally small:

```text
ENABLED
PAUSED_OPERATOR
PAUSED_MANUAL
```

Rules:

- New conversation: `ENABLED` only if an AI provider is configured; otherwise human-only.
- Telegram operator reply -> `PAUSED_OPERATOR`.
- Chatwoot human operator reply -> `PAUSED_OPERATOR`.
- Manual `/ai_off` -> `PAUSED_MANUAL`.
- Manual `/ai_on` -> `ENABLED`.
- `PAUSED_OPERATOR` may auto-resume only when a new customer message arrives after the configured timeout.
- `PAUSED_MANUAL` never auto-resumes.
- AI provider failure does not change the human handoff state and must not block forwarding the customer message to operators.

## 7. AI Conversation Context

V1 should use bounded recent context from D1.

Recommended behavior:

- Retrieve recent customer/operator/AI messages for the same conversation.
- Enforce a configurable message/token budget.
- Include normalized customer metadata only when explicitly configured.
- System policy is separate from customer/business knowledge.
- Do not build vector RAG in V1.

A later knowledge layer can add retrieval without changing the AI-provider interface.

## 8. Echo Prevention and Idempotency

Do not use message-text hashes as the primary echo guard.

Preferred strategy:

1. Use provider webhook delivery/update IDs for inbound-event idempotency.
2. Store outbound provider message IDs returned by Chatwoot/Telegram.
3. When an outbound message appears again through a provider webhook, correlate by provider message ID/source metadata and suppress re-forwarding.
4. Content hash may exist only as a short-lived fallback when a provider gives no stable ID.

This allows two legitimate identical messages such as `你好` to be treated as two different messages.

## 9. Reliable Delivery

Cloudflare Queues is part of the V1 reliability design, not an optional later patch.

Use it for:

- inbound normalized event processing
- provider API retries
- temporary upstream outages

Recommended policy:

- bounded retries with exponential/backoff behavior supported by the queue processing design
- dead-letter path/queue for repeatedly failing events
- never retry an action blindly unless idempotency can be proven

Large file bodies must not be placed in Queue messages. Queue payloads contain references/metadata only.

## 10. Temporary Attachments

### Inbound Telegram file flow

```text
Telegram document/photo
  -> obtain Bot API file URL
  -> stream/fetch file
  -> write to private R2 bucket
  -> create D1 attachment metadata + expiry
  -> produce opaque gateway URL
  -> send image/link through Chatwoot
```

V1 should explicitly respect Telegram Bot API download limits and reject unsupported oversized files with a clear operator message.

### Access URL

Example:

```text
GET /a/<opaque-token>
```

Gateway behavior:

- look up token hash
- verify `expires_at`
- optionally record access metadata later
- stream object from R2
- return 404/410 after expiry

R2 lifecycle rules physically remove expired objects later; they are not the only security boundary.

## 11. Security Baseline

Required before production:

- Verify Chatwoot webhook HMAC using raw body and timestamp.
- Enforce a replay window for signed Chatwoot webhook timestamps.
- Verify Telegram `X-Telegram-Bot-Api-Secret-Token`.
- Use an unguessable Telegram webhook path as defense in depth.
- Keep API keys/tokens only in Cloudflare Secrets.
- Keep R2 private.
- Use cryptographically random attachment access tokens; persist only hashes when practical.
- Validate MIME/type/size before accepting attachments.
- Enforce request-size and AI-input budgets.
- Structured logs must redact secrets, tokens, email addresses where appropriate, and signed/private URLs.
- Never log raw authorization headers.

## 12. Observability

Every processed event should have:

- `trace_id`
- source/provider
- provider event ID
- internal conversation ID
- state transition
- outbound provider result IDs
- retry count
- duration
- error category

Logs should be structured JSON where practical.

## 13. Testing Baseline

V1 is not accepted with syntax-check-only validation.

Automated tests must cover at minimum:

- Chatwoot webhook signature pass/fail/replay
- Telegram webhook secret pass/fail
- duplicate Chatwoot delivery suppression
- duplicate Telegram update suppression
- conversation/topic creation and reuse
- customer message -> Telegram
- Telegram reply -> Chatwoot
- Chatwoot human reply -> Telegram
- AI enabled/paused/manual-off state transitions
- operator timeout auto-resume
- AI provider failure fallback
- identical text messages are not incorrectly suppressed
- attachment upload/expiry/access
- queue retry does not duplicate visible messages

## 14. Proposed Source Layout

```text
src/
  index.ts
  core/
    domain.ts
    events.ts
    conversation-service.ts
    ai-state.ts
  adapters/
    chatwoot/
    telegram/
    ai/
    r2/
  storage/
    d1/
  queue/
  security/
  observability/
  config/
tests/
migrations/
```

Exact filenames may change during implementation, but dependency direction must remain: adapters depend on core contracts, not the reverse.

## 15. Deferred Decisions for Gemini Review

The independent reviewer should specifically challenge:

1. Whether Queues should be mandatory in V1 or introduced after a simpler synchronous MVP.
2. Whether D1 alone is sufficient for per-conversation state ordering, or whether Durable Objects should be used from day one.
3. Whether Hono should be used for HTTP routing/middleware or the Worker should stay framework-light.
4. Whether storing recent messages in D1 is enough for AI context at V1 scale.
5. Whether the proposed D1 schema is too broad or missing critical provider-correlation fields.
6. Whether R2 gateway URLs should stream through the Worker or redirect to short-lived signed R2 URLs.
7. Whether one-conversation-one-Telegram-topic remains the correct operator UX as volume grows.

No implementation should lock these decisions before the architecture review is resolved.