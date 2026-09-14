# CZ2128 Architecture

Status: **APPROVED V1 BASELINE — independent review resolved by Primary**

## 1. Architectural Goal

CZ2128 is a support gateway, not a Chatwoot fork and not a Telegram bot with extra features.

The core must remain usable if the first helpdesk or operator channel is replaced later, without building speculative adapters before they are needed.

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

Approved V1 stack:

- TypeScript
- Cloudflare Workers
- D1 as canonical relational state
- Cloudflare Queues for reliable asynchronous processing and retries
- R2 for temporary images/files
- No KV dependency for V1 correctness
- Durable Objects deferred; they are available on Workers Free, but V1 does not yet justify the extra coordination layer

The HTTP Worker stays thin: authenticate, validate, normalize, enqueue, acknowledge.

The Queue consumer owns state transitions and provider side effects.

## 3. Core Boundaries

### Core domain

Core code works with normalized concepts:

- `Conversation`
- `Message`
- `Customer`
- `Operator`
- `Attachment`
- `AIMode`
- `SupportEvent`
- `OutboundOperation`

It must not require Chatwoot-specific field names.

Do not create unused abstractions for hypothetical future adapters. Extract only the contracts needed by the first real Chatwoot, Telegram, AI and R2 implementations.

### Helpdesk adapter

First implementation: `ChatwootAdapter`

Responsibilities:

- Verify/normalize Chatwoot webhook events
- Fetch conversation/contact metadata when needed
- Send outbound messages
- Upload/send attachments when appropriate
- Translate Chatwoot IDs into core provider references
- Stamp CZ2128-originated Chatwoot messages with a stable `source_id` marker when the API path supports it

### Operator channel

First implementation: `TelegramChannel`

Responsibilities:

- Verify Telegram webhook secret
- Map one Chatwoot conversation to one Telegram forum topic
- Render customer metadata and state
- Forward operator text/images/files
- Provide `/ai_on` and `/ai_off` controls/buttons
- Apply notification/silent policy
- Close/reopen the Telegram topic when the mapped Chatwoot conversation resolves/reopens

V1 deliberately keeps **one conversation = one topic**. This gives deterministic reply routing and preserves clear conversation boundaries. If topic volume becomes an observed UX problem, contact-level grouping can be reconsidered later with explicit multi-conversation reply semantics.

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
  -> verify HMAC signature + timestamp replay window
  -> read X-Chatwoot-Delivery when available
  -> validate payload
  -> fast-drop known CZ2128 echo using source_id marker when present
  -> normalize SupportEvent
  -> enqueue with stable event key
  -> return 2xx quickly
```

Inbound event identity priority:

1. Chatwoot `X-Chatwoot-Delivery` when present
2. stable Chatwoot message/event identifier from the payload
3. explicitly documented fallback only when no provider identifier exists

### Telegram ingress

```text
POST /webhooks/telegram/<opaque-path>
  -> verify Telegram X-Telegram-Bot-Api-Secret-Token
  -> validate chat/group
  -> reject bot-originated updates
  -> use update_id as ingress idempotency key
  -> normalize SupportEvent
  -> enqueue
  -> return 2xx quickly
```

### Queue consumer

Cloudflare Queues is at-least-once. Every consumer path must therefore be safe under duplicate delivery.

```text
Queue event
  -> claim/check event receipt in D1
  -> load canonical conversation state
  -> apply guarded state transition
  -> create/claim outbound operation(s)
  -> perform provider action(s)
  -> persist provider message IDs/results
  -> mark event complete
```

A Queue retry must never blindly repeat a visible provider action.

## 5. Canonical Data Model

D1 is the system of record for gateway-owned state.

### `conversations`

Minimum fields:

- `id`
- `helpdesk_provider`
- `helpdesk_account_ref`
- `helpdesk_conversation_ref`
- `customer_ref`
- `operator_channel`
- `operator_thread_ref`
- `ai_mode`
- `last_operator_reply_at`
- `ai_generation_id` nullable
- `ai_generation_started_at` nullable
- `ai_generation_message_id` nullable
- `created_at`
- `updated_at`
- `version`

Unique key: helpdesk provider/account/conversation reference.

`ai_mode` is the human handoff mode. Generation-in-progress is represented separately by the generation lease fields; do not overload the human handoff state with a `GENERATING` mode.

### `messages`

Minimum fields:

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

Minimum fields:

- `source`
- `source_event_ref`
- `status`
- `attempt_count`
- `last_error`
- `processed_at`

Unique key: `(source, source_event_ref)`.

### `outbound_operations`

Required for retry safety and auditing provider side effects.

Minimum fields:

- `id` / deterministic operation key
- `conversation_id`
- `destination_provider`
- `operation_type`
- `status` (`PENDING`, `SENDING`, `SENT`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `AMBIGUOUS`)
- `provider_message_ref` nullable
- `attempt_count`
- `lease_until` nullable
- `last_error` nullable
- `created_at`
- `updated_at`

Unique operation IDs must be stable across Queue retries.

### `attachments`

Minimum fields:

- `id`
- `conversation_id`
- `message_id` nullable
- `r2_key`
- `original_name`
- `content_type`
- `size_bytes`
- `access_token_hash`
- `expires_at`
- `deleted_at`
- `created_at`

### Deferred

`learning_candidates` is a later domain concept. Do not create its table in V1 until the learning workflow starts.

## 6. AI Handoff and Generation Concurrency

### Human handoff mode

V1 modes remain intentionally small:

```text
ENABLED
PAUSED_OPERATOR
PAUSED_MANUAL
```

Rules:

- New conversation: `ENABLED` only if an AI provider is configured; otherwise human-only behavior.
- Telegram operator reply -> `PAUSED_OPERATOR`.
- Chatwoot human operator reply -> `PAUSED_OPERATOR`.
- Manual `/ai_off` -> `PAUSED_MANUAL`.
- Manual `/ai_on` -> `ENABLED`.
- `PAUSED_OPERATOR` may auto-resume only when a new customer message arrives after the configured timeout.
- `PAUSED_MANUAL` never auto-resumes.
- AI provider failure does not block Chatwoot↔Telegram human support.

### Generation lease

AI generation has a separate transient lock/lease:

```text
ai_generation_id
ai_generation_started_at
ai_generation_message_id
```

Before an AI call, use a guarded D1 update that succeeds only when:

- `ai_mode = ENABLED`
- no unexpired generation lease exists
- expected conversation `version` / expected fields still match

The operation gets a unique `generation_id`.

After the LLM returns, **re-check before sending**:

- `ai_mode` is still `ENABLED`
- `ai_generation_id` still equals this generation

If a human operator replied while the LLM was running, the operator transition wins. The generated answer is discarded and must not be sent.

On provider failure, clear/release the generation lease and record the error. Do not permanently change the human handoff mode after a single AI failure. Retry/backoff policy may escalate repeated failures to operator notification without breaking the human path.

If another customer event encounters an active generation lease, it must not be silently discarded. V1 processing should retry/defer that AI trigger or detect that newer customer messages arrived and schedule a subsequent generation after the lease clears.

## 7. AI Conversation Context

V1 uses bounded recent context from D1.

Recommended behavior:

- Persist customer, AI, Telegram-operator and Chatwoot-operator messages.
- Keep system/activity events separately or mark them so they are normally excluded from LLM context.
- Retrieve recent conversational messages for the same conversation.
- Enforce a configurable message/token budget.
- Include normalized customer metadata only when explicitly configured.
- System policy is separate from customer/business knowledge.
- Attachments enter context only through safe textual metadata unless a future multimodal feature explicitly handles them.
- Do not build vector RAG in V1.

A later knowledge layer can add retrieval without changing the AI-provider interface.

## 8. Echo Prevention and Idempotency

Do not use message-text hashes as the primary echo guard.

### Inbound idempotency

- Chatwoot: prefer `X-Chatwoot-Delivery`; fall back to stable message/event ID.
- Telegram: use `update_id`; message IDs remain provider-message correlation IDs.
- D1 unique constraints on event/message identities are authoritative duplicate guards.

### Chatwoot outbound echo

When CZ2128 posts a Chatwoot message, set a stable marker such as:

```text
source_id = cz2128:<outbound_operation_id>
```

where supported by the Chatwoot message API.

Chatwoot webhook ingress may fast-drop messages carrying this trusted prefix after webhook signature validation.

The `source_id` marker is a fast echo guard, not a replacement for D1 correlation. Persist the returned Chatwoot message ID and outbound operation result.

### Telegram outbound echo

Ignore Telegram updates originating from the bot itself. Persist Telegram message IDs returned by Bot API calls for correlation/audit.

### Queue retry / outbound effects

Cloudflare Queues may deliver the same message more than once. Stable `outbound_operation_id` values and D1 unique constraints prevent normal duplicate execution.

There is an unavoidable ambiguity window for third-party APIs that do not provide transactional idempotency: a provider may accept a request immediately before the Worker loses the response. V1 should explicitly model `SENDING` leases and uncertain failures instead of claiming mathematical exactly-once delivery. Prefer a delayed retry/reconciliation path over immediate blind resend when delivery outcome is unknown.

## 9. Reliable Delivery

Cloudflare Queues is mandatory in V1.

Use it for:

- inbound normalized event processing
- slow AI/provider work outside webhook acknowledgement
- retryable upstream failures

Recommended policy:

- stable event IDs in every queued event
- bounded retry policy with backoff
- dead-letter queue/path for repeatedly failing events
- `event_receipts` for inbound processing identity
- `outbound_operations` for provider side-effect identity
- never place file bodies in Queue messages; pass provider/R2 references and metadata only

## 10. Temporary Attachments

### Canonical provider flow

```text
Telegram source
  -> trusted getFile downloader
  -> private R2
  -> direct Chatwoot multipart attachments[]

Chatwoot source
  -> verified-webhook, exact-allowlist downloader
  -> private R2
  -> direct Telegram multipart Bot API
```

The hosted Telegram Bot API currently limits `getFile` downloads to 20 MB. V1 enforces that limit. Both provider paths use direct multipart delivery; neither sends a proxy URL to Telegram or Chatwoot.

### Secure proxy

Implemented routes:

```text
GET  /attachments/:token
HEAD /attachments/:token
```

Gateway behavior:

- store only SHA-256 of the 256-bit opaque token
- look up attachment metadata
- verify `expires_at`
- serve only the bound R2 object; never proxy an arbitrary database/user URL
- preserve safe filename/content headers
- support one byte range through the R2 native range read
- return a uniform 404 for malformed, unknown, expired and missing-object access

R2 lifecycle rules physically remove expired objects later; they are cleanup, not authorization.

The secure proxy is implemented infrastructure for explicit temporary-download consumers. It is not the primary provider transport, and the current Telegram/Chatwoot channel flow does not surface proxy URLs.

## 11. Telegram Topic Lifecycle

V1 mapping remains:

```text
1 Chatwoot conversation = 1 Telegram forum topic
```

Reasons:

- deterministic Telegram reply -> Chatwoot conversation routing
- no ambiguity if a customer has multiple concurrent conversations/inboxes
- clear audit/history boundary

Lifecycle:

- create the topic on first bridged message for that Chatwoot conversation
- include customer display name plus stable conversation reference in the topic title/header
- on Chatwoot `resolved`, close the Telegram topic
- on Chatwoot reopen/open, reopen the Telegram topic
- do not delete topics automatically in V1

If real production volume proves topic clutter unacceptable, revisit one-customer-one-topic only with an explicit design for concurrent active conversations and reply targeting.

## 12. Security Baseline

Required before production:

- Verify Chatwoot `X-Chatwoot-Signature` against the raw body using the configured webhook secret.
- Enforce a bounded replay window using `X-Chatwoot-Timestamp`.
- Use `X-Chatwoot-Delivery` as an idempotency signal when present.
- Verify Telegram `X-Telegram-Bot-Api-Secret-Token`.
- Use an unguessable Telegram webhook path as defense in depth.
- Keep API keys/tokens only in Cloudflare Secrets.
- Keep R2 private.
- Use cryptographically random attachment access tokens; persist hashes rather than raw tokens where practical.
- Validate attachment size and safe content-disposition behavior; do not trust MIME alone for security-sensitive handling.
- Never use arbitrary user-controlled URLs as server-side fetch targets without a strict allowlist/source contract.
- Escape/normalize content when converting between Telegram HTML/Markdown and Chatwoot rich text.
- Enforce request-size and AI-input budgets.
- Treat customer text as untrusted data; it cannot override system/tool security policy.
- Structured logs must redact secrets, tokens, email addresses where appropriate, and signed/private URLs.
- Never log raw authorization headers or secret webhook headers.
- Do not leak raw upstream error bodies to customers.

## 13. Observability

Every processed event should have:

- `trace_id`
- source/provider
- provider event ID
- internal conversation ID
- state transition
- outbound operation ID(s)
- outbound provider result IDs
- retry count
- duration
- error category

Logs should be structured JSON where practical.

## 14. Testing Baseline

V1 is not accepted with syntax-check-only validation.

Automated tests must cover at minimum:

- Chatwoot webhook signature pass/fail/replay
- Telegram webhook secret pass/fail
- duplicate Chatwoot delivery suppression
- duplicate Telegram update suppression
- Chatwoot CZ2128 `source_id` echo suppression
- conversation/topic creation and reuse
- topic close/reopen on Chatwoot lifecycle
- customer message -> Telegram
- Telegram reply -> Chatwoot
- Chatwoot human reply -> Telegram
- AI enabled/paused/manual-off state transitions
- operator timeout auto-resume
- AI generation lease acquisition/contention/release
- operator reply while AI is generating discards the stale AI result
- rapid customer messages are not lost or double-answered
- AI provider failure releases the lease and preserves human support
- identical text messages are not incorrectly suppressed
- outbound Queue retry does not normally duplicate visible messages
- ambiguous provider timeout enters a safe retry/reconciliation path
- attachment upload/expiry/access and oversized Telegram file rejection

## 15. Proposed Source Layout

```text
src/
  index.ts
  core/
    domain.ts
    events.ts
    conversation-service.ts
    ai-state.ts
    outbound-operations.ts
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

## 16. Final Architecture Decisions After Independent Review

Resolved:

1. **Queues remain mandatory in V1.** Their at-least-once semantics are handled explicitly through D1 receipts/operations.
2. **D1 is the canonical gateway database.** Guarded atomic updates/version checks arbitrate V1 state changes.
3. **Durable Objects are deferred.** They are available on Workers Free, but are not justified until real ordering/concurrency evidence requires per-conversation serialization.
4. **AI generation uses a separate lease**, not a fourth human handoff mode.
5. **One conversation remains one Telegram topic** in V1, with close/reopen lifecycle management.
6. **Chatwoot outbound messages use stable source correlation (`source_id`) where supported**, plus D1 operation/message records.
7. **R2 gateway proxy URLs remain the V1 attachment delivery model.**
8. **Recent D1 messages are sufficient for V1 AI context; RAG is deferred.**

With these decisions frozen, Phase 1 implementation may begin.

## 17. Phase 3 Temporary Attachment Transport

Phase 3 implements one reusable attachment core for Telegram and Chatwoot sources:

- one source message maps to zero-to-ten durable attachment rows and one stable Queue job per row;
- source identity is `(source_provider, source_message_ref, source_attachment_ref)`;
- R2 object keys are anonymous `attachments/<attachment-id>` values and the bucket remains private;
- Telegram source downloads use `getFile`; Chatwoot source downloads accept only verified webhook locators, exact HTTPS hosts, manual redirects and stripped credentials after an origin change;
- source bodies are counted while streaming into bounded 5 MiB R2 multipart chunks, with a hard 20 MiB ceiling;
- destination multipart sends process one attachment at a time with a bounded 20 MiB single-file buffer and use the existing outbound operation ledger;
- bearer download URLs use 32 random bytes, while D1 stores only SHA-256 of the raw token;
- `/attachments/:token` supports GET, HEAD and one byte range, returns private no-store downloads, and uses uniform 404 responses for invalid access;
- stored data has a 24-hour business TTL, hourly logical cleanup is bounded to 100 rows, and a seven-day R2 lifecycle rule is the orphan safety net.

Attachment-only customer messages do not create AI triggers. Captions remain ordinary text messages and are not duplicated in attachment delivery. Telegram operator attachments participate in the existing Telegram `update_id` state-order fence.

## 18. Phase 3.5 Runtime Configuration and Admin Control Plane

The existing Worker exposes a separate Telegram Admin Bot webhook. Its opaque path, webhook secret, bot token, positive-user-ID allowlist and `RUNTIME_CONFIG_MASTER_KEY` remain bootstrap settings and cannot be changed through runtime configuration. The Chatwoot webhook signing secret and Cloudflare bindings also remain bootstrap-only.

Each support HTTP request and Queue event loads one coherent D1 runtime configuration snapshot. Missing keys fall back to their existing env values. Once an encrypted override exists, decryption/authentication/validation failure makes that setting unavailable rather than reactivating a superseded env credential. Provider failures remain isolated so a broken AI override does not stop the human bridge.

Plain values and AES-256-GCM encrypted secrets are stored in `runtime_config`. Secret encryption uses a fresh 12-byte nonce and AAD `cz2128:runtime-config:<key>`. `runtime_config_history` is append-only; rollback creates a new monotonically increasing version. Admin update receipts prevent repeated Telegram updates from applying mutations twice, and ten-minute encrypted sessions fence interactive confirmations.

The Support Telegram profile is one encrypted atomic value containing token, webhook secret and webhook path. Rotation validates the bot and current group, creates a new webhook identity, sets the new webhook, activates it through versioned D1 state, and only then best-effort removes the old webhook. Support-group migration validates the active bot against a forum supergroup and atomically changes `BOT_GROUP_ID` while clearing existing Telegram topic mappings. Neither side-effectful key is exposed through generic rollback.
