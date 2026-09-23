# CZ2128 Roadmap

Status: **Phases 1-3.5 complete and merged — Phase 4A frozen — Phase 4B-1 complete / Phase 4B-2B complete and frozen / Phase 4B-2C complete and frozen / Phase 4B-3 complete, frozen and merged / Phase 4B-4A complete, frozen and merged / Phase 4B-4B accepted, complete, frozen and merged / Phase 4B-4 overall complete, frozen and merged / Phase 4B-5 accepted, complete, frozen and merged — Phase 4C in execution with Crisp-02 basic-support Staging acceptance complete**

## Crisp-01 - Basic Crisp support bridge

Status: **COMPLETE / MERGED**

Crisp is now the sole active helpdesk target. PR #21 implemented signed webhook
admission, website/session identity isolation, Crisp text ingress, deterministic
Crisp outbound operations, Telegram topic mapping, human handoff, and optional
welcome/Picker menus. Its exact head `40465c32d0fb1e56faab12eaf62839a2245c2c20`
passed CI run `35679432185` (#132) and merged as
`f5100ce1e7b4c0d476cbdc3c5475214ece103c54`.

Crisp-01 deliberately deferred real Provider/Staging acceptance, attachments,
conversation lifecycle and Crisp AI generation/outbound recovery. The basic
Provider/Staging acceptance portion was subsequently exercised by Crisp-02; those
remaining unrelated scopes are not implied complete.

## Crisp-02 - Real Staging basic support bridge acceptance

Status: **COMPLETE / REAL STAGING E2E ACCEPTED (BASIC SUPPORT SCOPE)**

Crisp-02 performed the authorized real Staging troubleshooting/acceptance sequence
without rewriting historical failures. The final outbound-correlation fix is PR #27:
base `4c8b1b8f89afda6471f1ca4fcb1f5e8c1bf0b2f9`, exact head
`9b0c05927e91594a43e91605e608728e976c7854`, merge
`512917eecb75df534b5cf1733f296ae06818d125`. Exact-head CI run
`35806188973` (#144) and main CI run `35806917583` (#145) both completed
successfully. The retained independent Gemini 3.1 Pro review of the exact PR #27
base/head returned `APPROVE` and required real Provider validation before closure;
that Provider validation was then completed in WCX12/WCX13.

Accepted real Staging behavior:

- Crisp customer ingress -> Telegram topic/message.
- Telegram operator reply -> Crisp.
- Welcome and native main Picker.
- Standard deterministic numeric Crisp fingerprint correlation and durable
  self-echo suppression without the rejected custom `properties` marker.
- Multi-level Picker transition, preset response and leaf response.
- Picker-driven human handoff with durable `PAUSED_OPERATOR` state/audit and one
  Telegram handoff notification.

Historical WCX7-WCX11 `FAILED_FINAL / HTTP 400` Welcome/Picker operations remain
preserved as evidence. WCX12/WCX13 produced no new Crisp HTTP-400 diagnostic.

This acceptance does **not** close Crisp attachments, close/reopen lifecycle,
Crisp AI generation/durable AI recovery, real R2 data-plane testing, Queue/D1
concurrency/fault acceptance, Admin recovery, load/multi-region, monitoring,
rollback drills or Production.

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

The 4C staging attachment and DLQ-quarantine R2 buckets now exist. Read-only
metadata verifies the attachment bucket's seven-day `attachments/` expiry and
seven-day incomplete-multipart abort rules. Real R2 write/multipart/read/Range/delete,
20 MiB memory behavior and scheduled-cleanup behavior remain **NOT VALIDATED**;
metadata existence/lifecycle listing is not a data-plane acceptance result.

## Phase 4 — Reliability Hardening

Goal: make production failure modes explicit and recoverable.

Current status:

- Phase 4A reliability architecture: **COMPLETE / FROZEN**
- Phase 4B-1 canonical error taxonomy and retry contracts: **COMPLETE**
- Phase 4B-2A Reliability Persistence Foundation: **COMPLETE / MERGED**
  - Note: 0005 expands `ai_runs` durable status capacity and remains the final migration. Phase 4B-2C-3 now retires legacy `FAILED` from new runtime writes while retaining schema/read compatibility for rolling deployment.
- Phase 4B-2A: **COMPLETE**
- Phase 4B-2B: **COMPLETE / FROZEN / MERGED**
- Phase 4B-2C-1 Outbound Reconciliation + Target Evidence: **COMPLETE / FROZEN / MERGED**
- Phase 4B-2C-2 Manual Retry Child Operations + Domain Resolution: **COMPLETE / FROZEN / MERGED**
- Phase 4B-2C-3 AI Durable Retry State Machine + legacy FAILED retirement: **COMPLETE / FROZEN / MERGED**
- Phase 4B-2C overall: **COMPLETE / FROZEN**
- Phase 4B-3 reliability control-plane exposure: **COMPLETE / FROZEN / MERGED**
- Phase 4B-4A DLQ capture, terminal sanitized quarantine and Admin inspection: **COMPLETE / FROZEN / MERGED**
- Phase 4B-4B explicit durable-state AI recovery: **ACCEPTED / COMPLETE / FROZEN / MERGED**
- Phase 4B-4 overall: **COMPLETE / FROZEN / MERGED**
- Phase 4B-5 reliability operations, recovery and pre-production acceptance documentation: **ACCEPTED / COMPLETE / FROZEN / MERGED**
- Phase 4C: **IN EXECUTION** — isolated staging foundation exists; Crisp-02 real Staging basic-support acceptance is complete and scoped
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

Phase 4B-2C-1 uses the existing `0005` columns and tables. It persists finite subject identity and versioned sanitized target evidence before visible requests, blocks retries when stored and current target identity differ, preserves historical `AMBIGUOUS`, supports effective-SENT interpretation after confirmed/manual delivery, and provides bounded Chatwoot exact-`source_id` positive reconciliation through five supported `after`-cursor pages of up to 100 messages. Positive confirmation requires observed provider-history exhaustion; reaching the bound never proves uniqueness. Zero/multiple matches, invalid or non-advancing cursors and all Telegram ambiguity remain unresolved. The phase also adds internal manual mark-delivered/cancel persistence with atomic reliability audit. It does not implement manual retry children, visible redrive, AI durable retry activation, Admin UI or DLQ consumption.

Phase 4B-2C-2 adds an internal explicit manual-retry service for `MESSAGE`, `ATTACHMENT` and Telegram conversation operations. It atomically links one deterministic child to one ambiguous parent, gives Chatwoot children a new child-scoped `source_id`, reuses the frozen outbound attempt lifecycle, and never automatically resends an ambiguous or final child. Payloads come only from durable messages, unexpired retrievable R2 objects or durable conversation data. Attachment delivery state and Telegram topic mapping/status are repaired by a separate idempotent CAS service after `CONFIRMED_SENT`, `MANUAL_MARK_DELIVERED` or child `SENT`. No external control plane, DLQ consumer, migration `0006` or AI durable retry behavior is included.

Phase 4B-2C-3 activates the durable AI state machine already provisioned by `0005`: three provider-boundary attempts, persisted retry deadlines, terminal exhaustion/final/handoff/stale states, generation-owned result CAS and lazy legacy `FAILED` normalization. A durable `SUCCESS` is reused for outbound continuation and explicit `AI_RUN` manual retry without regenerating text. Effective Chatwoot delivery repairs the AI message domain idempotently; Telegram mirror delivery remains context-neutral. Phase 4B-3, DLQ consumption, load/concurrency acceptance and production readiness remain outside this phase.

Phase 4B-3 reuses the existing private Telegram Admin Bot to expose bounded reliability reads and confirmed manual reconciliation, mark-delivered, cancel and manual-retry operations through frozen core services. AI Reliability is read-only. No Web Admin, public API, new authentication system, migration `0006`, DLQ consumer/redrive, `CONFIRMED_NOT_SENT` activation or Durable Object was introduced in that phase.

Phase 4B-4A is COMPLETE / FROZEN / MERGED by PR #12. It adds provider-free DLQ receipt capture to the same Worker. `batch.queue` strictly separates `cz2128-queue` from `cz2128-dlq`; malformed and valid DLQ bodies are reduced in memory to bounded metadata and deterministic hashed identities. D1 remains canonical through the existing `0005` tables. A dedicated private R2 quarantine stores allowlisted terminal evidence only when D1 capture fails; ACK follows either durable path, while dual failure retries. Canonical PROCESSED and DLQ RESOLVED metadata converge in both commit orders. The private Telegram Admin Bot exposes bounded D1 and quarantine metadata. Raw payload retention remains prohibited. The bounded Admin R2 listing does not guarantee globally newest 10 entries above 1000 objects; this is LOW non-blocking observability debt for pre-production / Phase 4C. Local Wrangler/workerd service tests cover complete concurrent capture calls but do not replace Phase 4C production concurrency/load validation. Production `DLQ_QUARANTINE` provisioning and validation remain pending.

Phase 4B-4B adds explicit durable-state recovery only for eligible `internal / ai_trigger` receipts. It reconstructs the exact original event from D1, requires the newest durable customer text, an existing eligible `ai_runs` row and pre-existing Chatwoot target evidence, and rechecks freshness and handoff during actual processing. Normal fresh AI work prepares that evidence before generation; historical recovery never fills a missing operation from current configuration. Freshness or handoff conditionally closes safe PENDING/observed-429 operations with distinct reason-specific deterministic audit, preserves SENT/final history and refuses to resolve the DLQ around SENDING or AMBIGUOUS work. Historical no-send cleanup remains valid across current mapping drift, while fresh newer-message behavior and generation-owner replacement semantics remain unchanged. Chatwoot `SENT` converges without resend, while a missing historical Telegram mirror is skipped. The private Admin Bot requires confirmation and revalidation, writes deterministic operator-intent audit before enqueue, and sends through the existing main Queue. Same-command sends dedupe; distinct commands may enqueue the same logical event. Receipt state remains OPEN until canonical resolution. Quarantine and every non-AI event remain non-redrivable. No schema or infrastructure expansion is included. The phase is ACCEPTED / COMPLETE / FROZEN / MERGED; production deployment and `DLQ_QUARANTINE` provisioning remain NOT DEPLOYED / NOT PROVISIONED / NOT VALIDATED.

Final SENT hardening requires bounded provider-delivery identity in both initial and CAS-lost convergence checks. Malformed SENT remains untouched and keeps the DLQ OPEN; internal domain repair cannot substitute for external delivery evidence.

Phase 4B-5 is a documentation-only closure for reliability operations, migration/recovery boundaries and the Phase 4C acceptance matrix. It was accepted, completed, frozen and merged by PR #15 as `d6e111cbf79e4a64a396c749d60821d6a5a6d7f8`; `62c7c51120ad4d44fcdc4cff089173258b719c28` is the historical pre-PR #15 implementation base. It introduces no runtime behavior, schema, migration or resource change. Phase 4C execution was outside Phase 4B-5 and is now underway under separate authorizations; production readiness remains unproven.

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
