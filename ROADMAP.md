# CZ2128 Roadmap

Status: **Phases 1-3.5 complete and merged — Phase 4A frozen — Phase 4B-1 complete / Phase 4B-2B complete and frozen / Phase 4B-2C complete and frozen / Phase 4B-3 complete, frozen and merged / Phase 4B-4A complete, frozen and merged / Phase 4B-4B accepted, complete, frozen and merged / Phase 4B-4 overall complete, frozen and merged / Phase 4B-5 accepted, complete, frozen and merged — Phase 4C in execution with scoped Crisp-02 through Crisp-05 Staging evidence recorded / Production not validated**

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

## Crisp-03 - Crisp AI delivery and human-handoff fencing

Status: **COMPLETE / SCOPED REAL STAGING EVIDENCE RECORDED**

PR #29 adapted the existing durable AI state machine to Crisp without changing
the historical Chatwoot reliability contracts. Exact head
`0baa56160fff71f26fb2822e5bf67aab770cbdd0` passed CI run `35814372077`
(#148) and merged as `04e49b609ec71ce08ec58a3dcb90cd270d830441`.
A real Staging handoff observation then exposed a narrower trigger-gating defect;
PR #30 fixed it at exact head `608107cca5780f3db8ed2d9addd4bb1f64f75546`,
passed CI run `35817480866` (#150), and merged as
`0cbe426f151ed378ad70c85615ac00c934e8505d`.

Bounded real Staging evidence includes one Crisp AI run that reached durable
`SUCCESS` at attempt 1, one Crisp AI visible send at HTTP 202, and one Telegram
mirror at HTTP 200. The same test conversation later entered
`PAUSED_OPERATOR`; the historical pre-fix zero-attempt
`CANCELLED_BY_HANDOFF` row remains preserved, while post-fix customer traffic
continued to Telegram without creating another AI run while paused.

This does **not** prove real provider retry exhaustion, real AI-provider outage
classification, load/multi-region behavior, historical DLQ redrive, or
Production.

## Crisp-04 - Crisp conversation lifecycle to the original Telegram Topic

Status: **COMPLETE / SCOPED REAL STAGING E2E RECORDED**

PR #31 implemented authoritative Crisp `session:set_state` coordination at
exact head `9f1baf25269f51322012ab927f74b1a2744630f4`, passed CI run
`35824245069` (#152), and merged as
`4ba044d8c9f05c50cb7ce25b0b5bb809556aa964`.

Read-only durable Staging evidence contains Crisp conversations on Telegram
Topics 89 and 95 with one `CREATE_TOPIC` each, followed by
`CLOSE_TOPIC -> REOPEN_TOPIC`; every lifecycle provider action is `SENT`,
HTTP 200, attempt 1, and the final mapping is the same original Topic in
`OPEN` state. Existing `PAUSED_OPERATOR` / handoff epochs were not reset.

The automated suite covers duplicate, stale/out-of-order and concurrent
lifecycle races. Those fault/race cases were not separately injected as real
Staging faults, and Production remains unvalidated.

## Crisp-05 - Crisp attachments and temporary ordinary-file upload

Status: **STAGE A SCOPED TRANSPORT EVIDENCE RECORDED / STAGE B SCOPED ISOLATED STAGING ACCEPTED**

### Stage A - Existing attachment core adapted to Crisp

PR #32 exact head `ab1e3e5dd654b87d183f3f826d6e4924726909ec` passed CI run
`35845173556` (#180). The first Telegram-source real Staging attempt exposed a
Telegram file-body redirect failure before any Crisp attachment send. PR #33
exact head `b53213364fa85baf520d858cb18d3b7b0a2e2aa3` passed CI run
`35852934163` (#182) and fixed only the official Telegram file-body redirect
handling.

Retained durable evidence for Topic 103 contains five Stage A attachment rows:
one 208,297-byte Crisp raster image delivered to Telegram at attempt 1; two
pre-fix Telegram-source rows preserved as
`FAILED_FINAL / ATTACHMENT_SOURCE_TRANSIENT / attempt 3`; and post-fix Telegram
photo (18,031 bytes) plus ordinary text file (128 bytes) delivered to Crisp at
attempt 1 / HTTP 202. The Crisp-source object's private R2 body was read back at
the expected size. This proves the bounded transport/provider slice, not every
client UX subcase: the record does not distinguish Crisp paste versus drag, and
does not prove a human-observed Crisp Markdown image render or a Stage A
ordinary-file download click.

### Stage B - Operator-created temporary customer upload

PR #34 exact head `cf956550718f6f235b76c720a83645873778d57f` passed CI
#184; PR #35 exact head `3fc2af45100c08bdfbd802c03d6c9b76d36a0a09`
passed CI #186; and the final HTTP-409 fix PR #36 exact head
`f3c94fe7bc6a63ef7992408c4997553834eb35a0` passed CI run
`35875802667` (#188), merged as
`d635520b1cde7a49e75ef5f658c862d5e856c5db`, with main CI run
`35881127038` (#189) successful.

Primary accepted the isolated-Staging Stage B flow at Worker version
`4d13f217-bd80-4c7c-a6bf-8ed13669be77`: an authorized Topic 117 command
created a server-bound invite; `kefu.txt` (11,272 bytes) became
`ACCEPTED`, was present in private R2 at the same size, reached attachment
`DELIVERED`, and produced one Telegram `SEND_ATTACHMENT` at HTTP 200 /
attempt 1. The operator successfully downloaded through the controlled
forced-download link. The upload invite later failed closed as `EXPIRED` /
`Not Found`; a separate fresh invite was explicitly `REVOKED` with a
Telegram HTTP-200 acknowledgement. Final Topic 117 evidence had zero ACTIVE
invites, `ai_runs = 0`, and one `CREATE_TOPIC`.

The earlier real HTTP-409 failure remains preserved as one `EXHAUSTED` invite
and three `FAILED_FINAL / UPLOAD_INVITE_LIMIT_EXCEEDED` attachment rows. PR
#36 fixed the trigger-inclusive D1 `meta.changes` interpretation and the
post-fix real upload E2E passed. Duplicate command/upload-id convergence is
**AUTOMATED PASS**; real Staging observed no duplicate provider side effect but
did not inject the same Telegram update twice.

Crisp-05 does **not** establish real 20 MiB-boundary behavior, large-file
multipart behavior, every media/file type, long-term R2 cleanup, proxy
HEAD/Range coverage, real D1/R2 outage injection, real high concurrency/load,
all Admin reliability operations, or Production.

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

Goal: add reviewed knowledge retrieval without coupling it to the helpdesk platform.

Phase 5 MVP:

- D1 is the canonical knowledge store.
- Knowledge entries have stable IDs, enabled/disabled state, optimistic versions and append-only mutation history.
- D1 FTS5 provides bounded full-text retrieval with multilingual search terms; no separate vector resource or embedding provider is required for the MVP.
- The latest customer text retrieves at most a small bounded set of enabled entries.
- Retrieved content is inserted into AI context as reference-only data with internal provenance and prompt-injection resistance.
- Retrieval failure safely falls back to the existing system prompt + recent conversation context.
- The private Telegram Admin Bot provides reviewed add/edit/enable/disable/delete workflows with update dedupe, short-lived sessions, confirmation where destructive and version-CAS mutation fencing.
- Automatic publication from operator replies is explicitly excluded from Phase 5 and remains Phase 6.

Later upgrade criteria:

- add semantic/vector retrieval only if measured FTS5 quality or corpus scale is insufficient;
- preserve the same provider-independent AI context interface;
- add retrieval-quality evaluation before claiming full RAG parity.

This MVP does not claim embedding/vector RAG or automatic learning.

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

## Crisp-12 - Legacy support UX parity

Status: **IMPLEMENTED IN PR #41 / EXACT-HEAD CI AND INDEPENDENT REVIEW REQUIRED BEFORE MERGE**

Scope is limited to Telegram customer-message notification policy by persisted pause source, separate Crisp human/AI display identities, the 100-rule bounded keyword configuration with Admin pagination, and trusted Telegram AI on/off controls. Migration 0008 preserves existing D1 data and expands only the Runtime Config plain-value capacity needed by the 100-rule bound.

No Staging deployment, Provider acceptance, Production change, knowledge-base work, Picker editing, Crisp-07/Crisp-08 work, historical replay or attachment cleanup is implied by code completion. Real UI acceptance remains gated by exact-head CI, independent Gemini review and Primary approval, and is specified in CRISP-12-STAGING-ACCEPTANCE.md.

## Single Telegram Bot Architecture

Status: **IMPLEMENTED / PRIMARY REVIEW REQUIRED / NOT DEPLOYED**

One Telegram Bot identity now serves two isolated contexts behind the existing authenticated Telegram webhook: authorized private chats enter Admin, and only the configured forum supergroup enters Support Topics. Unified Admin supports guarded online Bot identity rotation: after the candidate Bot and forum permissions are validated, confirmation creates a fresh webhook identity, activates the new `TELEGRAM_SUPPORT_PROFILE`, and retires the previous Support webhook without requiring a separate manual webhook refresh. Group migration, notification settings and safe webhook refresh remain available as independent recovery/configuration actions. The legacy Admin webhook remains for migration/rollback compatibility, and `TELEGRAM_SUPPORT_PROFILE` generation/version semantics remain unchanged to preserve Queue identity and stale-generation fencing. No D1 migration is added. Staging and Production switching remain separate Owner-authorized work.
