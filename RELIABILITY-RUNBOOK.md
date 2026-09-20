# CZ2128 Reliability Operations Runbook

Status: **PHASE 4B-5 IN IMPLEMENTATION / NOT ACCEPTED / NOT FROZEN / NOT MERGED**

Frozen Phase 4B-4B runtime baseline: `8499a5d4eaa40d4461d1882aaf6f4e2ac93efa08`

Phase 4B-5 documentation baseline: `62c7c51120ad4d44fcdc4cff089173258b719c28`

This runbook describes the operations that the frozen CZ2128 runtime actually supports. It does not authorize a deployment, a production mutation, a provider-visible retry, an Admin action, or a data restore. Production remains **NOT DEPLOYED** and the production `DLQ_QUARANTINE` resource remains **NOT PROVISIONED / NOT VALIDATED**.

Related documents:

- [Migration, Backup and Recovery](MIGRATION-RECOVERY.md)
- [Pre-Production Acceptance Matrix](PREPRODUCTION-ACCEPTANCE.md)
- [Architecture](ARCHITECTURE.md)
- [Decisions](DECISIONS.md)

## 1. Authority and Safety Model

Use this order when facts disagree:

1. Current Git commit, deployed runtime identity and platform state.
2. D1 canonical application state.
3. Immutable outbound subject and target evidence, provider request/response evidence and reliability audit.
4. Provider-side evidence obtained through an approved read-only reconciliation path.
5. Documentation and incident notes.

Never infer a provider side effect from Queue delivery, an Admin success message, a DLQ state, an AI `SUCCESS` row, or a changed domain row alone.

The following contracts are frozen:

- Cloudflare Queues are at-least-once. Duplicate physical delivery is expected.
- D1 is canonical application state.
- R2 terminal quarantine is sanitized fault evidence, not canonical state and not a replay source.
- `AMBIGUOUS` is not automatically resent.
- Manual Retry creates or resumes a deterministic child operation after explicit duplicate-risk confirmation. It does not rewrite the ambiguous parent.
- `SENT` is not verified by sending again. Historical AI convergence accepts `SENT` only with a bounded non-empty provider reference.
- Malformed `SENT`, active `SENDING`, target conflicts and unknown evidence fail closed.
- `FAILED_FINAL` is terminal for automatic and historical recovery.
- `CONFIRMED_NOT_SENT` is present only as a reserved schema value. It is not active.
- A zero-result Chatwoot search and all Telegram ambiguity remain uncertain.
- AI generation has at most three provider-boundary attempts. A durable `SUCCESS` is reused and never regenerated to repair delivery.
- Historical redrive is limited to eligible `internal / ai_trigger` D1 receipts and historical durable target evidence.
- Human handoff, newest-customer-message freshness and generation ownership are rechecked before provider-visible historical work.
- `DLQ OPEN` means unresolved durable evidence, not permission to resend.
- `DLQ RESOLVED` follows canonical event completion; an Admin redrive request alone does not resolve it.

## 2. Evidence Levels

| Evidence level | What it proves | What it does not prove |
| --- | --- | --- |
| Unit/SQLite | Deterministic service and state-machine behavior in a process-local test | Cloudflare scheduling, provider behavior or production availability |
| Wrangler/workerd local D1/R2 | Complete service calls against local Cloudflare-compatible bindings | Multi-region ordering, production load or platform outage behavior |
| GitHub CI | The exact commit passes clean migrations, typecheck, lint and automated tests | Staging or production behavior |
| Staging | Behavior against isolated real resources for the tested configuration and time | Production capacity, all outage modes or future configuration |
| Production | Observed production behavior at a recorded commit/configuration/time | Untested paths or a permanent guarantee |

Never promote evidence to a stronger level in an incident report.

## 3. Runtime Dependencies and Normal Signals

| Dependency | Normal role | Existing operational signal | Known limitation |
| --- | --- | --- | --- |
| D1 `DB` | Canonical conversations, messages, receipts, AI runs, outbound operations, configuration and audit | Authenticated Admin Reliability summaries and authorized read-only platform inspection | No independent health endpoint is implemented |
| `cz2128-queue` | Main asynchronous event processing | Cloudflare Queue metrics plus event receipt/outbound state | Repository config allows three main-queue retries before `cz2128-dlq` |
| `cz2128-dlq` | DLQ capture input | D1 `dlq_receipts` or sanitized R2 quarantine evidence | No generic replay and no explicit DLQ-consumer retry count is configured in this repository |
| `ATTACHMENTS_BUCKET` | Private temporary attachment bytes | D1 attachment metadata plus authorized R2 inspection | D1 and R2 are not one atomic transaction |
| `DLQ_QUARANTINE` | Fallback terminal evidence when D1 capture fails | Admin metadata-only list when Admin/D1 is available | Production resource is not provisioned or validated; list is one bounded R2 page |
| Chatwoot | Helpdesk ingress and delivery | Signed ingress, outbound evidence and bounded positive reconciliation | Zero matches cannot prove not sent |
| Telegram | Operator channel and Admin Bot | Authenticated webhook, generation-scoped identity and outbound ledger | No trustworthy generic historical lookup for ambiguous sends |
| AI provider | Optional generation | `ai_runs`, finite error code, attempt count and retry deadline | A pre-provider crash after attempt CAS may consume an attempt |

The Admin Reliability page exposes bounded counts and lists for unresolved ambiguity, automatic retry state, AI failures, audits, D1 DLQ receipts and quarantine metadata. It is an operational view, not a complete export or monitoring system.

## 4. State Interpretation

### 4.1 Event and DLQ Receipts

| State | Meaning | Operator rule |
| --- | --- | --- |
| Event `PROCESSING` | A worker owns a lease | Do not create another provider action; wait for the lease or investigate a stuck lease |
| Event `PROCESSED` | Canonical event completion committed | Duplicate Queue delivery is a no-op; matching D1 DLQ evidence converges to `RESOLVED` |
| Event `FAILED` | Processing did not complete | Let Queue policy run; inspect safe error and downstream durable state before any manual action |
| DLQ `OPEN` | Captured event has not reached canonical `PROCESSED` | Inspection only unless the Admin Bot reports eligible AI redrive |
| DLQ `RESOLVED` | Canonical event completion was observed | Do not redrive |
| Quarantine `QUARANTINED` | D1 receipt persistence failed and sanitized R2 evidence was stored | Preserve metadata; there is no import or replay path |

### 4.2 Outbound Operations

| State | Meaning | Allowed handling |
| --- | --- | --- |
| `PENDING` | Durable operation exists but is not currently sending | Normal runtime may claim it; operators do not manually change it |
| `SENDING` | A lease owner may be at or beyond the provider boundary | Wait or stop; never manually resend. Expired started/legacy leases become `AMBIGUOUS` through runtime logic |
| `SENT` | Runtime persisted provider delivery evidence | Do not resend. If provider reference is malformed, historical convergence fails closed |
| `FAILED_RETRYABLE` | Current frozen visible-send path uses bounded 429 evidence and a retry deadline | Let the same operation retry after `next_retry_at`; do not create an ad hoc send |
| `FAILED_FINAL` | Terminal non-delivery or safely abandoned work | No automatic or historical revival; escalate if business recovery is required |
| `AMBIGUOUS` | Provider-visible effect is uncertain | Reconcile, mark delivered, cancel, or explicitly accept duplicate risk through Manual Retry |

Reconciliation state supplements but does not rewrite `AMBIGUOUS` history:

- `PENDING` / `STILL_AMBIGUOUS`: unresolved.
- `CONFIRMED_SENT`: exact bounded positive evidence confirmed delivery.
- `MANUAL_MARK_DELIVERED`: an authorized operator supplied independent positive evidence.
- `MANUAL_CANCELLED`: no further CZ2128 send; it does not mean the provider did not deliver.
- `MANUAL_RETRY_CREATED`: one deterministic child owns the new duplicate-risk attempt.
- `CONFIRMED_NOT_SENT`: inactive; never select or infer it.

### 4.3 AI Runs

| State | Meaning | Operator rule |
| --- | --- | --- |
| `PENDING` | Generation ownership exists or is reclaimable under CAS/lease rules | Do not call the AI provider manually |
| `SUCCESS` | Durable response text exists | Reuse it for supported delivery recovery; never regenerate it |
| `FAILED_RETRYABLE` | Due/not-due state with attempts remaining | Respect `next_retry_at` and the three-attempt total budget |
| `RETRY_EXHAUSTED` | Three provider-boundary attempts are consumed | Terminal; human service continues |
| `FAILED_FINAL` | Non-retryable generation failure | Terminal; no historical revival |
| `CANCELLED_BY_HANDOFF` | Human/manual handoff won | Do not revive old work after AI is re-enabled |
| `DISCARDED_STALE` | Newer customer state or ownership made the result stale | Do not deliver the old answer |
| Legacy `FAILED` | Rolling-deploy compatibility only | New runtime normalizes it conservatively; operators do not rewrite it |

## 5. Verified Read-Only Diagnostics

These commands were verified against the repository's Wrangler `4.131.1` help. They are read-only at the platform level, but still require an authorized Cloudflare profile and the correct environment/config. Confirm the account, environment and resource name before running them. Do not paste raw output containing identifiers into public issues.

```bash
git status --short
git rev-parse HEAD
npx wrangler d1 info <d1-database-name> --json
npx wrangler d1 migrations list <d1-database-name> --remote
npx wrangler d1 time-travel info <d1-database-name> --timestamp <rfc3339> --json
npx wrangler queues info <main-queue-name>
npx wrangler queues info <dlq-name>
npx wrangler r2 bucket info <attachments-bucket> --json
npx wrangler r2 bucket info <dlq-quarantine-bucket> --json
npx wrangler r2 bucket lifecycle list <attachments-bucket>
```

`wrangler.toml` contains a local-only D1 database ID. A remote command must use a separately reviewed environment/config that resolves the intended remote resource. Do not edit the repository config during an incident merely to make a diagnostic command work.

No repository command provides a complete safety verdict. Correlate the exact code SHA, runtime configuration generation, Queue information, D1 state, Admin audit and provider evidence.

## 6. Incident Procedure: Queue Retries and DLQ Growth

**Detect**

- Cloudflare reports retries/backlog, or the Admin Reliability page shows new/open DLQ receipts.
- Logs contain finite Queue errors or repeated event identities.

**Preconditions**

- Record exact runtime SHA, environment and incident time window.
- Confirm whether the affected queue is `cz2128-queue` or `cz2128-dlq`.
- Inspect canonical D1 and outbound state before considering any provider-visible action.

**Allowed Actions**

- Use Queue information, sanitized logs, Admin DLQ lists/details and reliability audit.
- Allow normal main-queue retry and the configured main-queue-to-DLQ transition.
- For an OPEN D1 receipt, use AI redrive only if the Admin Bot reports `ELIGIBLE` and separate incident authorization approves it.

**Forbidden Actions**

- Do not purge a queue, inject a replacement event, resend provider content, replay every DLQ entry or edit event receipts directly.
- Do not treat `DLQ OPEN`, retry exhaustion or a repeated Queue message as proof that no provider side effect occurred.
- Do not replay quarantine evidence.

**Stop Conditions**

- D1 and R2 quarantine are both unavailable.
- Event/outbound identity is missing, contradictory or points to active `SENDING`/`AMBIGUOUS` work.
- A proposed action requires generic replay or a provider send outside an existing Admin workflow.

**Evidence to Preserve**

- Queue name, bounded message/event identity, attempt count, safe error code, first/last seen times, receipt status and related operation IDs.
- Relevant sanitized logs and reliability audit IDs. Do not preserve raw Queue bodies in incident tickets.

**Recovery / Escalation**

- Restore the failed dependency first. Let canonical processing converge normal events.
- Escalate quarantine-only evidence because automatic D1 import is **NOT IMPLEMENTED**.
- Queue pause/resume **REQUIRES SEPARATE AUTHORIZATION**. Queue purge is **OPERATOR STOP** and is not a recovery method.

**Verification of Recovery**

- Queue retry/backlog trend stabilizes.
- Affected event receipts reach `PROCESSED` or remain explicitly failed for manual review.
- Matching D1 DLQ receipts converge to `RESOLVED`; quarantine-only objects remain evidence, not proof of canonical recovery.

## 7. Incident Procedure: D1 Unavailable or Inconsistent

**Detect**

- Safe errors include D1 read/write/result persistence or runtime-config read failure.
- Admin actions fail because Admin update/session/audit state is D1-backed.
- DLQ capture falls back to `DLQ_QUARANTINE` when available.

**Preconditions**

- Confirm this is D1 failure rather than invalid credentials, provider failure or a wrong Cloudflare account/environment.
- Record code SHA, migration files and read-only D1/Time Travel information if available.

**Allowed Actions**

- Use read-only platform diagnostics and preserve sanitized logs.
- Let Queue retry; D1-backed runtime configuration fails closed instead of silently reactivating old env credentials.
- Review [Migration, Backup and Recovery](MIGRATION-RECOVERY.md) before any restore discussion.

**Forbidden Actions**

- Do not issue direct `UPDATE`/`DELETE`, reset receipts, clear leases, recreate outbound rows, mark operations `SENT`, or copy R2 quarantine into D1.
- Do not use Admin mutation flows while D1 health is uncertain.
- Do not deploy older code merely because D1 reads fail.

**Stop Conditions**

- Schema/version cannot be proven, Time Travel target is uncertain, Queue delivery is active during a proposed restore, or provider side effects may have occurred after the restore point.
- D1 and R2 evidence disagree and no immutable operation identity resolves the conflict.

**Evidence to Preserve**

- Exact SHA, migration inventory, D1 database identity/state, Time Travel bookmark information, Queue state, audit IDs and the incident timeline.
- Keep exports encrypted and access-controlled; they can contain customer messages and encrypted configuration material.

**Recovery / Escalation**

- Routine D1 recovery automation is **NOT IMPLEMENTED**.
- Time Travel restore, export/import, Queue delivery control and code rollback **REQUIRE SEPARATE AUTHORIZATION** and a reviewed recovery plan.

**Verification of Recovery**

- D1 reads succeed, migrations `0001`-`0005` are compatible, runtime configuration resolves, Admin read surfaces work and normal Queue processing converges without new ambiguity.
- Verify R2 and provider evidence separately; D1 recovery does not restore either one.

## 8. Incident Procedure: Attachment R2 Failure

**Detect**

- Safe errors report R2 store/read/delete failures, missing object or attachment retry exhaustion.
- Attachment remains non-delivered or scheduled cleanup logs `R2_DELETE_TRANSIENT`.

**Preconditions**

- Distinguish `ATTACHMENTS_BUCKET` from `DLQ_QUARANTINE`.
- Confirm D1 attachment identity, expiry, state and destination without exposing access tokens or object bytes.

**Allowed Actions**

- Use read-only bucket information and D1/Admin metadata.
- Let automatic source/store retries run within their existing policy.
- Use Manual Retry for an ambiguous attachment only when it is still unexpired, retrievable and target evidence matches; this requires explicit duplicate-risk authorization.

**Forbidden Actions**

- Do not create replacement R2 keys, extend expiry, expose private objects, copy bearer tokens, delete D1 rows first or resend an ambiguous attachment outside Manual Retry.

**Stop Conditions**

- Object is missing/expired, target changed, provider delivery is ambiguous, or D1 and R2 identity cannot be correlated.

**Evidence to Preserve**

- Attachment ID, anonymous storage key, status, expiry, safe error, destination provider and related operation/audit IDs. Do not preserve bytes, original private URLs or access tokens.

**Recovery / Escalation**

- Missing/expired payload reconstruction is unavailable: **OPERATOR STOP**.
- R2 object restoration is **NOT IMPLEMENTED**.
- Cleanup retries naturally because D1 metadata is deleted only after R2 deletion succeeds.

**Verification of Recovery**

- R2 access succeeds, D1 state remains consistent and a supported delivery reaches effective delivery without another action on an already delivered operation.

## 9. Incident Procedure: DLQ Quarantine Failure

**Detect**

- DLQ capture logs show D1 receipt and terminal quarantine persistence both failed.
- The DLQ message is retried instead of acknowledged.

**Preconditions**

- Verify D1 and the dedicated quarantine bucket independently.
- Confirm production `DLQ_QUARANTINE` is actually provisioned before relying on it; current project status is NOT PROVISIONED / NOT VALIDATED.

**Allowed Actions**

- Preserve sanitized logs and read-only bucket metadata.
- Let the existing consumer retry after dual failure.

**Forbidden Actions**

- Do not store raw bodies manually, read quarantine object bodies through Admin, import objects into D1 or use them as Queue payloads.

**Stop Conditions**

- Both durable destinations remain unavailable or the platform retry boundary is unknown/exhausted.

**Evidence to Preserve**

- Queue identity, hashed quarantine/canonical receipt IDs, bounded attempts/timestamps, fixed reason/state and platform incident window.

**Recovery / Escalation**

- Quarantine import/redrive is **NOT IMPLEMENTED**.
- Persistent D1 + R2 + Queue retry exhaustion is an accepted residual loss boundary and requires incident escalation.

**Verification of Recovery**

- New DLQ messages are acknowledged only after D1 or quarantine persistence succeeds.
- D1 and R2 must be checked separately. Quarantine listing scans at most one 1000-object page, so displayed entries are not guaranteed globally newest when truncated.

## 10. Incident Procedure: Outbound Uncertainty

**Detect**

- Operation is `AMBIGUOUS`, or a started/legacy `SENDING` lease expires into ambiguity.
- Transport, HTTP 408/5xx, invalid success or result-persistence failure makes delivery uncertain.

**Preconditions**

- Use the exact operation ID and inspect subject, stored target evidence, provider/request timestamps, provider reference, reconciliation state and child link.
- Establish whether independent positive provider evidence exists.

**Allowed Actions**

- `Reconcile`: Chatwoot-only bounded read path; it may update reconciliation/audit and domain state after one exact unique `source_id` match.
- `Mark Delivered`: only with independent positive delivery evidence; `CREATE_TOPIC` also requires the real positive thread/provider reference.
- `Cancel`: stops further CZ2128 action but does not assert that the provider did not deliver.
- `Manual Retry`: only after explicit `OPERATOR_ACCEPTS_DUPLICATE_RISK`; it may perform a new provider-visible action through a deterministic child.

**Forbidden Actions**

- Do not resend the parent, reset it to `PENDING`, convert zero matches to `CONFIRMED_NOT_SENT`, or infer Telegram non-delivery.
- Do not mark delivered from customer expectation, elapsed time, changed conversation state or missing local domain repair alone.

**Stop Conditions**

- Target evidence is missing/invalid/changed, multiple children exist, payload is unavailable, provider history is incomplete, or another operator/CAS wins.

**Evidence to Preserve**

- Parent and child operation IDs, immutable subject/target evidence, finite status/error fields, reconciliation/audit results and positive provider reference if available.

**Recovery / Escalation**

- Prefer positive reconciliation or Mark Delivered when evidence exists.
- If no safe conclusion exists, preserve `AMBIGUOUS` and escalate. Manual Retry is a business risk decision, not technical proof of non-delivery.

**Verification of Recovery**

- Parent remains historical `AMBIGUOUS`.
- Resolution/audit is single and deterministic; effective delivery repairs only compatible domain state.
- Any Manual Retry has exactly one deterministic child and never automatically resends an ambiguous/final child.

## 11. Incident Procedure: Bounded 429 Retry

**Detect**

- Visible outbound operation is `FAILED_RETRYABLE` with `OUTBOUND_RATE_LIMITED`, bounded `next_retry_at`, durable request-start and observed HTTP 429 evidence.
- AI run is `FAILED_RETRYABLE` with attempts remaining and a retry deadline.

**Preconditions**

- Confirm the same deterministic identity, target evidence, attempt count and deadline.
- For historical stale/handoff cleanup, the frozen predicate additionally requires no provider reference/lease, `NOT_REQUIRED` reconciliation, durable request/response timestamps, `response_http_status=429`, and `OUTBOUND_RATE_LIMITED`.

**Allowed Actions**

- Allow the existing operation/run to retry after its deadline and within its three-attempt budget.
- Let historical stale/handoff convergence close only rows satisfying the exact durable predicate.

**Forbidden Actions**

- Do not create a replacement send, shorten the deadline, reset attempts or treat arbitrary provider 429 behavior as proof that no side effect occurred.
- Do not generalize the project's predicate to another provider, status or malformed evidence.

**Stop Conditions**

- Missing/contradictory timestamps, non-429 response, provider reference, active lease, target drift, exhausted budget or concurrent state change.

**Evidence to Preserve**

- Attempt count, request/response timestamps, HTTP status, error code, retry-after, next retry time, target evidence and audit.

**Recovery / Escalation**

- Let normal runtime own the retry. Unsafe evidence remains unresolved or fails closed.

**Verification of Recovery**

- No early or fourth attempt occurs; final state is `SENT`, `FAILED_FINAL`, `AMBIGUOUS`, or the correct handoff/stale terminal state.

## 12. Incident Procedure: AI Failure, Handoff or Stale Work

**Detect**

- Admin AI Reliability shows retryable, exhausted, final, handoff-cancelled or stale-discarded runs.
- Logs/audit show generation ownership, handoff epoch or latest-message fencing.

**Preconditions**

- Correlate trigger event, conversation, trigger message, generation ID, handoff epoch, attempt count and outbound operations.

**Allowed Actions**

- Let due retryable runs continue within the three-attempt budget.
- Preserve and reuse durable `SUCCESS` for supported delivery continuation.
- Let human handoff and newer customer text win.
- Use the private Admin Bot's read-only AI Reliability view for inspection.

**Forbidden Actions**

- Do not regenerate durable `SUCCESS`, reset attempts, deliver stale text, revive an old handoff epoch or manually alter generation ownership.

**Stop Conditions**

- Ownership changed, AI is paused, handoff epoch differs, trigger is not newest, run is terminal, or outbound evidence is missing/conflicting.

**Evidence to Preserve**

- Trigger/event identity, run status, attempts/deadline/error, generation/epoch, latest durable customer message identity and related outbound/audit IDs. Do not copy AI/customer text into incident metadata unless separately authorized.

**Recovery / Escalation**

- Human support remains the fallback. Terminal/exhausted AI failure requires product/operations review, not an ad hoc provider call.

**Verification of Recovery**

- At most three provider-boundary attempts occurred; no stale/handoff result was delivered; durable success was reused rather than regenerated.

## 13. Incident Procedure: Confirmed Historical AI Redrive

**Detect**

- An OPEN D1 DLQ receipt displays `AI redrive: ELIGIBLE` in the authenticated Admin Bot.

**Preconditions**

- Receipt is exactly `internal / ai_trigger`; canonical conversation/customer message, matching AI run, event receipt and historical Chatwoot operation/evidence all exist.
- AI is enabled; handoff epoch/freshness/ownership are valid; attempts and deadlines are eligible.
- Separate incident authorization approves a provider-visible recovery path.

**Allowed Actions**

- Begin `Redrive AI`, review the exact receipt/event shown by Admin, then use the action-specific confirmation.
- After request, monitor the same receipt, event/run/outbound state and audit.

**Forbidden Actions**

- Do not redrive quarantine evidence, non-AI events, resolved receipts, missing historical operations, target drift, `AMBIGUOUS`, `FAILED_FINAL`, malformed `SENT` or exhausted/not-due work.
- Do not substitute current Chatwoot/Telegram configuration for historical target evidence.
- Do not assume `AI redrive requested` means provider delivery.

**Stop Conditions**

- Admin reports any ineligible reason; state changes before confirmation; new customer text/handoff/config/operation state appears; Queue send or canonical processing fails.

**Evidence to Preserve**

- Receipt ID, eligibility reason, event/run/outbound identities, Admin update ID, `DLQ_REDRIVE_REQUESTED` audit, Queue outcome and final canonical state. Exclude raw message and AI text.

**Recovery / Escalation**

- Same Admin update is deduplicated; a distinct command may enqueue the same logical event. Do not issue another command without reviewing current canonical state.
- `AMBIGUOUS` remains under reconciliation/manual workflows, never historical redrive.

**Verification of Recovery**

- Canonical event becomes `PROCESSED`, D1 DLQ receipt becomes `RESOLVED`, durable success is not regenerated, and visible operations remain duplicate-safe.

## 14. Escalation and Operator Stop Standard

Stop all mutation and escalate when any of the following is true:

- Exact runtime SHA, environment or resource identity is unknown.
- D1 schema is not proven compatible with runtime code.
- An action would overwrite/delete D1, purge Queue, delete R2 evidence, read quarantine bodies or replay a raw payload.
- Provider effect is uncertain and no frozen reconciliation/manual workflow applies.
- Historical target evidence is absent, malformed or conflicts with current target.
- More than one manual-retry child exists or state/audit CAS results disagree.
- D1, R2, Queue and provider evidence cannot be reconciled.
- Proposed recovery depends on `CONFIRMED_NOT_SENT`, generic DLQ replay, an outbox, a Durable Object or another unimplemented feature.
- A production/staging action lacks explicit environment-specific authorization.

Required escalation package:

- Incident time window and environment.
- Exact Git/deployed SHA and migration inventory.
- Sanitized finite error codes and operation/receipt/audit identities.
- Current status, attempt/deadline/lease fields and target-evidence validity result.
- Queue/D1/R2/provider observations, each labeled by evidence level.
- Proposed action, provider-visible/data-loss risk and explicit approval owner.

## 15. Known Residual Risks

- Persistent simultaneous D1/R2 failure plus Queue retry exhaustion can lose terminal DLQ evidence.
- A crash after the AI attempt-start CAS but before provider fetch can conservatively consume an attempt.
- Third-party exactly-once delivery cannot be guaranteed; ambiguity must remain explicit.
- The quarantine Admin list reads one bounded page; above 1000 objects its top 10 are not guaranteed globally newest.
- D1 and R2 are not atomic. D1 Time Travel cannot restore R2 or provider state.
- Production provider, multi-region, load, outage, monitoring, resource provisioning and rollback behavior remain **NOT VALIDATED** and belong to Phase 4C.

## 16. Source and Test Traceability

| Rule | Runtime/decision source | Automated evidence |
| --- | --- | --- |
| Queue ACK/retry and D1-to-R2 DLQ fallback | `src/index.ts`, `wrangler.toml`, D-028 | `tests/worker.test.ts`, `tests/dlq-consumer*.test.ts`, `tests/dlq-quarantine.test.ts` |
| D1 canonical DLQ convergence | `src/queue/consumer.ts`, `src/queue/dlq-consumer.ts` | `tests/dlq-consumer.test.ts`, `tests/dlq-consumer-real-d1.test.ts` |
| Outbound attempt boundary and ambiguity | `src/core/outbound-operations.ts`, D-024/D-025 | `tests/outbound-operations.test.ts` |
| Positive-only reconciliation | `src/core/outbound-reconciliation.ts`, D-025 | `tests/outbound-reconciliation*.test.ts` |
| Manual Retry child and domain repair | `src/core/outbound-manual-retry.ts`, `src/core/outbound-domain-resolution.ts`, D-026 | `tests/outbound-manual-retry*.test.ts`, `tests/outbound-domain-resolution.test.ts` |
| AI budget, handoff and durable success | `src/core/ai-state.ts`, `src/queue/ai-handler.ts`, D-027 | `tests/ai-durable-retry*.test.ts`, `tests/ai-handoff.test.ts` |
| Historical AI recovery | `src/core/dlq-ai-redrive.ts`, D-029 | `tests/dlq-ai-redrive.test.ts`, `tests/dlq-consumer-real-d1.test.ts`, `tests/admin-dlq.test.ts` |
| Attachment cleanup evidence preservation | `src/attachments/cleanup.ts` | `tests/attachment-proxy-cleanup.test.ts` |
| Runtime config rollback boundaries | `src/runtime-config/service.ts`, `src/runtime-config/repository.ts`, D-021/D-023 | `tests/runtime-config-repository.test.ts`, `tests/admin-control-plane.test.ts` |
| Privacy and bounded Admin display | `src/admin/reliability.ts`, `src/queue/dlq-quarantine.ts` | `tests/admin-reliability.test.ts`, `tests/admin-dlq.test.ts`, `tests/dlq-quarantine.test.ts` |
