# CZ2128 Pre-Production Acceptance Matrix

Status: **PHASE 4B-5 ACCEPTED / COMPLETE / FROZEN / MERGED / PHASE 4C IN EXECUTION / SCOPED CRISP-02 THROUGH CRISP-05 STAGING EVIDENCE RECORDED / PRODUCTION NOT VALIDATED**

This matrix is a planning and evidence-recording artifact. Phase 4C has since begun and separately bounded Crisp-02 through Crisp-05 real-Staging slices are recorded below. Those scoped records do not silently close broader matrix rows. The matrix does not authorize new staging or production operations. Production is **NOT DEPLOYED** and production `DLQ_QUARANTINE` is **NOT PROVISIONED / NOT VALIDATED**.

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

This matrix contains exactly **23 independent acceptance items**. The historical 4C-0A read-only environment inventory was preparation evidence only. Later Crisp-02 through Crisp-05 work produced separate scoped evidence records in Sections 2A-2E; they do not silently convert broader or historical rows to PASS.

Rows that explicitly require Chatwoot or Chatwoot-specific `source_id`/AI delivery semantics are retained as historical compatibility/reliability acceptance items. Under D-022 they are not current Crisp acceptance criteria, they remain NOT VALIDATED unless Primary separately scopes them, and they do not block scoped Crisp verdicts. Conversely, Crisp evidence must never be used to mark those Chatwoot rows PASS.

| Area | Acceptance Goal | Test Environment | Required Evidence | Success Criteria | Failure / Stop Criteria | Current Evidence Status | Owner / Approval Gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Historical Chatwoot text ingress/egress compatibility | Preserve the historical authenticated ingress/source-identity acceptance target without treating it as current Crisp validation | Isolated staging Chatwoot + staging Worker/D1/Queue | Signed webhook capture metadata, D1 receipt/operation, provider message/source ID, sanitized logs | Correct routing; duplicates converge; no echo loop; target evidence matches | Auth failure bypass, duplicate send, target drift, ambiguous unhandled result | D-022 makes Crisp the sole active helpdesk target. Historical Chatwoot code/evidence is preserved; LOCAL AUTOMATED + CI only; REAL CHATWOOT **NOT VALIDATED** and not required to claim any scoped Crisp acceptance | Any future historical-compatibility execution requires explicit Primary scope; do not substitute Crisp evidence |
| Real Telegram text/topic lifecycle | Authenticated topic routing, reply bridge, create/close/reopen behavior | Isolated forum supergroup + staging Support Bot | Update IDs/profile versions, D1 mapping, provider refs, operation/audit evidence | One conversation maps to one topic; stale generation is fenced; no duplicate action | Wrong group/thread, stale update mutation, duplicate topic/message | LOCAL AUTOMATED + CI + **STAGING PARTIAL**: Crisp-02 proved create/routing/reply; Crisp-04 proved real same-topic close/reopen on Topics 89 and 95 with HTTP 200 / attempt 1 and one CREATE_TOPIC per conversation. Controlled real duplicate/stale/concurrency injection remains NOT VALIDATED | Operations + Primary; dedicated bot/group authorization for remaining lifecycle work |
| Historical Telegram/Chatwoot attachments compatibility | Preserve the existing attachment acceptance target without treating it as Crisp attachment validation | Staging providers + private staging R2 | Source metadata, anonymous R2 key, provider refs, size/method matrix, sanitized logs | Correct method/content; limits/expiry enforced; no credential leak | Oversize bypass, SSRF/redirect leak, duplicate delivery, unbounded memory | LOCAL AUTOMATED + CI; historical REAL CHATWOOT/TELEGRAM attachment path **NOT VALIDATED**. Crisp-05 has separate scoped Crisp evidence in Sections 2D/2E and must not be used to mark this historical row PASS | Any future compatibility or Crisp attachment run needs explicit Primary scope; Operations + Security as applicable |
| Real AI provider retry/classification | Actual provider failures map to finite retry/final classes and bounded deadlines | Isolated staging AI account | Redacted HTTP class/timing, `ai_runs`, attempt/deadline and outbound evidence | At most three attempts; retry timing honored; human bridge unaffected | Fourth call, stale/handoff delivery, raw provider body/secret exposure | LOCAL AUTOMATED + CI + **STAGING PARTIAL** from Crisp-03: one real AI SUCCESS / Crisp delivery / Telegram mirror at attempt 1 and real handoff trigger suppression are recorded. Actual provider failure, retry timing/exhaustion and outage classification remain **NOT VALIDATED** | Operations + Primary; provider budget approval |
| R2 write/multipart/read/Range/delete | Private object lifecycle and proxy semantics match code | Staging R2 + staging Worker | Object metadata, multipart trace, GET/HEAD/Range responses, delete result | Private/no-store/nosniff; bounded chunks; missing/expired uniform 404 | Public access, token leak, unbounded buffering, D1 deleted before failed R2 delete | LOCAL AUTOMATED + CI + **STAGING PARTIAL**: Crisp-05 proved bounded private object write/read and one controlled download; Stage B read back 11,272 bytes matching D1. Real max-size multipart, proxy HEAD/Range and delete behavior remain **NOT VALIDATED** | Operations + Security + Primary |
| R2 lifecycle and aborted multipart | Seven-day orphan expiry and abort policy are present and effective | Staging R2 | Lifecycle configuration and observed test-object behavior | Correct prefix/expiry/abort; application 24h authorization remains authoritative | Missing/wrong rule or lifecycle used as access control | **STAGING PARTIAL**: read-only bucket metadata lists the seven-day `attachments/` expiry and incomplete-multipart abort rules; no long-lived test-object observation proves lifecycle execution, and application-level TTL remains separate | Operations + Primary before rollout |
| Queue/D1 duplicate delivery and concurrency | Duplicate/contended events converge through receipts, leases and CAS | Staging Queue/D1 with controlled duplicate/concurrency fixture | Event/operation IDs, lease/CAS results, provider-call counts, final D1 state | One logical effect; deterministic terminal state/audit | Duplicate visible action, lost canonical state, half audit/state | LOCAL AUTOMATED + LOCAL WORKERD + CI; Crisp-05 real Staging observed no duplicate provider side effect, but no same-update duplicate injection or controlled concurrency fixture was executed. REAL QUEUE/D1 **NOT VALIDATED** | Reliability owner + Primary |
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

**Crisp-02 acceptance-time staging identity (historical)**

- At Crisp-02 reconciliation time Worker `cz2128-4c-staging` was version `b236cd98-1ece-4007-a641-a0139edbfe02`, with deployment message identifying merge SHA `512917eecb75df534b5cf1733f296ae06818d125`.
- At that time D1 `cz2128-4c-staging-db` had migrations `0001`–`0005`. Later Crisp-05 migrations and Worker versions are recorded in Sections 2D/2E and [STAGING-DEPLOYMENT.md](STAGING-DEPLOYMENT.md); this section is not a claim about the current deployed version.

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

### 2B. Crisp-03 Scoped AI / Human-Handoff Staging Evidence

**Evidence status: STAGING ACCEPTED (SCOPED) for the recorded AI happy path and handoff trigger fence; broader AI retry/classification row remains STAGING PARTIAL.**

**Git / CI identity**

- PR #29, `feat(crisp): deliver durable AI replies`: exact head `0baa56160fff71f26fb2822e5bf67aab770cbdd0`, CI run `35814372077` (#148) SUCCESS, merged as `04e49b609ec71ce08ec58a3dcb90cd270d830441`.
- Real Staging then exposed a handoff trigger-gating defect. PR #30 exact head `608107cca5780f3db8ed2d9addd4bb1f64f75546`, CI run `35817480866` (#150) SUCCESS, merged as `0cbe426f151ed378ad70c85615ac00c934e8505d`.

**Real Staging evidence**

- Conversation `36662f54-3f90-4813-921d-c1d75fa84bcb`, Telegram Topic 77.
- One real Crisp AI run reached `SUCCESS`, `attempt_count = 1`, with a durable provider response reference.
- Its visible `ai_reply:*` operation to Crisp is `SENT`, HTTP 202, attempt 1; the Telegram AI mirror is `SENT`, HTTP 200, attempt 1.
- A later real Telegram operator handoff moved the conversation to `PAUSED_OPERATOR`. The retained pre-fix evidence includes one `CANCELLED_BY_HANDOFF` run at `attempt_count = 0`; it was not erased.
- After PR #30, later real Crisp customer traffic was forwarded to Telegram while the conversation remained paused, and no third AI run was created.

**Boundary**

Real AI provider 429/5xx/timeout sequences, bounded retry timing/exhaustion, outage behavior, historical DLQ redrive, load/multi-region and Production were not exercised by this scope. Those remain automated-only or NOT VALIDATED as applicable.

### 2C. Crisp-04 Scoped Conversation Lifecycle Staging Evidence

**Evidence status: STAGING ACCEPTED (SCOPED) for real Crisp close/reopen on the original Telegram Topic.**

**Git / CI identity**

- PR #31 exact head `9f1baf25269f51322012ab927f74b1a2744630f4`, CI run `35824245069` (#152) SUCCESS, merged as `4ba044d8c9f05c50cb7ce25b0b5bb809556aa964`.
- The PR uses Crisp `session:set_state` as a trigger and an authoritative Crisp state read before lifecycle action; duplicate/stale/concurrent race behavior is covered by automated tests.

**Real Staging evidence**

- Conversation `12e0650a-b2e5-4584-8574-f542f76401c4` used Topic 89: one `CREATE_TOPIC`, then `CLOSE_TOPIC` and `REOPEN_TOPIC`, both `SENT`, HTTP 200, attempt 1; final topic status `OPEN`.
- Conversation `80c0a781-6dd4-49bf-8b2f-8003796eb588` used Topic 95 with the same one-create / close / reopen pattern; both lifecycle actions are `SENT`, HTTP 200, attempt 1; final topic status `OPEN`.
- Existing `PAUSED_OPERATOR` and `ai_handoff_epoch` values remained present; lifecycle did not reset the AI handoff state.

**Boundary**

Automated tests cover duplicate, late/out-of-order and concurrent lifecycle races, but Crisp-04 did not deliberately inject those faults as real Staging concurrency experiments. Group migration, bot rotation, load and Production remain outside this acceptance.

### 2D. Crisp-05 Stage A Attachment Evidence Matrix

PR #32 exact head `ab1e3e5dd654b87d183f3f826d6e4924726909ec` passed CI run `35845173556` (#180). The first Telegram-source Provider run then exposed an actual Telegram file-body redirect failure before any Crisp attachment send. PR #33 exact head `b53213364fa85baf520d858cb18d3b7b0a2e2aa3` passed CI run `35852934163` (#182) and changed only the official Telegram file-body GET to follow redirects. Retained task evidence reports independent Gemini `APPROVE` for both exact heads before their merges.

The Topic 103 D1 record still contains exactly five Stage A attachment rows: one successful Crisp image, two preserved pre-hotfix Telegram failures, and two post-hotfix Telegram successes. The historical failures were not retried or rewritten.

| Business direction | Evidence level | What is actually proved | Minimum missing evidence / boundary |
| --- | --- | --- | --- |
| Crisp customer **paste** image -> original Telegram Topic | **PARTIAL / paste gesture NOT VERIFIED** | A real Crisp raster image (`image.png`, 208,297 bytes) was accepted from the verified Crisp source, stored in private R2, delivered to Topic 103 at attempt 1 / HTTP 200, and the R2 body was read back at 208,297 bytes. | The retained provider record does not identify whether the customer inserted that image by paste versus another UI action. |
| Crisp customer **drag** image -> original Telegram Topic | **PARTIAL / drag gesture NOT VERIFIED** | The same real generic Crisp-image transport evidence proves the source/provider path and original-topic delivery. | The retained provider record does not identify a drag/drop gesture. |
| Telegram support image -> Crisp Markdown image **actually displayed** | **PARTIAL** | Post-hotfix photo `0:108`, 18,031 bytes, is `DELIVERED` to Crisp with one durable `SEND_ATTACHMENT`, HTTP 202 / attempt 1. | No retained human/client observation proves the Markdown image rendered visibly in the Crisp UI. |
| Telegram support ordinary file -> Crisp temporary download link | **PARTIAL** | Post-hotfix `asdfasdf.txt`, 128 bytes, is `DELIVERED` to Crisp with one durable `SEND_ATTACHMENT`, HTTP 202 / attempt 1. | No retained human click/download result for this Stage A link. |
| Private R2 actual write/read and authorization | **REAL STAGING PASS (bounded) + AUTOMATED PASS for auth semantics** | The Crisp-source image existed in private R2 and was read back at exactly 208,297 bytes; provider delivery used a controlled capability rather than a public R2 URL. | Stage A did not separately exercise proxy HEAD/Range, invalid-token denial, every authorization edge or max-size multipart. |
| Stage A link expiry / loss | **NOT VERIFIED in Stage A** | Code/tests enforce D1 TTL and uniform access failure. | No retained Stage A real link-expiry observation. Stage B later provides separate real TTL evidence and must not be back-labelled as Stage A proof. |
| Crisp numeric fingerprint / self-echo for attachment delivery | **AUTOMATED PASS / REAL STAGING OBSERVATION** | Crisp-02 separately proves numeric-fingerprint self-echo suppression for text. Stage A attachment operations were deterministic and no duplicate provider side effect was observed. | No deliberate real attachment self-echo/duplicate injection was performed. |
| Human handoff and AI state during Stage A | **NOT VERIFIED as a Stage A handoff test** | The Stage A Topic 103 conversation has `ai_runs = 0`; attachment-only flow did not start AI. Crisp-03 separately supplies real handoff evidence. | No Stage A-specific handoff transition was exercised. |
| Historical failures preserved / Production isolated | **REAL STAGING PASS / OBSERVATION** | Pre-hotfix `0:106` photo and `0:107` document remain `FAILED_FINAL / ATTACHMENT_SOURCE_TRANSIENT / attempt 3`; later work preserved them and the five-row Stage A history. No Production deployment was part of Stage A. | This is evidence preservation/isolation, not broad Production readiness. |

The two pre-hotfix rows failed after Telegram `getFile` but before a Crisp `SEND_ATTACHMENT`, so they did not create a duplicate visible Crisp side effect. Post-hotfix real provider success proves the redirect repair for the tested photo/file sizes only.

### 2E. Crisp-05 Stage B Temporary Upload Acceptance

**Evidence status: SCOPED ISOLATED STAGING ACCEPTED / COMPLETE.**

**Git / review / CI identity**

- PR #34 exact head `cf956550718f6f235b76c720a83645873778d57f`, CI run `35862581479` (#184) SUCCESS; temporary customer-upload implementation.
- Applying migration `0007_crisp_upload_invites.sql` to isolated Staging initially failed with `incomplete input: SQLITE_ERROR [7500]`. The failure was verified atomic: `0007` remained pending, new table/trigger absent and all five Stage A attachment rows unchanged.
- PR #35 exact head `3fc2af45100c08bdfbd802c03d6c9b76d36a0a09`, CI run `35866372256` (#186) SUCCESS; parenthesized D1 trigger guard fix. Retained task evidence reports Gemini `APPROVE`.
- The first Topic 117 ordinary-file attempt exposed a second real defect: the D1 trigger committed `ACCEPTED` and incremented invite counters, while the Worker misread trigger-inclusive `meta.changes` as a limit failure and returned HTTP 409. Repeated user retries left one `EXHAUSTED` invite and three preserved `FAILED_FINAL / UPLOAD_INVITE_LIMIT_EXCEEDED` rows.
- PR #36 exact head `f3c94fe7bc6a63ef7992408c4997553834eb35a0`, CI run `35875802667` (#188) SUCCESS; independent Gemini exact-head review returned `APPROVE` with no blocking or non-blocking findings. It merged as `d635520b1cde7a49e75ef5f658c862d5e856c5db`; main CI run `35881127038` (#189) SUCCESS.

**Real Staging acceptance**

- Final accepted Worker version: `4d13f217-bd80-4c7c-a6bf-8ed13669be77`; Crisp-06 read-only deployment metadata confirms this is the latest staging version. D1 lists migrations `0001` through `0007` with no pending migration.
- An operator authorized by bootstrap `ADMIN_TELEGRAM_USER_IDS` created a new server-bound invite in Topic 117. The browser could not choose Conversation, Website/Session, group or Topic identity.
- `kefu.txt`, 11,272 bytes, became one `ACCEPTED` upload item. The private R2 object existed and read back at exactly 11,272 bytes. The attachment reached `DELIVERED`; Telegram `SEND_ATTACHMENT` was `SENT`, HTTP 200, attempt 1.
- The operator used the controlled forced-download link in Topic 117 and reported a successful download.
- After the 15-minute invite TTL elapsed, refreshing the old upload URL returned `Not Found`; D1 converged the invite to `EXPIRED` while the already delivered attachment remained `DELIVERED`.
- A separate fresh invite was created and then `/upload_revoke` was issued. The invite became `REVOKED`, consumed 0 files / 0 bytes, and the Telegram revoke acknowledgement was `SENT`, HTTP 200, attempt 1.
- Final Topic 117 snapshot: one historical `EXHAUSTED` invite, one `EXPIRED`, one `REVOKED`, zero `ACTIVE`; one successful `DELIVERED` attachment; three preserved HTTP-409 `FAILED_FINAL` attachments; `ai_runs = 0`; one `CREATE_TOPIC`. All observed visible outbound attempts in this acceptance were attempt 1.
- Production was not touched.

**Automated capability boundary**

- `/upload` and `/upload_revoke` require a positive Telegram operator ID already in bootstrap-only `ADMIN_TELEGRAM_USER_IDS`, the exact mapped Topic, current Support Bot generation and ordered Telegram update.
- Invite/download HMAC capabilities are domain separated; D1 stores hashes only. Invite TTL is 15 minutes, max files is 3, upload-item lease is 120 seconds, and the total-byte ceiling comes from the attachment hard cap.
- Tests cover server-side website/session/topic binding, resolved-Crisp fail-closed behavior, blocked image/active-content types, streaming size enforcement, private R2 storage, atomic trigger counters/limits, lease reclaim, stale-command fencing, ambiguous invite no-resend and controlled forced-download notification.
- **Duplicate evidence must remain split:** AUTOMATED PASS proves duplicate delivery of the same `/upload` command produces one Crisp invite and one Telegram ACK, and the same `upload_id` has a single lease owner / is not double-counted. REAL STAGING OBSERVATION only says no duplicate Provider side effect was observed; the same Telegram update was not deliberately injected twice.
- The Stage B `/upload` command runs through the Support Telegram topic handler guarded by the bootstrap admin-user allowlist. It is not validation of the separate Telegram Admin Bot reliability control plane.

**NOT VERIFIED / outside Stage B acceptance**

- Real 20 MiB boundary behavior and large-file multipart behavior.
- Real proxy HEAD/Range and all authorization-denial permutations.
- Long-term R2 lifecycle cleanup versus application-level attachment expiry.
- All media/file types beyond the tested ordinary text file and automated blocked-type matrix.
- Real D1/R2 outage injection, simultaneous failure, real Queue duplicate/concurrency/load and multi-region behavior.
- Full Admin reliability operations, Support Bot rotation, Telegram group migration, monitoring/incident response, rollback drills and Production.

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

Phase 4C owns execution of this matrix, environment-specific runbooks, controlled fault injection, real provider integration, load/concurrency evidence, monitoring acceptance and rollback drills. Phase 4B-5 only documented the gates; Phase 4C is now underway with the separately bounded Crisp-02 through Crisp-05 records above. Those records do not make the whole 23-item matrix complete.

The list below described the Phase 4B-5 / pre-execution authorization boundary and is retained as historical context. It must not be used to pretend that later authorized staging creation and scoped Crisp-02 through Crisp-05 execution never occurred:

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
| Crisp AI and lifecycle | `tests/crisp-ai.test.ts`, `tests/crisp-lifecycle.test.ts`, `tests/crisp-flow.test.ts` | LOCAL AUTOMATED / CI |
| Crisp temporary upload | `tests/upload-*.test.ts`, `tests/0007-crisp-upload-invites-migration-real.test.ts` | LOCAL AUTOMATED + local real-D1 / CI |
| Runtime config/rotation/group migration | `tests/runtime-config-*.test.ts`, `tests/admin-control-plane.test.ts` | LOCAL AUTOMATED / CI |
| Migration `0005` | `tests/0005-reliability-migration-real.test.ts`, `tests/reliability-migration.test.ts` | Local SQLite migration / CI |
| Error taxonomy/privacy | `tests/error-taxonomy-retry.test.ts`, Admin/DLQ privacy tests | LOCAL AUTOMATED / CI |

All matrix areas not fully closed by their own criteria remain **NOT VALIDATED**. Sections 2A-2E supply scoped Crisp evidence and partial evidence for several broader rows; they do not convert unrelated real-resource, historical Chatwoot, fault/load/Admin or Production rows to PASS.