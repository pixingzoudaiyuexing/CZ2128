# CZ2128 Roadmap

Status: **Draft — architecture review in progress**

## Phase 0 — Architecture Freeze

Goal: approve a buildable V1 architecture before implementation.

Deliverables:

- `PROJECT.md`
- `ARCHITECTURE.md`
- `DECISIONS.md`
- `AGENTS.md`
- Independent Gemini architecture review
- Primary final decision and doc updates

Exit criteria:

- storage responsibilities are clear
- webhook verification/idempotency strategy is approved
- message/AI handoff state model is approved
- attachment architecture is approved
- retry/queue strategy is approved
- V1 scope/non-goals are frozen

## Phase 1 — Foundation + Chatwoot/Telegram Core

Goal: establish the new repository structure and reliable human support bridge.

Scope:

- TypeScript Worker project foundation
- configuration/secrets contracts
- D1 migrations and repositories
- Chatwoot webhook verification and adapter
- Telegram webhook verification and channel adapter
- queue ingress/consumer baseline
- conversation ↔ Telegram topic mapping
- customer message -> Telegram
- Telegram operator reply -> Chatwoot
- Chatwoot human reply -> Telegram
- provider-ID-based event/message idempotency
- structured logging
- automated tests for critical bridge flows

No AI dependency required for this phase to function.

## Phase 2 — AI Handoff + Multi-turn Context

Goal: restore and improve the proven AI behavior from the legacy bot.

Scope:

- OpenAI-compatible adapter
- `ENABLED / PAUSED_OPERATOR / PAUSED_MANUAL` state machine
- Telegram AI on/off controls
- operator pause from Telegram and Chatwoot
- auto-resume timeout on next customer message
- bounded recent D1 conversation context
- AI failure fallback to human path
- tests for all state transitions and duplicate deliveries

## Phase 3 — Unified Temporary Attachments

Goal: replace EasyImages and support ordinary temporary files.

Scope:

- private R2 bucket
- image upload/serve path
- ordinary file upload/serve path
- opaque access tokens
- D1 attachment metadata
- exact logical expiry
- R2 lifecycle cleanup
- Telegram oversize handling
- Crisp-era EasyImages dependency removed from the new project
- tests for access, expiry, missing/deleted objects, and retries

## Phase 4 — Reliability Hardening

Goal: make production failure modes explicit and recoverable.

Scope:

- retry policy refinement
- dead-letter handling
- reconciliation tools/commands for failed deliveries
- additional provider-correlation edge cases
- migration rollback/recovery procedures
- rate-limit behavior
- structured error taxonomy
- production runbook

## Phase 5 — Knowledge / RAG

Goal: add knowledge retrieval without coupling it to the helpdesk platform.

Scope to be designed later:

- knowledge source model
- chunking/indexing strategy
- retrieval quality evaluation
- citations/internal provenance
- safe fallback when knowledge confidence is low

Do not start until Phases 1–4 are stable.

## Phase 6 — Human Learning Workflow

Goal: turn successful human support into reviewed knowledge candidates.

Possible flow:

```text
customer question
  -> AI cannot answer / human takes over
  -> operator answer
  -> candidate extraction
  -> review/approve/reject
  -> publish to knowledge base
```

No automatic unreviewed permanent learning.

## Phase 7 — Operations / Analytics UI

Optional later work:

- message volumes
- AI vs human resolution ratios
- provider/API failures
- average AI response latency
- attachment usage
- DLQ/retry inspection
- knowledge-candidate review UI

This phase is intentionally not part of initial V1.