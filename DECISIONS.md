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