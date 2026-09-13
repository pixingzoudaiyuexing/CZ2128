# CZ2128 Decisions

Status: **Draft decisions pending independent architecture review**

## D-001 — Keep upstream helpdesk unmodified

**Decision:** Do not fork or modify Chatwoot for V1. Integrate through supported Webhooks/API/Widget capabilities.

**Reason:** Reduces upgrade friction and keeps CZ2128 independent from one helpdesk implementation.

## D-002 — Make D1 the canonical gateway database

**Decision:** D1 stores gateway-owned conversation mapping, provider message references, event receipts, AI state, attachment metadata, and recent message history.

**Not chosen:** KV as primary correctness state.

**Reason:** The legacy Worker used KV for state, but V1 needs relational constraints, durable idempotency records, history, and queryable metadata.

## D-003 — Use Cloudflare Queues for reliable async processing

**Decision:** Webhook ingress should validate/normalize/enqueue and return quickly. Queue consumers perform the stateful work and upstream API calls.

**Reason:** Provides a clear retry boundary and prevents Chatwoot/Telegram webhook delivery from being coupled to AI or other upstream latency.

**Review item:** Confirm that this complexity is justified for V1.

## D-004 — Do not require Durable Objects in V1

**Decision:** Start with D1 + event idempotency + optimistic/versioned state updates. Add per-conversation Durable Objects only if concurrency testing shows an ordering/consistency problem that materially affects behavior.

**Reason:** Avoid premature infrastructure complexity while keeping a migration path open.

## D-005 — R2 replaces external image hosting

**Decision:** Images and ordinary temporary files share one private R2 attachment subsystem.

**Reason:** Simplifies operations and allows consistent expiration/security behavior.

## D-006 — Enforce attachment expiry in the application

**Decision:** R2 lifecycle deletion is cleanup, not authorization. Every gateway attachment URL checks D1 `expires_at` before serving content.

**Reason:** Physical lifecycle deletion can lag the logical expiration time.

## D-007 — Provider IDs, not content hashes, define idempotency

**Decision:** Use webhook delivery IDs, Telegram update IDs, and returned provider message IDs as primary duplicate/echo correlation.

**Reason:** Identical legitimate messages must remain distinct.

## D-008 — Keep the AI state machine minimal

**Decision:** V1 uses `ENABLED`, `PAUSED_OPERATOR`, and `PAUSED_MANUAL`.

**Reason:** These states directly cover existing proven behavior without creating an unnecessary workflow engine.

## D-009 — Context before RAG

**Decision:** V1 adds bounded recent conversation context from D1. Vector RAG/knowledge retrieval is a later phase.

**Reason:** Multi-turn context fixes the largest current AI quality gap with much less complexity than a full knowledge system.

## D-010 — Human service must survive AI failure

**Decision:** AI is optional and cannot be placed on the critical path for basic Chatwoot↔Telegram delivery.

**Reason:** Support must continue during AI-provider outages or missing API configuration.

## D-011 — TypeScript for the new implementation

**Decision:** New Worker code is TypeScript rather than continuing the legacy JavaScript single-file structure.

**Reason:** The new project introduces normalized provider types, state transitions, persistence schemas, attachment metadata, and retry flows that benefit materially from compile-time contracts.

## D-012 — No automatic permanent learning from operator replies

**Decision:** Later learning features may create reviewable knowledge candidates, but no operator reply is automatically promoted to permanent trusted knowledge.

**Reason:** Prevents temporary policy, mistakes, or sensitive content from contaminating the AI knowledge base.