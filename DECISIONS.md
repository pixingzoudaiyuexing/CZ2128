# CZ2128 Decisions

Status: **APPROVED V1 DECISIONS**

## D-001 — Keep upstream helpdesk unmodified

**Decision:** Do not fork or modify Chatwoot for V1. Integrate through supported Webhooks/API/Widget capabilities.

**Reason:** Reduces upgrade friction and keeps CZ2128 independent from one helpdesk implementation.

## D-002 — Make D1 the canonical gateway database

**Decision:** D1 stores gateway-owned conversation mapping, provider message references, event receipts, AI handoff state, AI generation lease fields, attachment metadata, outbound operation state, and recent message history.

**Not chosen:** KV as primary correctness state.

**Reason:** V1 needs relational constraints, durable idempotency records, history, provider correlation and guarded state transitions.

## D-003 — Use Cloudflare Queues for reliable async processing

**Decision:** Webhook ingress validates/normalizes/enqueues and returns quickly. Queue consumers perform stateful work and slow upstream API calls.

**Reason:** Keeps webhook acknowledgement independent from AI/provider latency and provides bounded retry/DLQ boundaries.

**Important:** Queues are at-least-once. Duplicate delivery is expected and must be safe.

## D-004 — Defer Durable Objects in V1

**Decision:** Start with D1 + event idempotency + guarded/optimistic state updates. Add per-conversation Durable Objects only if concurrency testing or production evidence shows a material ordering problem.

**Reason:** Durable Objects are available on Workers Free, so this is not a quota-driven rejection. They are deferred because V1 can meet current requirements with fewer coordination primitives.

## D-005 — R2 replaces external image hosting

**Decision:** Images and ordinary temporary files share one private R2 attachment subsystem.

**Reason:** Simplifies operations and allows consistent expiration/security behavior.

## D-006 — Enforce attachment expiry in the application

**Decision:** R2 lifecycle deletion is cleanup, not authorization. Every gateway attachment URL checks D1 `expires_at` before serving content.

**Reason:** Physical lifecycle deletion may occur after logical expiry.

## D-007 — Provider IDs, not content hashes, define idempotency

**Decision:** Use Chatwoot webhook delivery/message IDs, Telegram update/message IDs, stable outbound operation IDs and provider-returned IDs as primary correlation.

**Reason:** Identical legitimate messages must remain distinct.

## D-008 — Separate AI handoff mode from generation locking

**Decision:** V1 human handoff modes remain:

- `ENABLED`
- `PAUSED_OPERATOR`
- `PAUSED_MANUAL`

AI generation-in-progress is represented by separate lease fields such as `ai_generation_id` and `ai_generation_started_at`, not by adding `GENERATING` to the human handoff enum.

**Reason:** Human handoff and transient LLM execution are different dimensions. An operator must be able to pause AI while a generation is already running; the returned AI result must then be discarded safely.

## D-009 — Context before RAG

**Decision:** V1 adds bounded recent conversation context from D1. Vector RAG/knowledge retrieval is a later phase.

**Reason:** Multi-turn context fixes the largest current AI quality gap with much less complexity than a full knowledge system.

## D-010 — Human service must survive AI failure

**Decision:** AI is optional and cannot be placed on the critical path for basic Chatwoot↔Telegram delivery.

**Reason:** Support must continue during AI-provider outages or missing AI configuration.

## D-011 — TypeScript for the new implementation

**Decision:** New Worker code is TypeScript rather than continuing the legacy JavaScript single-file structure.

**Reason:** The new project introduces normalized provider types, guarded state transitions, persistence schemas, attachment metadata and retry flows that benefit from compile-time contracts.

## D-012 — No automatic permanent learning from operator replies

**Decision:** Later learning features may create reviewable knowledge candidates, but no operator reply is automatically promoted to permanent trusted knowledge.

**Reason:** Prevents temporary policy, mistakes or sensitive content from contaminating the AI knowledge base.

## D-013 — Keep one Chatwoot conversation per Telegram topic in V1

**Decision:** `1 Chatwoot Conversation = 1 Telegram Forum Topic`.

**Lifecycle:** Resolve -> close topic; reopen -> reopen topic.

**Reason:** This gives deterministic reply routing and avoids ambiguity when a customer has more than one active conversation or inbox.

**Rejected review suggestion:** `1 Customer = 1 Topic` is not adopted for V1. It can be revisited only if real topic clutter becomes a measured operator problem and a clear multi-conversation reply-targeting model is designed.

## D-014 — Use Chatwoot source correlation for fast echo suppression

**Decision:** CZ2128-originated Chatwoot messages should carry a stable `source_id` marker such as `cz2128:<outbound_operation_id>` where supported by the API.

**Reason:** Signed Chatwoot webhook ingress can identify and fast-drop its own echoes without content hashing.

**Constraint:** This marker complements D1 message/operation correlation; it does not replace the canonical operation ledger.

## D-015 — Model outbound side effects explicitly

**Decision:** Add an `outbound_operations` ledger with stable operation IDs and statuses such as `PENDING`, `SENDING`, `SENT`, `FAILED_RETRYABLE`, and `FAILED_FINAL`.

**Reason:** Queue retries must not blindly repeat customer-visible provider actions.

**Reality:** Exactly-once delivery cannot be mathematically guaranteed when a third-party provider accepts a request immediately before the Worker loses the response and the provider has no transactional idempotency key. V1 must model this ambiguity rather than pretending it does not exist.

## D-016 — Queue events are references, never file bodies

**Decision:** File/image bytes never enter Cloudflare Queue messages. Queue payloads contain stable IDs, provider references and metadata only.

**Reason:** Keeps queue processing small, retryable and independent from large binary payloads.

## D-017 — Enforce Telegram hosted Bot API download limit in V1

**Decision:** Telegram-originated file ingestion through the hosted Bot API is limited to files supported by `getFile`; V1 rejects unsupported oversized files with a clear operator message.

**Reason:** The hosted Bot API currently caps downloads at 20 MB. A self-hosted Bot API server is deferred until larger files are a proven requirement.

## D-018 — Use one private temporary attachment pipeline

**Decision:** Telegram and Chatwoot attachments share one D1 state machine, private R2 bucket, stable Queue job contract and outbound operation ledger. R2 keys contain no customer or filename data.

**Reason:** Source adapters differ, but identity, storage, delivery ambiguity, expiry and access control must not diverge by provider.

## D-019 — Restrict Chatwoot source downloads

**Decision:** Chatwoot attachment URLs are accepted only from verified webhook events. The initial URL must match the configured HTTPS Chatwoot origin. Redirects are manual, limited to three and restricted to exact configured hosts. Chatwoot credentials are sent only to the exact Chatwoot origin and are stripped on cross-origin redirects.

**Reason:** A generic URL fetcher or automatic credential-bearing redirect would create SSRF and credential disclosure paths.

## D-020 — Bound attachment memory and retention

**Decision:** Source downloads stream to R2 through bounded 5 MiB multipart chunks. Destination multipart uploads buffer one file at a time with a hard 20 MiB maximum. Business retention is 24 hours; hourly cleanup removes the object before its D1 row, and a seven-day R2 lifecycle rule handles orphans.

**Reason:** Workers must not buffer multiple large files or retain private content indefinitely.

## D-021 — Separate bootstrap and runtime configuration

**Decision:** D1 owns frequently changed provider and limit overrides, resolved once per request/event with env fallback only when a successful D1 read proves no override exists. Runtime-store read failure disables runtime-controlled provider identities/credentials rather than falling back. Cloudflare bindings, Chatwoot webhook signing, the encryption master key and all Admin Bot identity/authorization settings remain bootstrap-only.

**Reason:** Routine operations should not require a Worker redeploy, while break-glass access and ingress trust anchors must remain outside the mutable control plane.

## D-022 — Encrypt runtime secrets with key-bound authenticated encryption

**Decision:** Runtime secrets use AES-256-GCM with a fresh 12-byte nonce and config-key AAD. D1 and history never store plaintext secrets. A present but invalid secret override does not fall back to env.

**Reason:** Authenticated encryption prevents undetected corruption and cross-key ciphertext substitution; fail-closed resolution prevents credential rollback by corruption.

## D-023 — Treat Support Telegram identity and group changes as workflows

**Decision:** The Support Bot token, webhook secret and webhook path activate as one encrypted profile after provider validation and a new webhook identity is created. The profile version scopes Telegram event/message/outbound identity and lexicographic operator ordering; old-generation queued events are discarded. Rotation drops candidate-bot pending updates. Group migration validates forum permissions and atomically clears old topic mappings. Both require confirmation and dedicated workflows rather than generic set/rollback.

**Reason:** Partial bot rotation or reuse of topic IDs across groups can admit stale webhooks, duplicate events or misroute operator messages.

## D-016 — Retire legacy AI FAILED from new runtime writes

**Decision:** New runtime code must never intentionally write `ai_runs.status='FAILED'`. Migration `0005` continues to accept and read `FAILED` temporarily so old Workers and rows remain compatible during rolling deployment. A new Worker that encounters `FAILED` lazily normalizes it with CAS into `FAILED_RETRYABLE`, `RETRY_EXHAUSTED` or `FAILED_FINAL`.

**Classification:** Retryable finite AI codes remain retryable only while budget remains. Final codes become `FAILED_FINAL`. Unknown/missing legacy errors fail closed as `FAILED_FINAL`. Legacy rows consume at least one attempt, and missing retry timing receives the bounded fallback rather than an immediate provider retry.

**Reason:** Rolling deployment compatibility requires the schema to accept old writes, while the steady-state runtime needs finite retry/final semantics and must not grant old failed requests extra attempts.

## Phase 4B-2B
- v2 lease-token compatibility rule applied for robust boundary handoff
- attempt_count means actual provider-boundary crossings
- legacy expired SENDING is never auto-retried
- new v2 pre-request expired SENDING may be safely reclaimed
- started request expiry becomes AMBIGUOUS

## D-024 — Persist immutable outbound subject and target evidence

**Decision:** Every new outbound operation persists one finite subject identity and one versioned, sanitized target-evidence document before a provider-visible request. The same deterministic operation ID cannot be reused with a different subject or material target identity. Existing attempted rows without evidence are never assigned historical identity from current mutable runtime configuration. Chatwoot identity contains a SHA-256 fingerprint of one canonical full API base: scheme, host, effective port and base pathname. The raw URL is not persisted. Normal messages, attachments, reconciliation and candidate validation use the same canonical URL builder, including identical trailing-slash semantics.

**Reason:** A safe retry must prove it is addressing the same business subject and provider destination as the original attempt. Current configuration cannot prove where a historical request was sent. Origin-only identity is insufficient because two Chatwoot deployments on the same origin may use different base paths.

## D-025 — Reconcile ambiguity without rewriting delivery history or resending

**Decision:** The original delivery status remains `AMBIGUOUS`. `CONFIRMED_SENT` and `MANUAL_MARK_DELIVERED` supply effective-SENT behavior without invoking a provider action. Chatwoot may be positively confirmed only by an exact unique `source_id=cz2128:<operation_id>` after a bounded, read-only `after`-cursor scan proves the currently available history is exhausted. The scan starts at `after=0`, advances with the largest valid provider message ID actually returned, reads at most five supported cursor pages of up to 100 messages each, and rejects invalid or non-advancing cursor data. Reaching the local page/message/runtime bound is not proof of uniqueness and remains `STILL_AMBIGUOUS`. Before any provider GET, the reconciliation service independently derives current runtime target identity from `env`; callers cannot supply or override it. Zero matches, multiple matches and Telegram operations remain `STILL_AMBIGUOUS`. Manual mark-delivered and cancel transitions use CAS plus an atomic `reliability_audit` record.

**Reason:** Provider acceptance cannot be disproved by a bounded cursor search, Chatwoot `source_id` is not database-unique, and Telegram has no trustworthy generic historical lookup in the current architecture. Preserving historical uncertainty prevents incomplete scans from creating false delivery confirmation or becoming a blind resend path.

**Scope:** Phase 4B-2C-1 only. No `0006`, manual retry child, visible redrive, AI durable-state activation, Admin UI or DLQ consumer is introduced.

**Status:** Phase 4B-2C-1, Phase 4B-2C-2 and Phase 4B-2C-3 are COMPLETE / FROZEN. Phase 4B-2C overall is COMPLETE / FROZEN. D-016 rolling compatibility remains in force.

## D-026 — Manual retry creates one deterministic child and repairs domain state separately

**Decision:** An explicit manual retry never reuses or rewrites the original ambiguous operation. It records the finite reason `OPERATOR_ACCEPTS_DUPLICATE_RISK`, preserves the parent as historical `AMBIGUOUS`, atomically transitions the parent to `MANUAL_RETRY_CREATED`, and creates at most one deterministic direct child through `parent_operation_id`. Further retries form an explicit child-to-grandchild chain rather than another child of the original parent.

**Payload and target rule:** Phase 4B-2C-2 supports only `MESSAGE`, `ATTACHMENT` and Telegram `CONVERSATION` subjects. Payloads are reconstructed only from durable message rows, unexpired retrievable private R2 objects, or durable conversation data. The current destination must match the parent's sanitized target evidence. Chatwoot destination comparison ignores only the operation-scoped `sourceId`; the child receives `source_id=cz2128:<child-operation-id>`. `AI_RUN` was deferred by this frozen phase and is activated separately by D-027 in Phase 4B-2C-3. `CONTROL_ACK` is not manually retried.

**Domain rule:** Effective delivery through `CONFIRMED_SENT`, `MANUAL_MARK_DELIVERED` or child `SENT` invokes a provider-free, idempotent D1 CAS service. It may repair an ambiguous attachment to `DELIVERED`, populate a missing topic reference, or apply close/reopen status only when persisted target identity still matches. Every Telegram conversation repair first requires the persisted `groupRef` to equal the current effective `BOT_GROUP_ID`; old-group topic evidence cannot repopulate or mutate routing after support-group migration, even when the thread reference or local status appears compatible. Bot generation equality is not required when the support group is unchanged. Conflicting provider references or newer topic mappings fail closed and are never overwritten.

**Reason:** Accepting uncertainty and performing a new visible side effect require a new auditable identity. Separating provider execution from local domain repair allows a transient D1 failure to be retried without repeating the provider action.

**Scope:** Phase 4B-2C-2 only. No migration `0006`, external Admin surface, DLQ consumer, `CONFIRMED_NOT_SENT` activation, AI durable retry state machine or legacy AI `FAILED` retirement.

**Status:** Phase 4B-2C-2 and Phase 4B-2C-3 are COMPLETE / FROZEN. Phase 4B-2C overall is COMPLETE / FROZEN. Phase 4B-2B and Phase 4B-2C-1 remain COMPLETE / FROZEN.

## D-027 — Bound durable AI generation and reuse successful results

**Decision:** One `trigger_event_ref` has a maximum of three `generateChatCompletion()` invocations. Acquiring a conversation generation lease, creating/reclaiming `PENDING`, receiving a Queue event or reaching a retry deadline does not increment `attempt_count`. A generation-owned CAS increments it immediately before the provider function is invoked. A crash after this CAS but before provider fetch may conservatively consume an attempt; no extra migration is added for that narrow window.

**Retry rule:** Retryable AI errors persist `FAILED_RETRYABLE` plus a bounded `next_retry_at` while attempts remain. AI 429 honors bounded provider `Retry-After`; other retryable classes use the canonical fallback. The third retryable failure becomes terminal `RETRY_EXHAUSTED` with `AI_RETRY_EXHAUSTED`. Non-retryable failures become terminal `FAILED_FINAL`. No fourth attempt is allowed.

**Ownership and handoff rule:** The conversation generation lease remains separate from the durable run. Every result transition is owned by `generation_id`. A late old generation cannot overwrite a newer owner or mark it stale. Human/manual handoff wins before visible AI delivery and uses `CANCELLED_BY_HANDOFF`; non-current generation results use `DISCARDED_STALE` only while still owning their row.

**Outbound rule:** Durable `SUCCESS` text is reused and is never regenerated because Chatwoot or Telegram delivery failed. Explicit manual retry supports `AI_RUN` only when the matching run is `SUCCESS`, belongs to the same conversation and has durable response text. Chatwoot children use child-scoped `source_id`; Telegram mirrors reuse the exact `🤖 AI` format. Effective Chatwoot delivery repairs one durable AI message idempotently and fails closed on identity/content conflict.

**Scope:** Phase 4B-2C-3 only. Migration `0006`, Admin reliability UI/commands, DLQ consumption, `CONFIRMED_NOT_SENT`, Durable Objects and Phase 4C load acceptance remain absent.

**Status:** COMPLETE / FROZEN / MERGED. Phase 4B-2C overall is COMPLETE / FROZEN. Phase 4B-3 is COMPLETE / FROZEN / MERGED. Phase 4B-4A is IMPLEMENTED / IN REVIEW; Phase 4B-4B, 4B-5, and 4C remain NOT STARTED.

## Phase 4B-3 Reliability Control Plane
**Decision:** Reliability control plane uses the existing authenticated Telegram Admin Bot. No new Web Admin, public HTTP control API or authentication system is introduced. Admin UI never directly mutates reliability state; frozen core services remain authoritative. Manual reconciliation, mark-delivered, cancel and deterministic manual-retry child operations are active. Destructive actions use action-specific expiring confirmation sessions, and Manual Retry requires explicit duplicate-risk confirmation. Operation IDs and CREATE_TOPIC provider references are bound through session state rather than callback payloads. AI Reliability is read-only.

**Scope:** `CONFIRMED_NOT_SENT`, DLQ handling, Durable Objects, migration `0006`, Phase 4B-4, Phase 4B-5 and Phase 4C were outside Phase 4B-3.

**Status:** COMPLETE / FROZEN / MERGED.

## D-028 — Capture DLQ loss boundaries as sanitized durable receipts (PROPOSED / WIP)

**Decision:** The Worker discriminates the main queue and `cz2128-dlq` only through `batch.queue`. DLQ capture never invokes normal event handling or runtime provider resolution. It derives a deterministic receipt identity from bounded event metadata, with the Cloudflare message ID as the hashed malformed-envelope fallback, and persists only finite metadata through the existing migration `0005`.

**Durability rule:** The preferred path persists the sanitized receipt and matching `event_receipts` dead-letter marker through D1. If that fails, a dedicated private `DLQ_QUARANTINE` R2 binding stores one deterministic allowlisted terminal evidence object keyed by a hash of trusted Queue name/message identity. The Queue message is ACKed only after D1 or R2 persistence succeeds; both failing requires Queue retry. Quarantine is terminal evidence, not canonical application state, and simultaneous persistent D1/R2 failure plus retry exhaustion remains a residual loss risk.

**Convergence rule:** D1 capture determines OPEN/RESOLVED from canonical state inside the write batch. Canonical `PROCESSED` completion shares a D1 batch with a metadata-only matching OPEN→RESOLVED update. Both commit orders therefore converge monotonically; RESOLVED never regresses to OPEN.

**Privacy and inspection rule:** Raw message bodies, customer/operator/AI text, attachment locators or tokens, private URLs, provider responses, secrets and free-form exceptions are never persisted, logged or rendered. The existing authenticated private Telegram Admin Bot supplies bounded read-only D1 and R2-quarantine metadata views. R2 inspection validates custom metadata and never reads object bodies.

**Scope:** Phase 4B-4A only. Explicit durable-state redrive is deferred to Phase 4B-4B. No migration `0006`, Web Admin, public API, new authentication system, Durable Object, `CONFIRMED_NOT_SENT`, provider action or main-queue retry change is introduced.

**Status:** PROPOSED / IMPLEMENTED / IN REVIEW / NOT ACCEPTED. Phase 4B-4 overall is IN PROGRESS. Phase 4B-4B, Phase 4B-5 and Phase 4C remain NOT STARTED.
