# CZ2128 - Phase 4B-5 Complete / Phase 4C In Execution

## Current Platform Direction

Owner selected Crisp as the sole active helpdesk target in Crisp-01. Chatwoot
implementation and historical state are preserved but must not receive new
feature work or be presented as Crisp validation. Phase 4C now has separately
bounded real-Staging evidence for Crisp-02 basic support, Crisp-03 AI/handoff,
Crisp-04 close/reopen lifecycle and Crisp-05 attachment/upload transport. The
isolated 4C staging Worker is deployed; Production remains outside these
acceptance results and has not been deployed by Crisp-02 through Crisp-06.

## 状态
- **Current Main before this documentation PR**: `d635520b1cde7a49e75ef5f658c862d5e856c5db` (PR #36 merge commit)
- **Phase 4B-5 Documentation Merge**: `d6e111cbf79e4a64a396c749d60821d6a5a6d7f8` (PR #15 merge commit)
- **Phase 4B-5 Implementation Base**: `62c7c51120ad4d44fcdc4cff089173258b719c28` (historical pre-PR #15 main)
- **Phase 1 Merge Commit / Main Base**: `61f9ad26bd2e06d0c91389434af17bdc85936e43`
- **Phase 2 Previous Head**: `46ff0001f9df319f32145f6429d5de6c2465bb1b`
- **PR #1**: merged
- **PR #2**: merged; Phase 2 complete and frozen
- **PR #3**: merged; Phase 3 complete and frozen
- **PR #4**: merged; Phase 3.5 complete and frozen
- **PR #9**: merged; Phase 4B-2C-2 complete and frozen
- **PR #10**: merged; Phase 4B-2C-3 complete and frozen
- **PR #11**: merged; Phase 4B-3 complete and frozen
- **PR #12**: merged; Phase 4B-4A complete and frozen
- **PR #13**: merged; Phase 4B-4B accepted, complete and frozen
- **PR #14**: merged; Phase 4B-4B post-merge documentation sync accepted
- **PR #15**: merged; Phase 4B-5 reliability runbook and readiness documentation accepted
- **PR #21**: merged; Crisp-01 basic Crisp support bridge complete
- **PR #27**: merged; Crisp-02 standard numeric fingerprint correlation; real Staging basic-support acceptance subsequently completed
- **PR #29**: merged; Crisp-03 durable Crisp AI delivery
- **PR #30**: merged; Crisp-03 handoff-state trigger gate follow-up
- **PR #31**: merged; Crisp-04 Crisp conversation close/reopen coordination
- **PR #32**: merged; Crisp-05 Stage A attachment bridge through private R2
- **PR #33**: merged; Crisp-05 Stage A Telegram file redirect fix
- **PR #34**: merged; Crisp-05 Stage B temporary customer upload invites
- **PR #35**: merged; Crisp-05 Stage B D1 trigger parser fix
- **PR #36**: merged as `d635520b1cde7a49e75ef5f658c862d5e856c5db`; trigger-inclusive D1 change-count fix; main CI #189 passed
- **Phase 4A**: reliability architecture complete and frozen
- **Phase 4B-1**: canonical error taxonomy and retry contracts complete
- **Phase 4B-2A**: reliability persistence foundation complete
- **Phase 4B-2A**: COMPLETE
- **Phase 4B-2B**: COMPLETE / FROZEN / MERGED
- **Phase 4B-2C-1**: COMPLETE / FROZEN / MERGED
- **Phase 4B-2C-2**: COMPLETE / FROZEN / MERGED
- **Phase 4B-2C-3**: COMPLETE / FROZEN / MERGED
- **Phase 4B-2C overall**: COMPLETE / FROZEN
- **Phase 4B-3**: COMPLETE / FROZEN / MERGED
- **Phase 4B-4A**: COMPLETE / FROZEN / MERGED
- **Phase 4B-4B**: ACCEPTED / COMPLETE / FROZEN / MERGED
- **Phase 4B-4 overall**: COMPLETE / FROZEN / MERGED
- **Phase 4B-5**: ACCEPTED / COMPLETE / FROZEN / MERGED
- **Phase 4C**: IN EXECUTION — isolated staging foundation deployed; bounded Crisp-02, Crisp-03, Crisp-04 and Crisp-05 Staging evidence recorded; broader matrix rows and Production remain open
- **Final HEAD / CI**: 以最新 Merge & Freeze Return 和远端 `main` 为准，不在本文件保存自指 SHA。

## Phase 1 Reliability Baseline
- Provider ingress is authenticated before normalization into a version 1 typed Queue envelope.
- `event_receipts` uses `lease_until` and `claim_token` ownership fencing.
- `outbound_operations` uses deterministic identity, CAS, bounded attempts and `AMBIGUOUS` no-blind-resend semantics.
- Visible provider actions classify transport exceptions, HTTP 408 and HTTP 5xx as `AMBIGUOUS`; HTTP 429 is retryable.
- Conversation/topic mapping and `OPEN/CLOSED` lifecycle state are protected by D1 uniqueness and CAS.

## Phase 2 Scope
- Optional OpenAI-compatible provider.
- `ENABLED`, `PAUSED_OPERATOR` and `PAUSED_MANUAL` human handoff modes.
- Generation lease plus persistent `ai_handoff_epoch` cancellation boundary.
- Durable `ai_runs` keyed by stable customer trigger.
- Bounded, deterministic recent D1 context.
- Customer messages map to `user`, AI answers to `assistant`, and human operator replies to labeled `system` context so operator text is never represented as an AI answer.
- Telegram `/ai_on` and `/ai_off` controls through outbound operations.
- AI delivery to Chatwoot followed by an optional Telegram mirror.

## Known Reliability Boundary
- Third-party staging and real D1/Queue concurrency remain required before production acceptance.
- `AMBIGUOUS` visible delivery outcomes require Phase 4 reconciliation or manual inspection and are never blindly resent.
- Phase 4B-2C-1 now supplies internal reconciliation services, immutable outbound subject/target evidence and audited manual mark-delivered/cancel persistence. Historical `AMBIGUOUS` rows are not rewritten to `SENT`.
- Chatwoot reconciliation can confirm only an exact unique `source_id=cz2128:<operation_id>` after a bounded read-only `after`-cursor scan proves provider history exhaustion. It starts at `after=0`, advances with the largest returned valid message ID, and reads at most five pages of up to 100 messages. A full fifth page, invalid/non-advancing cursor, zero match, duplicate match, lookup failure or any Telegram operation remains ambiguous and never becomes an automatic resend opportunity.
- Chatwoot target evidence fingerprints the canonical full API base, including its base pathname, while keeping the raw URL absent. Message, attachment, candidate-validation and reconciliation requests share one URL builder. Reconciliation derives the current runtime identity internally and cannot be bypassed with caller-supplied old evidence.
- Existing attempted rows without target evidence are not backfilled from current runtime configuration. Only provably pre-request rows (`attempt_count=0`, `request_started_at IS NULL`, safely unsent status) may receive CAS backfill.
- OpenAI-compatible errors are persisted and logged only as bounded categories; raw provider bodies, exception text and API keys are not recorded.
- The AI durable retry state machine is COMPLETE / FROZEN / MERGED through Phase 4B-2C-3.
- Phase 4B-2C-2 now supplies internal manual retry child execution for `MESSAGE`, `ATTACHMENT` and Telegram conversation lifecycle operations. One parent has one deterministic direct child; the parent remains `AMBIGUOUS` and records `MANUAL_RETRY_CREATED`.
- Child creation, parent transition and the sanitized creation audit use one D1 batch. Duplicate callers locate the same child, while the existing outbound lease prevents two visible provider effects.
- Payload reconstruction is durable-state-only. Message text comes from `messages`; attachment bytes must be unexpired and retrievable from private R2 before the decision is consumed; topic creation uses the durable canonical fallback title.
- A dedicated domain-resolution service repairs attachment delivery and Telegram topic mapping/status after effective delivery. It is idempotent, CAS-safe and never invokes a provider action.
- Telegram conversation domain repair is fenced by the current effective support-group identity. Historical evidence for an old `BOT_GROUP_ID` cannot restore a cleared topic mapping or mutate close/reopen state after group migration; a same-group Support Bot rotation remains repair-compatible.
- `AI_RUN` manual retry is active only for a matching durable `SUCCESS` response and never regenerates AI. `CONTROL_ACK` remains rejected.
- AI generation is capped at three provider-boundary attempts. `attempt_count` advances only through an owned CAS immediately before `generateChatCompletion()`.
- Retryable AI failures persist `FAILED_RETRYABLE` plus `next_retry_at`; the third retryable failure becomes `RETRY_EXHAUSTED`. Non-retryable failures become `FAILED_FINAL`.
- Human handoff and stale-generation results use generation-owned CAS so an old generation cannot overwrite or mark a newer owner stale.
- Legacy `FAILED` remains accepted by migration `0005` for rolling deployment, but new runtime code does not emit it and lazily normalizes encountered rows.
- Effective Chatwoot AI delivery through `SENT`, `CONFIRMED_SENT`, `MANUAL_MARK_DELIVERED` or a sent manual child repairs one durable AI message without another provider action. Telegram mirror delivery alone does not add context.
- Phase 4B-3 Admin reliability exposure is COMPLETE / FROZEN / MERGED. Phase 4B-4A DLQ capture, terminal quarantine and inspection is COMPLETE / FROZEN / MERGED. Phase 4B-4B explicit AI durable-state recovery is ACCEPTED / COMPLETE / FROZEN / MERGED. Phase 4B-4 overall is COMPLETE / FROZEN / MERGED. Phase 4B-5 is ACCEPTED / COMPLETE / FROZEN / MERGED. Phase 4C is IN EXECUTION with separately bounded Crisp-02 basic-support, Crisp-03 AI/handoff, Crisp-04 lifecycle and Crisp-05 attachment/upload Staging evidence recorded; this does not activate `CONFIRMED_NOT_SENT` or close the broader pre-production matrix.

## Phase 4B-5 Documentation and Phase 4C Evidence
- Operational state and incident handling: [RELIABILITY-RUNBOOK.md](RELIABILITY-RUNBOOK.md)
- Migration, backup and recovery boundaries: [MIGRATION-RECOVERY.md](MIGRATION-RECOVERY.md)
- Phase 4C evidence gates: [PREPRODUCTION-ACCEPTANCE.md](PREPRODUCTION-ACCEPTANCE.md)
- Historical inventory plus current non-sensitive staging reconciliation: [STAGING-READINESS.md](STAGING-READINESS.md)
- Historical foundation deployment gates plus current deployment snapshot: [STAGING-DEPLOYMENT.md](STAGING-DEPLOYMENT.md)
- Documentation records prior authorized execution; it does not itself authorize another deployment, provisioning action, Provider message or acceptance run.

## Phase 3 Attachment Contract
- Private R2 binding: `ATTACHMENTS_BUCKET` / bucket `cz2128-attachments`.
- 20 MiB per attachment, ten attachments per provider message, 24-hour business TTL.
- Source-to-R2 uses bounded multipart chunks; provider delivery uses one bounded single-file buffer at a time.
- Chatwoot downloads use exact HTTPS allowlists, manual redirects and cross-origin credential stripping.
- Secure proxy supports GET, HEAD and single byte ranges with uniform 404 access failures.
- Hourly cleanup removes at most 100 expired rows after R2 deletion succeeds.
- Broader real R2 proxy/cleanup and historical Chatwoot compatibility validation remain required. Telegram has scoped Crisp real-Staging evidence, but complete attachment/media, bot-rotation/group-migration and concurrency/fault coverage remains incomplete.

## Pre-Production Requirements
- Real Cloudflare R2: write, multipart, read, Range and delete.
- Real Telegram: `getFile` plus multipart `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio` and `sendVoice`.
- Historical Chatwoot compatibility: attachment `data_url` download/redirect behavior and multipart `attachments[]` remain unvalidated. Crisp-05 now supplies separate scoped Crisp attachment/upload evidence, but Stage A paste-vs-drag UX, human-observed Crisp Markdown render/Stage A download, proxy HEAD/Range, 20 MiB/large-file multipart, long-term cleanup/lifecycle, real R2/D1 faults and high concurrency remain unvalidated.
- Secure proxy: GET, HEAD, Range and response headers in staging.
- Cleanup: hourly scheduled trigger and R2-before-D1 deletion behavior.
- Real Queue/D1 concurrency and 20 MiB `ArrayBuffer` -> `Blob` -> `FormData` memory/load behavior.
- Apply and verify the seven-day R2 object/aborted-multipart lifecycle.
- Residual risks include DNS rebinding through an explicitly trusted allowlisted DNS hostname and an extreme R2 I/O stall outliving the attachment event receipt lease.

## Current Crisp Staging Acceptance Snapshot

- **Crisp-02:** scoped real basic-support bridge, Picker, numeric fingerprint self-echo suppression and Picker-driven handoff accepted.
- **Crisp-03:** real AI happy-path delivery plus Telegram mirror observed at attempt 1; handoff trigger defect was preserved, fixed by PR #30, and post-fix paused customer traffic produced no new AI run.
- **Crisp-04:** Crisp close/reopen was observed on the same original Telegram Topics 89 and 95, with one CREATE_TOPIC per conversation and lifecycle sends at HTTP 200 / attempt 1.
- **Crisp-05 Stage A:** retained Topic 103 evidence contains one Crisp image delivered to Telegram, two pre-hotfix Telegram-source failures, and post-hotfix Telegram image/file provider delivery to Crisp. The record does not prove paste-vs-drag gesture identity, human-observed Crisp Markdown rendering, or a Stage A download click.
- **Crisp-05 Stage B:** Primary accepted the Topic 117 ordinary-file flow at Worker version `4d13f217-bd80-4c7c-a6bf-8ed13669be77`: 11,272-byte `kefu.txt` upload, private R2 persistence/readback, Telegram controlled download, real download success, TTL expiry/Not Found, explicit revoke, no AI run and no duplicate topic. The historical three HTTP-409 `FAILED_FINAL / UPLOAD_INVITE_LIMIT_EXCEEDED` rows remain preserved.
- **Duplicate evidence boundary:** command/upload-id duplicate convergence is AUTOMATED PASS. Real Staging observed no duplicate provider side effect but did not inject the same Telegram update twice.
- **Production:** NOT DEPLOYED / NOT VALIDATED by these Crisp tasks.

## Phase 3.5 Runtime Control Plane
- `runtime_config` stores plain overrides or AES-256-GCM encrypted secrets with optimistic versions.
- `runtime_config_history` is append-only; rollback creates a new version and never reveals secret values.
- Missing overrides use env fallback; present but invalid encrypted overrides fail closed.
- One coherent snapshot is resolved per support HTTP request, Admin request or Queue event.
- Admin ingress requires its bootstrap path, webhook secret, private chat and exact positive Telegram user-ID allowlist.
- Admin sessions expire after ten minutes and `admin_update_receipts` makes mutations idempotent by `update_id`.
- Support Bot rotation creates a new token/path/secret profile and group migration clears old topic mappings atomically.
- The Support profile version scopes Queue/event/message/outbound identity and `(profile version, update_id)` ordering; old-generation Queue events cannot perform side effects.
- Runtime-config store read failure fails closed for runtime-controlled providers; env fallback requires a successful D1 read proving absence.
- Support Bot rotation requests `drop_pending_updates=true` when setting the candidate webhook.
- The Cloudflare R2 account is enabled and Crisp-05 supplies bounded real private-object write/read evidence, but full R2 staging remains incomplete: max-size multipart, proxy HEAD/Range/delete, scheduled cleanup and long-lived lifecycle execution remain pending.
- Real Admin Bot reliability operations, Support Bot rotation, Telegram group migration, remaining Telegram provider operations beyond the scoped Crisp flows, historical Chatwoot compatibility and real Queue/D1 concurrency validation remain NOT TESTED.
- Phase 4B-2C-3 adds no `0006`, Admin reliability UI/commands, DLQ consumer, `CONFIRMED_NOT_SENT` activation or Durable Objects. Production provider/load validation remains NOT TESTED.

## Phase 4B-3 Reliability Control Plane
- Reuses the separate private Telegram Admin Bot, exact administrator allowlist, secret webhook path/token, update-receipt idempotency and expiring Admin sessions.
- Manual reconciliation, mark-delivered, cancel and deterministic manual-retry child operations are active through the frozen core services; the Admin layer does not perform direct reliability-state SQL mutations.
- CREATE_TOPIC mark-delivered requires a bounded positive safe-integer provider/thread reference stored only in session state before final confirmation.
- AI Reliability is read-only. No AI generation mutation control was added.
- No Web Admin, public reliability API, new authentication system, migration `0006`, Durable Object or `CONFIRMED_NOT_SENT` activation was added.

## Phase 4B-4A DLQ Capture and Inspection
- The same Worker consumes `cz2128-queue` and `cz2128-dlq`, discriminated only by `batch.queue`; the frozen main queue behavior is unchanged.
- D1 is canonical. Raw DLQ bodies remain in memory only; D1 stores deterministic hashed identities and bounded sanitized metadata through the existing `0005` schema.
- If D1 capture fails, the dedicated private `DLQ_QUARANTINE` R2 bucket stores one deterministic allowlisted terminal evidence object. It is not a replay source or canonical state.
- ACK occurs only after D1 or quarantine persistence succeeds. If both fail, Queue retry remains required; simultaneous persistent D1/R2 failure plus retry exhaustion remains a residual loss risk.
- Capture-side SQL and canonical completion-side metadata updates converge PROCESSED/RESOLVED in either commit order. OPEN may become RESOLVED; RESOLVED never regresses.
- The private Admin Bot adds bounded read-only D1 receipt and validated R2 custom-metadata views; it never reads quarantine object bodies.
- Real local Wrangler/workerd D1 tests execute two complete concurrent capture calls. They do not prove production multi-region scheduling, load limits or simultaneous platform availability.
- Phase 4B-4A itself remains frozen; its capture and quarantine paths still perform no redrive/replay/resend action.

## Phase 4B-4B Explicit Durable-State AI Recovery
- Only OPEN D1 `internal / ai_trigger` receipts can expose Redrive AI. External messages, lifecycle events, `attachment_transfer` and quarantine evidence remain inspection-only.
- `src/core/dlq-ai-redrive.ts` is authoritative for eligibility and request execution. It reconstructs the exact original event from the receipt identity, canonical conversation, newest durable Chatwoot customer text, matching `ai_runs`, reclaimable `event_receipts` and safe outbound state.
- Eligible runs are due `FAILED_RETRYABLE` with `attempt_count < 3`, or `SUCCESS` with durable response text. AI attempt history is never reset and SUCCESS never regenerates content.
- Retry reclaim now requires `ai_runs.handoff_epoch` to equal the current lease epoch inside the D1 CAS. A newer handoff epoch permanently fences old work, including AI OFF then ON. Retryable old work becomes `CANCELLED_BY_HANDOFF`; historical SUCCESS remains SUCCESS and performs no revived delivery.
- Normal fresh AI processing prepares `ai_reply:<eventId>` and immutable Chatwoot target evidence before the AI provider boundary. Historical recovery requires that operation to exist and never backfills it from current configuration. Legacy missing-evidence receipts are ineligible.
- Recovery rechecks newest durable customer text at consumer entry, successful generation persistence and immediately before each historical provider call. Newer-message retryable work becomes `DISCARDED_STALE`; historical SUCCESS remains truthful but is not delivered stale.
- Provider-visible recovery permits only safe states with matching stored target evidence. Chatwoot `SENT` converges without resend. A missing historical Telegram mirror is skipped after Chatwoot delivery; a matching existing mirror may continue, while target drift is terminated without a mirror send. `SENDING`, `AMBIGUOUS`, `FAILED_FINAL`, exhausted/not-due retries and malformed evidence remain blocked. Manual Retry remains the only duplicate-risk resend workflow.
- Freshness abandonment converges safe PENDING and durable observed-429 retryable AI operations to `FAILED_FINAL / DISCARDED_STALE` through identity/evidence/state-fenced D1 updates. Each actual change has one deterministic audit; attempts and provider request/response evidence are retained. SENT/final rows remain immutable. SENDING, AMBIGUOUS, malformed evidence or lost CAS ownership abort canonical completion and keep the DLQ OPEN.
- Human handoff uses the same bounded convergence with `CANCELLED_BY_HANDOFF` and `AI_HANDOFF_CANCELLED` audit semantics. Historical no-send cleanup requires valid stored evidence but does not require it to equal a later current Chatwoot/Telegram mapping. Fresh generation retirement distinguishes handoff from owner replacement; only true abandonment cleans the operation, so a late Generation A cannot damage Generation B.
- SENT is accepted only with a bounded non-empty provider message reference during initial abandoned-work scans and CAS-lost reloads. Malformed SENT is not rewritten, but blocks provider-free domain repair and DLQ resolution. Existing FAILED_FINAL remains preserved as non-delivery terminal truth.
- Admin inspection shows the action only when the core service reports eligibility. Redrive requires an expiring confirmation, revalidates on confirmation, writes one deterministic `DLQ_RECEIPT / DLQ_REDRIVE_REQUESTED` intent audit per Admin update, then sends the exact event through the existing main Queue.
- Same-update execution is deduplicated by both `admin_update_receipts` and deterministic audit identity. Distinct commands may enqueue identical physical events; existing event/run/generation/outbound identities keep processing safe.
- DLQ receipts remain OPEN after a request and become RESOLVED only through canonical event completion. No migration `0006`, outbox, new Queue, Durable Object, KV correctness state, public API, Web Admin, new auth or production resource change was added.
- Local Wrangler/workerd evidence covers complete concurrent same-command requests, distinct-command identical enqueue, handoff fencing and outbound convergence, mapping drift, missing target evidence, endpoint drift, consumer-time message freshness, mirror convergence and concurrent audit dedupe on real local D1. This is not production multi-region/load/outage proof.
- Independent Gemini Final Delta Review passed before Phase 4B-4B acceptance, merge and freeze.

### NON-BLOCKING 4B-4A DEBT
3. The Admin quarantine list reads one bounded R2 page. Above 1000 quarantine objects, its displayed 10 entries are not guaranteed to be globally newest. Classification: LOW / NON-BLOCKING / OBSERVABILITY ONLY. Defer to pre-production / Phase 4C unless operational evidence requires earlier work.

### NON-BLOCKING TEST DEBT
1. Add an explicit relative-order assertion for the recent uncertain-delivery list.
2. Add explicit `child.status == SENT` assertions in the dedicated MESSAGE and ATTACHMENT Admin manual-retry success tests.

These optional test-strength improvements are not runtime defects and are not Phase 4B-4 requirements.