# CZ2128 Roadmap

Status: **Phases 1-3.5 complete and merged — Phase 4A frozen — Phase 4B-1 in review**

## Phase 0 — Architecture Freeze

Status: **COMPLETE**

Goal: approve a buildable V1 architecture before implementation.

Completed deliverables:

- `PROJECT.md`
- `ARCHITECTURE.md`
- `DECISIONS.md`
- `AGENTS.md`
- Independent Gemini architecture review
- Primary final decision and architecture updates

Frozen outcomes:

- D1 is canonical gateway state/history.
- Cloudflare Queues is mandatory for asynchronous processing/retries.
- Durable Objects are deferred, not prohibited.
- AI handoff mode and transient generation locking are separate concepts.
- Provider IDs and stable operation IDs define idempotency; content hashes do not.
- One Chatwoot conversation maps to one Telegram topic in V1.
- Resolved/reopened Chatwoot conversations close/reopen their Telegram topics.
- R2 is the unified private temporary attachment store.
- Chatwoot remains unmodified upstream.

## Phase 1 — Foundation + Chatwoot/Telegram Core

Status: **COMPLETE / MERGED**

Goal: establish the new repository structure and reliable human support bridge before introducing AI.

Scope:

- TypeScript Cloudflare Worker project foundation
- configuration/secrets contracts
- framework-light HTTP routing unless implementation evidence justifies a small router dependency
- D1 migrations and repositories
- minimum tables for conversations, messages, event receipts and outbound operations
- Chatwoot webhook raw-body HMAC/timestamp verification
- Chatwoot delivery/message ID idempotency
- Chatwoot `source_id=cz2128:<operation_id>` correlation for gateway-originated messages where supported
- Telegram webhook path + secret-token verification
- Telegram `update_id` idempotency
- Cloudflare Queue ingress/consumer baseline
- stable Queue event envelope and retry/DLQ policy
- one Chatwoot conversation ↔ one Telegram topic mapping
- topic create/reuse
- topic close/reopen on Chatwoot conversation lifecycle
- customer message -> Telegram
- Telegram operator reply -> Chatwoot
- Chatwoot human reply -> Telegram
- outbound operation ledger / guarded side effects
- structured redacted logging
- automated tests for all critical bridge/idempotency flows

No AI dependency is required for Phase 1 to function.

Exit criteria:

- normal messages sync in both directions
- duplicate webhooks/queue deliveries do not normally duplicate visible messages
- echo loops are suppressed using provider correlation, not text hashes
- resolved/reopened conversation topic lifecycle works
- provider failure/retry state is inspectable
- typecheck/lint/tests pass
- migrations work on a clean local/test D1 database

## Phase 2 — AI Handoff + Multi-turn Context

Status: **COMPLETE / MERGED**

Goal: restore and improve proven AI behavior from the legacy bot without weakening human support reliability.

Scope:

- OpenAI-compatible adapter
- human handoff modes: `ENABLED / PAUSED_OPERATOR / PAUSED_MANUAL`
- generation lease fields and guarded D1 acquisition/release
- Telegram AI on/off controls
- operator pause from Telegram and Chatwoot
- operator reply while generation is running invalidates/discards stale AI result
- auto-resume timeout on next customer message
- rapid customer message handling without silent loss or accidental double answer
- bounded recent D1 conversation context
- persist customer/AI/operator conversational messages
- exclude ordinary system/activity events from AI context
- AI failure releases generation lease and leaves human bridge operational
- tests for state races, retries, duplicate deliveries and provider failures

## Phase 3 — Unified Temporary Attachments

Status: **COMPLETE / MERGED**

Goal: replace EasyImages and support ordinary temporary files through one private attachment subsystem.

Scope:

- private R2 bucket
- image upload/serve path
- ordinary file upload/serve path
- streaming upload without whole-file buffering where platform APIs allow
- opaque access tokens; store hashes where practical
- D1 attachment metadata
- exact logical expiry in application
- R2 lifecycle cleanup
- hosted Telegram Bot API 20 MB download-limit enforcement
- clear oversize operator feedback
- safe filename/content-disposition handling
- GET/HEAD download path; Range support if practical and justified
- Crisp-era EasyImages dependency absent from the new project
- tests for access, expiry, missing/deleted objects, oversize rejection and retries

Code completion does not imply production validation. Real R2, Telegram, Chatwoot, proxy, cleanup, Queue/D1 concurrency and 20 MiB memory/load behavior must pass staging validation before production rollout; the seven-day R2 lifecycle must also be applied.

## Phase 3.5 — Runtime Config + Telegram Admin Control Plane

Status: **COMPLETE / MERGED**

Scope:

- D1 plain/encrypted runtime configuration with env fallback
- AES-256-GCM secret storage and append-only history
- coherent per-request/event configuration snapshots
- separate bootstrap-authenticated Telegram Admin Bot
- private-chat and exact user-ID authorization
- update idempotency and expiring interactive sessions
- AI/Chatwoot candidate validation
- atomic Support Bot profile rotation with a fresh webhook identity
- confirmed support-group migration with topic-mapping invalidation
- versioned CAS, restore-env and safe history rollback

The Cloudflare R2 account is now enabled, but Phase 3 real R2 staging has not yet been rerun. The staging bucket/lifecycle and dedicated Telegram/Chatwoot environments remain pending validation.

## Phase 4 — Reliability Hardening

Goal: make production failure modes explicit and recoverable.

Current status:

- Phase 4A reliability architecture: **COMPLETE / FROZEN**
- Phase 4B-1 canonical error taxonomy and retry contracts: **IMPLEMENTED / IN REVIEW**
- Phase 4B-2 and later implementation milestones: **NOT STARTED**
- Phase 4C concurrency/load validation: **NOT STARTED**

Scope:

- retry policy refinement
- dead-letter handling and inspection
- ambiguous third-party delivery outcome handling
- reconciliation tools/commands for failed/uncertain deliveries
- additional provider-correlation edge cases
- migration rollback/recovery procedures
- rate-limit behavior
- structured error taxonomy
- production runbook
- concurrency/load tests to decide whether per-conversation Durable Objects are actually needed

Durable Objects may be introduced here only if measured correctness/ordering problems justify them.

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
