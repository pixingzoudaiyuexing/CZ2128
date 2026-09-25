# CZ2128 Architecture

Status: **APPROVED V1 BASELINE — independent review resolved by Primary**

## 1. Architectural Goal

CZ2128 is a support gateway, not a Chatwoot fork and not a Telegram bot with extra features.

The core must remain usable if the first helpdesk or operator channel is replaced later, without building speculative adapters before they are needed.

```text
Customer
  |
  v
Crisp Widget / Crisp
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

## 1A. Current Helpdesk Target

Owner decision for Crisp-01: Crisp is the only active helpdesk target. The
helpdesk adapter boundary remains provider-neutral, while the new implementation
is `CrispAdapter`. Chatwoot remains a historical adapter and data compatibility
surface only; its records, receipts, outbound operations, attachments and DLQ
history are not rewritten during the migration. A Crisp conversation is identified
by `(website_id, session_id)` and maps to exactly one CZ2128 conversation and one
Telegram forum topic.

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

### Staging AI test scope

The deployment-level `AI_TEST_SCOPE_ENABLED=true` gate restricts AI work to exact internal conversation UUIDs listed in `AI_TEST_ALLOWED_CONVERSATION_IDS`. The allowlist is a strict JSON array and is not part of the mutable Admin runtime control plane. A missing, empty, malformed, duplicate or non-canonical list fails closed. An absent switch or exact `false` preserves the established production semantics.

The scope gate is independent from `ai_mode` and provider configuration. It is checked before customer-trigger enqueue, auto-resume, generation/retry, the Provider boundary, durable-success recovery, DLQ redrive, Chatwoot visible delivery and Telegram mirror delivery. A denied fresh event creates no AI success or outbound evidence. Existing unstarted retry work converges to `FAILED_FINAL / AI_SCOPE_DENIED` without changing the conversation's handoff mode.

If scope tightens before Chatwoot delivery, generation output may remain as truthful durable Provider evidence but no customer-visible send is allowed. Once the deterministic Chatwoot operation is durably `SENT`, its evidence is never rewritten or hidden; the same event may complete provider-free domain repair and its deterministic Telegram mirror. This is finite convergence of an already-visible side effect, not authorization for a new generation or Chatwoot send.

## 7. AI Conversation Context

V1 uses bounded recent context from D1.

Recommended behavior:

- Persist customer, AI, Telegram-operator and Chatwoot-operator messages.
- Keep system/activity events separately or mark them so they are normally excluded from LLM context.
- Retrieve recent conversational messages for the same conversation.
- Enforce a configurable message/token budget.
- Include normalized customer metadata only when explicitly configured.
- System policy is separate from customer/business knowledge.
- Reviewed customer/business knowledge is stored in D1 and retrieved through a bounded FTS5 index.
- Retrieved knowledge is injected as a separate reference-only system context after the configured system policy; knowledge content is never treated as executable instructions.
- Retrieval failure degrades to the existing recent-conversation context rather than blocking human support or AI processing.
- Attachments enter context only through safe textual metadata unless a future multimodal feature explicitly handles them.
- Embedding/vector RAG remains deferred until corpus size or measured retrieval quality justifies a separate vector resource.

The AI-provider interface remains unchanged; retrieval is a context-building concern.

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

The secure proxy is implemented infrastructure for explicit temporary-download consumers rather than the default provider transport. Direct Telegram/Chatwoot binary bridging remains multipart. Crisp-05 Stage A uses proxy capabilities only where Crisp needs a customer-visible inline/download URL, and Stage B uses a forced-download capability only for an accepted customer upload surfaced to the original Telegram Topic.

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

Chatwoot lifecycle webhooks are reconciliation triggers, not ordering evidence. Delivery IDs,
Worker receive time, Queue order and the local conversation version do not establish provider
chronology. Before a close/reopen side effect, the consumer reads the current conversation status
from Chatwoot. Close and reopen share one per-conversation ordered operation sequence whose ID does
not contain the target state. D1 uniqueness therefore gives opposite intents one atomic slot; only
the winner may claim the outbound lease. An active or unresolved slot is handled before any return
based on the current D1 topic status. A successful Telegram operation is repaired into D1 through
the outbound domain resolver, then the consumer reads Chatwoot again and performs a bounded
compensating transition if the provider state changed during the request.

`PENDING`, expired pre-request `SENDING` and bounded 429 retry state may continue only through the
same operation ID. `AMBIGUOUS` and same-target `FAILED_FINAL` remain explicit manual reconciliation
boundaries and cannot be bypassed with a new ID. The sole final-state exception is a CAS-proven
`TOPIC_LIFECYCLE_SUPERSEDED_BEFORE_SEND`; zero attempts plus its audit permit a later authoritative
state reversal to allocate the next sequence. Managed lifecycle operations are not eligible for
generic manual retry. Pre-managed operations are coordinated conservatively: provably unstarted work
continues through its original ID when the authoritative target is unchanged, and is terminally
superseded with audit only when the target is opposite or managed mode already exists. Active/unknown
delivery blocks new effects, one delivered legacy operation may be repaired before managed mode
starts, and a legacy effect completing after managed mode is followed by a parent-linked managed
compensation. Once managed mode exists, legacy roots and children cannot mutate conversation state directly.

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
8. **V1 AI context uses recent D1 messages plus optional reviewed D1 FTS5 knowledge retrieval; embedding/vector RAG remains deferred.**

With these decisions frozen, Phase 1 implementation may begin.

## 17. Phase 3 Temporary Attachment Transport

Phase 3 introduced one reusable attachment core for Telegram and Chatwoot. Crisp-05 Stage A extends the same core to Crisp without a second storage or reliability subsystem:

- one source message maps to zero-to-ten durable attachment rows and one stable Queue job per row;
- source identity is `(source_provider, source_message_ref, source_attachment_ref)`;
- R2 object keys are anonymous `attachments/<attachment-id>` values and the bucket remains private;
- Telegram source downloads use `getFile`; Chatwoot source downloads retain their verified-locator/allowlisted-host policy; Crisp customer image sources must come from a verified Crisp webhook, use a safe raster MIME type and stay on exact HTTPS `storage.crisp.chat` across at most three manual redirects;
- source bodies are counted while streaming into bounded 5 MiB R2 multipart chunks, with a hard 20 MiB ceiling;
- binary Telegram/Chatwoot destination sends retain their existing behavior; Crisp destinations use the same durable `SEND_ATTACHMENT` ledger but expose a controlled short-lived R2 capability as text Markdown/download content rather than a native Crisp file upload;
- bearer download URLs use 32 random bytes, while D1 stores only SHA-256 of the raw token;
- `/attachments/:token[/download|/inline]` supports GET, HEAD and one byte range, always enforces D1 expiry, uses uniform 404 responses for invalid access, forces ordinary files to download, and permits repeated inline reads only for safe raster images while the capability is valid;
- stored data has a 24-hour business TTL, hourly logical cleanup is bounded to 100 rows, and a seven-day R2 lifecycle rule is the orphan safety net.
- Telegram Bot API token-bearing source URLs never leave the Worker. Crisp source URLs are not persisted as R2 metadata or outbound target evidence. Crisp numeric fingerprints and durable `SEND_ATTACHMENT` evidence suppress gateway echoes.
- If a Crisp attachment send becomes `AMBIGUOUS`, the operation is preserved and not resent. Its capability may remain readable until TTL because the provider may already have accepted the message; duplicate-risk manual retry is disabled because the plaintext capability token is deliberately non-durable.

Attachment-only customer messages do not create AI triggers. Captions remain ordinary text messages and are not duplicated in attachment delivery. Telegram operator attachments participate in the existing Telegram `update_id` state-order fence.

Crisp-05 Stage B extends this attachment core with an explicit temporary customer-upload capability rather than trusting Crisp ordinary-file webhook URLs or exposing a general public upload endpoint. Only a Telegram user already present in the bootstrap-only `ADMIN_TELEGRAM_USER_IDS` allowlist may run `/upload` or `/upload_revoke`, and only inside the existing mapped Crisp conversation Topic. The invite is bound in D1 to that Conversation, Crisp website/session, Telegram group/topic, Support Bot generation and creating Telegram update. A newer ordered command revokes older active invitations; stale delayed commands cannot replace or revoke newer state.

`UPLOAD_CAPABILITY_SECRET` is a bootstrap-only Cloudflare secret. Invite and per-file download capabilities are domain-separated HMAC values; D1 stores only their hashes. The invite expires after 15 minutes, is limited to three ordinary files and the configured attachment byte ceiling, and uses D1 item leases plus an atomic SQLite trigger to enforce aggregate file/byte counters under concurrency. The browser never supplies Conversation, Crisp Session or Telegram Topic identity. POST handling rechecks the persisted binding, current Support Bot generation, OPEN mapped Topic and authoritative Crisp conversation state before accepting bytes. Images and active-content file types are rejected from this ordinary-file path. Accepted files stream into the existing private R2 bucket and are surfaced only to the original Telegram Topic as forced-download `/attachments/:token/download` capabilities. `UPLOAD_INVITE` ambiguity is preserved and is not eligible for generic duplicate-risk manual retry.

**Acceptance boundary:** isolated-Staging evidence now proves a bounded Stage A provider transport slice and a Stage B 11,272-byte ordinary-file upload/download, invite TTL expiry and explicit revoke flow. Automated tests cover duplicate command/upload-id convergence, lease/CAS behavior and limit enforcement. This is not real-environment proof of the 20 MiB ceiling, large multipart behavior, every media/file type, proxy HEAD/Range, long-term cleanup/lifecycle, D1/R2 fault injection, high concurrency/load, full Admin reliability flows or Production. Stage A evidence also does not distinguish Crisp paste versus drag gestures or prove a human-observed Crisp Markdown render / Stage A forced-download click.

## 18. Phase 3.5 Runtime Configuration and Admin Control Plane

The existing Worker exposes a separate Telegram Admin Bot webhook. Its opaque path, webhook secret, bot token, positive-user-ID allowlist and `RUNTIME_CONFIG_MASTER_KEY` remain bootstrap settings and cannot be changed through runtime configuration. The Chatwoot webhook signing secret and Cloudflare bindings also remain bootstrap-only.

Each support HTTP request and Queue event loads one coherent D1 runtime configuration snapshot. Missing keys fall back to their existing env values only after D1 successfully returns the complete runtime-config set. A runtime-store read failure fails closed for all runtime-controlled provider identities and credentials; it never reactivates env credentials that may have been superseded. Once an encrypted override exists, decryption/authentication/validation failure likewise makes that setting unavailable. Provider failures remain isolated so a broken AI override does not stop the human bridge.

Plain values and AES-256-GCM encrypted secrets are stored in `runtime_config`. Secret encryption uses a fresh 12-byte nonce and AAD `cz2128:runtime-config:<key>`. `runtime_config_history` is append-only; rollback creates a new monotonically increasing version. Admin update receipts prevent repeated Telegram updates from applying mutations twice, and ten-minute encrypted sessions fence interactive confirmations.

The Support Telegram profile is one encrypted atomic value containing token, webhook secret and webhook path. Its monotonically increasing runtime version is also the Support Bot generation: Telegram Queue/event/message/outbound identity and conversation operator ordering are scoped by `(support_profile_version, update_id)`. Queue events from an older generation are dropped before side effects and future-generation events retry. Rotation validates the bot and current group, creates a new webhook identity, sets the new webhook with pending-update deletion, activates it through versioned D1 state, and only then best-effort removes the old webhook. Support-group migration validates the active bot against a forum supergroup and atomically changes `BOT_GROUP_ID` while clearing existing Telegram topic mappings. Neither side-effectful key is exposed through generic rollback.

## 19. Phase 4B-3 Reliability Control Plane

Phase 4B-3 is complete, merged and frozen. Reliability operations reuse the existing authenticated private Telegram Admin Bot; no Web Admin, public reliability API or new authentication system exists. Operation identity and action-specific confirmation state are held in expiring Admin sessions rather than callback payloads.

Manual reconciliation, mark-delivered, cancel and duplicate-risk manual retry invoke the frozen reliability services. The Admin layer performs read queries but does not directly write reliability transitions, domain repair or AI durable state. AI Reliability is read-only. `CONFIRMED_NOT_SENT`, DLQ handling and Durable Objects were outside Phase 4B-3. The migration set remains `0001` through `0005`.

## 20. Phase 4B-4A DLQ Capture and Inspection

The same Worker consumes `cz2128-queue` and `cz2128-dlq`, with routing determined only by Cloudflare's `batch.queue`. The main queue retains its frozen runtime configuration, normal handler, ACK and retry behavior. The DLQ path does not call `handleQueueEvent()`, resolve provider configuration, download R2 objects, enqueue messages or invoke Chatwoot, Telegram or AI adapters.

The raw DLQ body exists only in memory while a bounded V1 envelope is inspected. A valid logical receipt ID is SHA-256 over a versioned canonical tuple of queue name, event source and event ID; malformed messages use the Cloudflare message ID as the hashed fallback. D1 stores only finite metadata in the existing `0005` `dlq_receipts` table. Repeated deliveries use one atomic upsert: `first_seen_at` is immutable, `last_seen_at` advances and `delivery_count` increments once for each successful D1 capture.

For a matching `event_receipts` row, the DLQ upsert determines OPEN/RESOLVED from canonical state inside its D1 batch. Canonical event completion atomically adds the reverse metadata-only convergence from matching OPEN receipts to RESOLVED, so either commit order reaches the same monotonic result without changing provider, routing or Queue semantics.

If canonical D1 capture fails, the dedicated private `DLQ_QUARANTINE` R2 binding stores a deterministic versioned JSON object and matching custom metadata containing only hashed receipt identities, validated finite enums, bounded Queue attempts/timestamp, and fixed reason/state taxonomy. It never stores the raw body, source event reference, content, credentials, private URLs, provider responses or free-form exceptions. This is terminal fault evidence rather than canonical state. ACK occurs after D1 or quarantine durability succeeds; if both fail, the message retries. Persistent simultaneous D1, R2 and Queue-retry exhaustion remains a residual loss boundary.

The authenticated private Telegram Admin Bot exposes bounded D1 receipt and quarantine metadata views. Quarantine inspection reads validated R2 custom metadata and never object bodies. No delete, import, redrive, replay, resend or provider-visible action is part of Phase 4B-4A. Local service-level tests run two complete concurrent capture executions against one Wrangler/workerd D1 binding and test D1/R2 persistence; they do not establish production multi-region ordering, load behavior or availability during simultaneous platform failures. The Admin quarantine list reads one bounded R2 page, so above 1000 objects its displayed 10 entries are not guaranteed to be globally newest; this is LOW non-blocking observability debt for pre-production / Phase 4C. Phase 4B-4A is COMPLETE / FROZEN / MERGED, and the migration set remains `0001` through `0005`.

## 21. Phase 4B-4B Explicit Durable-State AI Recovery

Phase 4B-4B is not generic replay. Its only supported event is `internal / ai_trigger`, reconstructed with the exact original event ID from an OPEN `cz2128-dlq` receipt. Eligibility requires the canonical conversation, the matching durable Chatwoot inbound customer text, deterministic newest-message ordering by `created_at DESC, rowid DESC`, an existing matching `ai_runs` row, a reclaimable `event_receipts` row and no active generation owner. External messages, lifecycle events, `attachment_transfer` and quarantine evidence remain inspection-only.

Eligible AI states are due `FAILED_RETRYABLE` with `attempt_count < 3`, or `SUCCESS` with durable response text. The run handoff epoch must equal the current conversation epoch. Retry reclaim adds the same epoch equality to its D1 CAS, preventing an old run from being rebound if handoff advances after Admin validation or after the processing path's initial read. Recovery also rechecks the newest durable customer text at consumer entry, inside successful generation persistence and immediately before historical Chatwoot or Telegram dispatch. Old-epoch retryable work becomes `CANCELLED_BY_HANDOFF`; newer-message retryable work becomes `DISCARDED_STALE`; historical SUCCESS remains truthful and performs no stale delivery. Ordinary same-epoch retries, attempt accounting and durable SUCCESS reuse remain unchanged.

The normal fresh AI path prepares `ai_reply:<eventId>` plus immutable Chatwoot target evidence before the AI provider call. Historical recovery requires that operation to already exist; current Chatwoot configuration cannot authorize a missing historical operation. A provider-visible retry requires stored evidence to match the current target and an allowed state. `SENT` performs no provider action and can converge even after endpoint drift. Telegram mirrors are never created by historical recovery: a missing mirror is skipped after Chatwoot delivery, an existing matching mirror may continue, and target drift is terminated without sending. `SENDING`, `AMBIGUOUS`, `FAILED_FINAL`, exhausted/not-due retries, malformed evidence and identity conflicts retain their fail-closed behavior. DLQ recovery never resends ambiguity and remains separate from reconciliation and duplicate-risk Manual Retry.

Freshness and handoff termination also converge deterministic outbound state with distinct reasons. After structural historical-evidence and identity validation, `PENDING` operations with no request evidence and `FAILED_RETRYABLE` operations with durable observed-429 evidence may transition to `FAILED_FINAL / DISCARDED_STALE` or `FAILED_FINAL / CANCELLED_BY_HANDOFF`. No-send cleanup does not compare historical Chatwoot/Telegram target fields with a later current mapping and never mutates or substitutes the evidence. The CAS includes prior status, identity, evidence and no-active-lease predicates; each successful update is paired with a deterministic reason-specific audit in the same D1 batch. Concurrent convergence is idempotent. `SENT` and existing final history remain immutable. `SENDING`, `AMBIGUOUS`, evidence conflicts or lost CAS ownership abort event completion, keeping the canonical event failed and DLQ receipt OPEN. Generation retirement distinguishes human handoff from a newer valid generation owner, so a late Generation A cannot terminalize the shared operation still needed by Generation B.

`SENT` is accepted by abandoned convergence only with a bounded non-empty provider message reference. The same predicate is used for initial scans and CAS-lost reloads. A malformed SENT row remains untouched but blocks provider-free domain repair and DLQ resolution; internal AI message reconstruction is never treated as proof of external delivery. `FAILED_FINAL` remains a terminal non-delivery truth and is preserved without inventing a provider reference.

The existing private Telegram Admin Bot shows Redrive AI only when the core service reports eligibility. A separate expiring confirmation session revalidates before mutation. One deterministic `reliability_audit` row records operator intent for `(receipt ID, Admin update ID)` before `env.QUEUE.send()` sends the exact original event to the existing main Queue. The same update cannot send twice; distinct updates may enqueue identical physical copies. The receipt remains OPEN until canonical processing changes the event to PROCESSED and converges it to RESOLVED. No raw payload, provider lookup, migration `0006`, outbox, new Queue, Durable Object, KV correctness state, public API, Web Admin or new authentication system is introduced.

Status: **ACCEPTED / COMPLETE / FROZEN / MERGED**. Local SQLite and Wrangler/workerd D1 tests cover eligibility, intent concurrency, identical multi-command enqueue, duplicate processing, handoff races, consumer-time freshness and historical target-evidence drift. Production multi-region/load/outage evidence remains Phase 4C work.