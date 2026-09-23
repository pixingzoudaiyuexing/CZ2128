# CZ2128 Pre-Production Acceptance Matrix

Status: **PHASE 4B-5 ACCEPTED / COMPLETE / FROZEN / MERGED / PHASE 4C IN EXECUTION / CRISP-02 BASIC SUPPORT STAGING ACCEPTED / PRODUCTION NOT VALIDATED**

This matrix is a planning and evidence-recording artifact. Phase 4C has since begun and one explicitly bounded real-provider slice (Crisp-02 basic support) has Primary-accepted Staging evidence, recorded below. The matrix does not authorize new staging or production operations. Production is **NOT DEPLOYED** and production `DLQ_QUARANTINE` is **NOT PROVISIONED / NOT VALIDATED**.

Frozen Phase 4B-4B runtime baseline: `8499a5d4eaa40d4461d1882aaf6f4e2ac93efa08`

Phase 4B-5 accepted documentation merge baseline: `d6e111cbf79e4a64a396c749d60821d6a5a6d7f8`

Historical pre-PR #15 implementation base: `62c7c51120ad4d44fcdc4cff089173258b719c28`

## 1. Evidence Labels

- `LOCAL AUTOMATED`: unit/SQLite tests in the repository.
- `LOCAL WORKERD`: local Wrangler/workerd D1/R2 service tests.
- `CI`: GitHub Actions at an exact commit.
- `STAGING`: isolated real Cloudflare/provider resources.
- `STAGING PARTIAL`: real staging evidence exists for part of a broader matrix row, but the row's complete success criteria are not yet satisfied; the row remains NOT VALIDATED overall.
- `STAGING ACCEPTED (SCOPED)`: Primary has accepted real staging evidence for a separately named, explicitly bounded flow. It does not close a broader matrix row unless all of that row's criteria are also met.
- `PRODUCTION`: deployed production observation.
- `NOT VALIDATED`: required real-environment evidence does not exist in the approved project record.

Local/CI evidence can establish code behavior but cannot be relabeled as staging, provider, multi-region, load, outage or production evidence.

## 2. Acceptance Matrix

This matrix contains exactly **23 independent acceptance items**. The historical 4C-0A read-only environment inventory was preparation evidence only. Later Crisp-02 work produced the separate scoped acceptance record in Section 2A; it does not silently convert broader or historical rows to PASS.

Rows that explicitly require Chatwoot or Chatwoot-specific `source_id`/AI delivery semantics are retained as historical compatibility/reliability acceptance items. Under D-022 they are not current Crisp acceptance criteria, they remain NOT VALIDATED unless Primary separately scopes them, and they do not block the scoped Crisp-02 verdict. Conversely, Crisp-02 evidence must never be used to mark those Chatwoot rows PASS.

| Area | Acceptance Goal | Test Environment | Required Evidence | Success Criteria | Failure / Stop Criteria | Current Evidence Status | Owner / Approval Gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Historical Chatwoot text ingress/egress compatibility | Preserve the historical authenticated ingress/source-identity acceptance target without treating it as current Crisp validation | Isolated staging Chatwoot + staging Worker/D1/Queue | Signed webhook capture metadata, D1 receipt/operation, provider message/source ID, sanitized logs | Correct routing; duplicates converge; no echo loop; target evidence matches | Auth failure bypass, duplicate send, target drift, ambiguous unhandled result | D-022 makes Crisp the sole active helpdesk target. Historical Chatwoot code/evidence is preserved; LOCAL AUTOMATED + CI only; REAL CHATWOOT **NOT VALIDATED** and not required to claim Crisp-02 PASS | Any future historical-compatibility execution requires explicit Primary scope; do not substitute Crisp evidence |
| Real Telegram text/topic lifecycle | Authenticated topic routing, reply bridge, create/close/reopen behavior | Isolated forum supergroup + staging Support Bot | Update IDs/profile versions, D1 mapping, provider refs, operation/audit evidence | One conversation maps to one topic; stale generation is fenced; no duplicate action | Wrong group/thread, stale update mutation, duplicate topic/message | LOCAL AUTOMATED + CI + **STAGING PARTIAL** from Crisp-02: topic creation/routing, Crisp→Telegram, Telegram→Crisp and handoff notification passed; close/reopen and complete lifecycle remain **NOT VALIDATED** | Operations + Primary; dedicated bot/group authorization for remaining lifecycle work |
| Historical Telegram/Chatwoot attachments compatibility | Preserve the existing attachment acceptance target without treating it as Crisp attachment validation | Staging providers + private staging R2 | Source metadata, anonymous R2 key, provider refs, size/method matrix, sanitized logs | Correct method/content; limits/expiry enforced; no credential leak | Oversize bypass, SSRF/redirect leak, duplicate delivery, unbounded memory | LOCAL AUTOMATED + CI; historical REAL CHATWOOT/TELEGRAM attachment path **NOT VALIDATED**. Crisp attachments are separately outside Crisp-02 and also **NOT VALIDATED** | Any future compatibility or Crisp attachment run needs explicit Primary scope; Operations + Security as applicable |
| Real AI provider retry/classification | Actual provider failures map to finite retry/final classes and bounded deadlines | Isolated staging AI account | Redacted HTTP class/timing, `ai_runs`, attempt/deadline and outbound evidence | At most three attempts; retry timing honored; human bridge unaffected | Fourth call, stale/handoff delivery, raw provider body/secret exposure | LOCAL AUTOMATED + CI; REAL AI PROVIDER **NOT VALIDATED** | Operations + Primary; provider budget approval |
| R2 write/multipart/read/Range/delete | Private object lifecycle and proxy semantics match code | Staging R2 + staging Worker | Object metadata, multipart trace, GET/HEAD/Range responses, delete result | Private/no-store/nosniff; bounded chunks; missing/expired uniform 404 | Public access, token leak, unbounded buffering, D1 deleted before failed R2 delete | LOCAL AUTOMATED + CI; REAL R2 **NOT VALIDATED** | Operations + Security + Primary |
| R2 lifecycle and aborted multipart | Seven-day orphan expiry and abort policy are present and effective | Staging R2 | Lifecycle configuration and observed test-object behavior | Correct prefix/expiry/abort; application 24h authorization remains authoritative | Missing/wrong rule or lifecycle used as access control | Repository requirement only; **NOT VALIDATED** | Operations + Primary before rollout |
| Queue/D1 duplicate delivery and concurrency | Duplicate/contended events converge through receipts, leases and CAS | Staging Queue/D1 with controlled duplicate/concurrency fixture | Event/operation IDs, lease/CAS results, provider-call counts, final D1 state | One logical effect; deterministic terminal state/audit | Duplicate visible action, lost canonical state, half audit/state | LOCAL AUTOMATED + LOCAL WORKERD + CI; REAL QUEUE/D1 **NOT VALIDATED** | Reliability owner + Primary |
| Multi-region and sustained load | Ordering/correctness and latency remain acceptable under realistic concurrency | Staging load environment | Workload definition, region/source, rates, latency/error/state metrics | No invariant violation or duplicate side effect; defined capacity margin | State divergence, unbounded backlog, timeout/lease instability | **NOT VALIDATED** | Primary approves load plan; Operations executes |
| D1 outage and recovery | Fail-closed behavior preserves retry/evidence and returns safely | Staging with approved fault injection | Outage window, Queue behavior, quarantine evidence, recovery state/audit | No old credential fallback; canonical convergence after recovery | Provider action without durable boundary, evidence loss, unsafe restore | Unit fault fixtures only; REAL OUTAGE **NOT VALIDATED** | Primary + Operations + data owner |
| R2 outage and D1/R2 dual failure | Attachment and quarantine paths preserve known boundaries | Staging with approved R2/D1 fault injection | Per-binding failures, ACK/retry observations, D1/R2 metadata and logs | D1 success or sanitized quarantine before DLQ ACK; dual failure retries | ACK after no durable evidence, raw body stored, D1 metadata wrongly deleted | LOCAL AUTOMATED + LOCAL WORKERD; REAL OUTAGE **NOT VALIDATED** | Primary + Operations + Security |
| Queue retry exhaustion and DLQ | Main retry exhaustion reaches sanitized capture without blind processing | Staging Queue with bounded failing event | Consumer config, attempt timeline, DLQ receipt/quarantine and ACK/retry evidence | Main handler not invoked by DLQ consumer; evidence persists before ACK | Raw replay, missing evidence, unknown terminal platform behavior | LOCAL AUTOMATED; REAL QUEUE EXHAUSTION **NOT VALIDATED** | Reliability owner + Primary |
| 20 MiB attachment memory | Peak Worker memory remains within platform limits for destination upload path | Staging Worker/providers with controlled max-size files | Memory/CPU/time metrics, multipart method, provider result | No OOM; one file buffered at a time; hard size cap enforced | OOM, partial duplicate send, limit bypass | Code limits/unit tests only; **NOT VALIDATED** | Operations + Primary |
| Scheduled cleanup | Hourly trigger deletes expired R2 object before D1 row, in bounded batches | Staging Worker/R2/D1 scheduled trigger | Trigger event, ordered R2/D1 evidence, failure retry behavior | At most 100 rows/run; D1 retained on R2 failure | D1-first deletion, live object deletion, unbounded run | LOCAL AUTOMATED + CI; REAL SCHEDULE **NOT VALIDATED** | Operations + data owner |
| Support Bot rotation | New profile/webhook activates atomically with generation fencing | Isolated staging bots/group | Candidate validation, webhook calls, profile versions, old/new ingress results | New identity works; old generation cannot mutate; failure compensates safely | Partial profile, pending-update replay, Admin/Support token reuse | LOCAL AUTOMATED + CI; REAL ROTATION **NOT VALIDATED** | Primary + Operations; dedicated confirmation |
| Telegram group migration | Forum validation and topic mapping invalidation prevent old-group routing | Isolated staging bot + old/new groups | Provider validation, config/history version, mapping changes, new topic flow | Old mappings cleared atomically; new group creates fresh topics | Old group/thread restored or wrong-group send | LOCAL AUTOMATED + CI; REAL GROUP MIGRATION **NOT VALIDATED** | Primary + Operations; dedicated confirmation |
| Admin reconciliation | Positive Chatwoot evidence can confirm delivery without resend | Staging Chatwoot + private Admin Bot | Exact source ID search trace, target evidence, reconciliation/audit/domain state | One unique match after history exhaustion; no provider send | Zero/duplicate/incomplete match treated as sent | LOCAL AUTOMATED + local real-D1 persistence; REAL PROVIDER **NOT VALIDATED** | Authorized operator + Primary |
| Admin Mark Delivered/Cancel | Explicit operator decisions mutate only supported reconciliation/domain state | Staging Admin Bot + D1 | Confirmation session, independent delivery evidence, provider ref when required, audit | CAS-safe single resolution; no provider send | Mark without evidence, false provider ref, direct SQL mutation | LOCAL AUTOMATED + local real-D1 CAS; REAL ADMIN FLOW **NOT VALIDATED** | Authorized operator; incident approval |
| Admin Manual Retry | Duplicate-risk recovery creates one child and one bounded provider action | Staging Admin Bot/providers/D1/R2 | Confirmation, parent/child/audit, target/payload evidence, provider result | Parent stays ambiguous; exactly one child; no final/ambiguous child resend | Missing payload/evidence, target drift, duplicate child/action | LOCAL AUTOMATED + local real-D1 CAS; REAL PROVIDER **NOT VALIDATED** | Authorized operator + Primary duplicate-risk approval |
| Admin historical AI redrive | Eligible AI receipt reconstructs exact event and converges safely | Staging Admin Bot/Queue/D1/providers | Eligibility snapshot, intent audit, Queue/event/run/outbound/DLQ final state | Revalidation blocks drift; success reuse; receipt resolves only after processing | Non-AI/quarantine replay, missing target evidence, stale/handoff send | LOCAL AUTOMATED + LOCAL WORKERD; REAL END-TO-END **NOT VALIDATED** | Authorized operator + Primary incident approval |
| DLQ capture/quarantine | Sanitized terminal evidence is durable without retaining raw content | Staging Queue/D1/private R2 | ACK timing, D1 batch/R2 metadata, privacy scan, dual-failure behavior | ACK only after D1 or R2; deterministic finite metadata; monotonic resolution | Raw content/secret persisted, ACK after dual failure | LOCAL AUTOMATED + LOCAL WORKERD; REAL RESOURCES **NOT VALIDATED** | Reliability owner + Security + Primary |
| Permissions, privacy, audit and logs | Unauthorized users learn/mutate nothing; logs/audit contain finite sanitized data | Staging security test environment | Auth cases, Admin allowlist/session/update dedupe, redaction samples, audit linkage | No secret/raw body/private URL leakage; mutations attributable and bounded | Auth bypass, secret exposure, unaudited mutation | LOCAL AUTOMATED + CI; STAGING SECURITY **NOT VALIDATED** | Security reviewer + Primary |
| Migration and rollback drill | Exact schema/runtime transition and recovery plan preserve provider evidence | Isolated D1 copy/staging resources | Before/after schema, migration log, Queue/R2/provider inventory, rollback/forward plan | No data loss/state downgrade/duplicate side effect; stop gates work | Unproven old-code compatibility, destructive direct SQL, Queue purge | Clean local migration/0005 tests only; STAGING DRILL **NOT VALIDATED** | Data owner + Operations + Primary |
| Monitoring and incident response | Operators detect, classify, preserve evidence and escalate without unsafe action | Staging operational exercise | Alert/metric inventory, timed incident record, runbook steps, escalation package | Detection and stop decision within agreed objective; evidence complete | No alert, ambiguous ownership, destructive workaround | No monitoring configuration in repository; **NOT VALIDATED** | Operations defines; Primary accepts |

### 2A. Crisp-02 Scoped Staging Acceptance Evidence

Primary accepted the returned Crisp-02 basic-support result as **STAGING ACCEPTED (SCOPED)**. The acceptance is deliberately narrower than any whole-platform or production-readiness claim.

**Git / review / CI identity**

- Crisp-01 implementation: PR #21, exact head `40465c32d0fb1e56faab12eaf62839a2245c2c20`, merged as `f5100ce1e7b4c0d476cbdc3c5475214ece103c54`; exact-head CI run `35679432185` (#132) completed successfully.
- Crisp-02 final correlation fix: PR #27, base `4c8b1b8f89afda6471f1ca4fcb1f5e8c1bf0b2f9`, exact head `9b0c05927e91594a43e91605e608728e976c7854`, merged as `512917eecb75df534b5cf1733f296ae06818d125`.
- PR #27 exact-head CI run `35806188973` (#144) completed successfully; main CI run `35806917583` (#145) for merge SHA `512917eecb75df534b5cf1733f296ae06818d125` completed successfully.
- The retained task evidence contains a Gemini 3.1 Pro read-only reliability/echo-safety review of the exact PR #27 base/head and CI #144 with verdict `APPROVE`, followed by an explicit requirement for real Provider validation. GitHub itself contains no submitted PR #27 review or PR conversation comment, so the independent-review provenance is the retained task evidence, not a GitHub review object.

**Current staging identity independently re-read during reconciliation**

- Worker `cz2128-4c-staging`: version `b236cd98-1ece-4007-a641-a0139edbfe02`, deployment message identifies merge SHA `512917eecb75df534b5cf1733f296ae06818d125`.
- D1 `cz2128-4c-staging-db`: UUID `6482f216-5357-4e93-9796-89eaf0c1299c`, migrations exactly `0001`–`0005`.
- Main Queue/DLQ and both 4C R2 buckets exist under the names recorded in [STAGING-DEPLOYMENT.md](STAGING-DEPLOYMENT.md).

**WCX12 — bidirectional bridge, Picker and echo suppression**

- Conversation `ad31a817-f6fc-453a-a55f-104ec8c66478`; Telegram topic ref `68`.
- Real Crisp customer ingress created the topic and one Telegram forward; both durable operations are `SENT`, first attempt, HTTP 200.
- Welcome `crisp_welcome:ad31a817-f6fc-453a-a55f-104ec8c66478` and main Picker `crisp_picker:ad31a817-f6fc-453a-a55f-104ec8c66478:main` are `SENT`, first attempt, HTTP 202, with numeric provider message references.
- Telegram reply `0:70` created exactly one Crisp operation `send_crisp_0:70`, `SENT`, first attempt, HTTP 202, provider ref `68263923275916`.
- No Crisp message row exists for the returned provider ref `68263923275916`, while the outbound operation exists exactly once. This is durable real-provider evidence that the standard numeric fingerprint correlation suppressed the CZ2128 self-echo rather than re-forwarding it.
- First Picker selection produced one Telegram forward, one Crisp preset response and one next Picker `sales-next`; each visible operation is `SENT` on its first attempt (Telegram HTTP 200, Crisp HTTP 202).
- Second-level leaf selection produced one Telegram forward and one Crisp leaf response, again `SENT` on first attempt.
- New WCX12 `CRISP_HTTP_400_DIAGNOSTIC` count is zero.

**WCX13 — Picker-driven human handoff**

- Conversation `3c2a5bc5-a653-4688-ad61-d4947f8b62f3`; Telegram topic ref `73`.
- New conversation creation, customer forward, Welcome and main Picker all completed once; Telegram effects returned HTTP 200 and Crisp effects HTTP 202, all at `attempt_count = 1`.
- Human selection produced exactly one durable selection row, exactly one `CRISP_PICKER_HANDOFF_APPLIED` audit and exactly one `crisp_handoff_tg:...` Telegram notification operation.
- Conversation state is `PAUSED_OPERATOR` with `ai_handoff_epoch = 1`; the handoff audit records `UNCLAIMED -> PAUSED_OPERATOR` with reason `CRISP_PICKER_HANDOFF`.
- New WCX13 `CRISP_HTTP_400_DIAGNOSTIC` count is zero.

**Historical evidence remains immutable**

- WCX7–WCX11 Welcome/Picker failures remain durable `FAILED_FINAL / HTTP 400 / attempt_count = 1` records; no historical operation was reset, retried or rewritten for this acceptance.
- WCX10/WCX11 safe diagnostics remain present, including the WCX11 `FIELD_PROPERTIES:ISSUE_PATTERN / invalid_data` evidence that motivated PR #27.

**Scope boundary**

This scoped acceptance covers the Crisp basic text bridge only: Crisp ingress/Telegram forwarding, Telegram→Crisp reply, Welcome/Picker, multi-level Picker and leaf response, numeric-fingerprint correlation/self-echo suppression, and Picker-driven human handoff. It does **not** validate Crisp attachments, close/reopen lifecycle, Crisp AI generation/durable AI recovery, real R2 data-plane operations, Queue/D1 duplicate/concurrency behavior, outages, retry exhaustion/DLQ, Admin recovery flows, load/multi-region behavior, monitoring/incident response, rollback drills or Production.

## 3. Required Evidence Record

Create one record per matrix row and test execution:

```text
Matrix area:
Environment and account/project identifier:
Exact Worker SHA:
Workflow/configuration version:
D1 migration set:
Queue/R2/provider resource identities (non-secret):
Test start/end in UTC:
Authorized operator and approval reference:
Preconditions checked:
Mutation budget and provider-visible actions:
Observed result:
Canonical D1 evidence:
Provider/R2/Queue evidence:
Sanitized logs/audit references:
Success criteria result: PASS / FAIL / NOT VALIDATED
Failure/stop criteria encountered:
Cleanup/restore outcome:
Unverified gaps:
Reviewer/Primary decision:
```

Do not include credentials, raw webhook payloads, customer/AI text, private URLs, attachment bytes, bearer tokens or full provider error bodies.

## 4. Acceptance Gate

A row can be marked `PASS` only when:

1. The exact environment, commit, configuration and resource identities are recorded.
2. The required evidence is captured without violating privacy boundaries.
3. Success criteria pass and no stop criterion occurs.
4. Any provider-visible mutation stayed within a predeclared budget.
5. Cleanup or retained test data is documented.
6. The named owner/reviewer accepts the evidence.

Code review, local tests and CI cannot close rows requiring real staging/provider/platform evidence. Failed or incomplete runs remain `FAIL` or `NOT VALIDATED`; they are not averaged into a general readiness claim.

## 5. Phase 4C Boundary

Phase 4C owns execution of this matrix, environment-specific runbooks, controlled fault injection, real provider integration, load/concurrency evidence, monitoring acceptance and rollback drills. Phase 4B-5 only documented the gates; Phase 4C is now underway, with only the scoped Crisp-02 basic-support acceptance above closed.

The list below described the Phase 4B-5 / pre-execution authorization boundary and is retained as historical context. It must not be used to pretend that later authorized staging creation and Crisp-02 execution never occurred:

- Provisioning `DLQ_QUARANTINE` or any staging/production resource.
- Deploying Worker code.
- Calling real provider mutation APIs.
- Triggering Admin reconciliation, Manual Retry or AI redrive.
- Pausing, resuming or purging Queue messages.
- Restoring D1 or changing R2 lifecycle.
- Declaring production readiness.

For this reconciliation task specifically, authorization is **DOCS ONLY** plus read-only evidence verification and creation of the docs-only Git PR. No new Provider message, Cloudflare mutation, deployment, replay, fault injection or next Phase 4C acceptance run is authorized.

## 6. Existing Automated Evidence Map

| Evidence area | Repository tests | Evidence level |
| --- | --- | --- |
| Queue routing/ACK/retry/fallback | `tests/worker.test.ts` | LOCAL AUTOMATED / CI |
| Outbound lease, attempt and ambiguity | `tests/outbound-operations.test.ts` | LOCAL AUTOMATED / CI |
| Reconciliation and manual resolution | `tests/outbound-reconciliation.test.ts`, `tests/outbound-reconciliation-real-d1.test.ts` | LOCAL AUTOMATED + local real-D1 / CI |
| Manual Retry and domain repair | `tests/outbound-manual-retry.test.ts`, `tests/outbound-manual-retry-real-d1.test.ts`, `tests/outbound-domain-resolution.test.ts` | LOCAL AUTOMATED + local real-D1 / CI |
| AI retry/handoff | `tests/ai-durable-retry.test.ts`, `tests/ai-durable-retry-real-d1.test.ts`, `tests/ai-handoff.test.ts` | LOCAL AUTOMATED + local real-D1 / CI |
| DLQ capture/quarantine/redrive | `tests/dlq-consumer.test.ts`, `tests/dlq-consumer-real-d1.test.ts`, `tests/dlq-quarantine.test.ts`, `tests/dlq-ai-redrive.test.ts`, `tests/admin-dlq.test.ts` | LOCAL AUTOMATED + LOCAL WORKERD / CI |
| Attachments/proxy/cleanup | `tests/attachment-*.test.ts` | LOCAL AUTOMATED / CI |
| Runtime config/rotation/group migration | `tests/runtime-config-*.test.ts`, `tests/admin-control-plane.test.ts` | LOCAL AUTOMATED / CI |
| Migration `0005` | `tests/0005-reliability-migration-real.test.ts`, `tests/reliability-migration.test.ts` | Local SQLite migration / CI |
| Error taxonomy/privacy | `tests/error-taxonomy-retry.test.ts`, Admin/DLQ privacy tests | LOCAL AUTOMATED / CI |

All matrix areas not fully closed by their own criteria remain **NOT VALIDATED**. Crisp-02 supplies the scoped acceptance in Section 2A and partial evidence for the broader Telegram lifecycle row only; it does not convert unrelated real-resource rows to PASS.
