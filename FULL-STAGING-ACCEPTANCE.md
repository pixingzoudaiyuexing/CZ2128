# CZ2128 Full Staging Acceptance

Status: **IN PROGRESS — NOT FULLY ACCEPTED**. Updated 2026-10-15 (Asia/Shanghai).

This is the live acceptance ledger for the Owner's attachment architecture repair, genuine AI-effect test and complete existing-Staging Work Unit. It replaces unexecuted earlier full-acceptance plans. Historical Phase 4C results remain in `PREPRODUCTION-ACCEPTANCE.md`; they do not automatically pass new behavior or the final executable SHA.

## 1. Scope and exact identity record

| Item | Recorded state / evidence still required |
| --- | --- |
| Repository | `https://github.com/pixingzoudaiyuexing/CZ2128` |
| Engineering base | `6af87f6ef60f5c868c62489b1b908c3a70ac1d7f`; recheck remote before promotion |
| Final candidate / main SHA | NOT TESTED — record exact final executable SHA after implementation |
| Candidate CI URL / conclusion | NOT TESTED at final head |
| Formal Independent Review | NOT TESTED at final head; agy review must actually return PASS after material findings are fixed |
| Main CI URL / conclusion | NOT TESTED at final head; fast-forward only, no force push |
| Worker / domain | Existing `cz2128-4c-staging` / `https://cz2128.482658.xyz` |
| D1 | Existing `cz2128-4c-staging-db`, UUID `6482f216-5357-4e93-9796-89eaf0c1299c` |
| Queues | Existing `cz2128-4c-staging-queue` / `cz2128-4c-staging-dlq` |
| R2 / DO | Existing Staging attachment/quarantine buckets and `CrispRtmBridge`; no new environment |
| Telegram | Existing `@cz2128SupportTestaBot`, `cz2128Topics_B`; verify exact group/Topic identity before test sends |
| Pre-change executable | Recorded version 79 `c30c66dd-a12d-4e19-afbb-d6dc9f8d0cea`, deployment `c7f0f803-7315-44b9-a08b-d1495cd4ef04`, 100%; annotation SHA `325c0933461fca08549b96092005de0ee708103f` |
| New deployment / version / 100% / SHA | NOT TESTED — this Work Unit has not yet recorded a new Staging deployment |
| Applied D1 schema | Preflight `0001`–`0010`; candidate includes forward `0011` and additive `0012`; actual pending/apply results required |
| Recovery | Fresh exact-D1 Time Travel bookmark and protected backup coverage required before migration; no automatic D1 restore |
| Settings restoration | Original AI scope `true` / synthetic UUID allowlist; quiet default 15 minutes (recorded version 4); ordinary/image defaults 72 hours / seven days |

Routine deployment to this existing Staging is authorized after every engineering gate passes. Production, Docker, additional environments, Release/tag/GHCR and unrelated accounts/resources are excluded. No live destructive fault test, Bot/group switch or raw DLQ replay may damage the current Staging identity or history.

## 2. Evidence labels and limitations

Every result is one of **PASS / FAIL / BLOCKED / NOT TESTED / NOT APPLICABLE**, with evidence level, exact SHA/configuration and concrete artifact/run/browser observation. A client upload, R2 object, Queue enqueue, D1 `SENT`, Provider response and human-visible result prove different things. Do not collapse them into one end-to-end PASS.

Current implementation validation includes the following bounded results. These are development evidence, not final-head CI or deployed acceptance:

| Check | Current evidence | What remains |
| --- | --- | --- |
| Attachment storage/delivery/manual retry | PASS — targeted local attachment/reliability run, 13 files / 241 tests; subsequent storage edge cases also passed | Re-run in complete final-head suite; no real Provider outcome is inferred |
| SHA-256 and native streaming | PASS — local 32 MiB complete-object digest and 30 MiB streamed native/manual-retry tests; no whole-file read in production seam | Real Worker/cloud/Provider sample sizes and bounded memory/time evidence |
| Local multipart HTTP | PASS — integration run reported for `tests/upload-sessions-real-d1.test.ts`; real local Wrangler D1/R2/FixedLengthStream, 32 MiB in four 8 MiB parts, checksum/Range/HEAD | Exact final-head gate and log reference; this local harness replaces Crisp-state reads and Queue dispatch, and sends no real Provider message |
| Restart/resume | PASS at local workerd layer — same persisted local multipart session after Worker restart and invitation expiry | Actual browser interrupt/reload/original-file selection plus real Staging continuation |
| Classification/retention/cleanup | PASS at local unit/SQLite layer — bytes override claimed MIME, corrupt/truncated images fall back to forced download, 72-hour/seven-day clocks, delete failure retries | Controlled-time final suite; short-lived isolated remote samples and actual lifecycle configuration/output |
| Staging 2026-10-14 slices | Historical bounded text/image/60-byte TXT evidence exists for the old executable | It is not full v2, large-file, new quiet-window or genuine AI acceptance |
| Current final-head full regression | NOT TESTED until final code/docs are stable | Include pre-existing versus introduced failures and actual exit status |

The v2 protocol separates network chunks from R2 multipart parts: requests carry at most 8 MiB, logical R2 parts adapt up to 5 GiB, and only R2’s physical 5 TiB / 10,000-part boundary limits the declared file size. Files above 64 MiB are verified through successive 16 MiB R2 range reads; SHA-256 and content-parser checkpoints persist in D1, so verification can resume after process loss. No whole-file buffer or single multi-terabyte verification invocation is required. Real local workerd evidence includes 32 MiB transport and an 80 MiB verification/restart case; it does not validate the entire provider capacity or replace cloud/browser acceptance. [R2 multipart limits](https://developers.cloudflare.com/r2/objects/upload-objects/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## 3. Attachment and download matrix

Unless an observation is explicitly entered below, the current Work Unit's real/browser result is **NOT TESTED**. Tests use only labeled synthetic conversations and files. Record bytes, SHA-256, source representation, destination mode and exact event/attachment/outbound identity without publishing capability URLs or customer data.

| ID | Required case | Pass condition and required evidence | Current real/browser status |
| --- | --- | --- | --- |
| A01 | Crisp visitor → Telegram image | Real Widget upload; server image classification; one Topic delivery; bytes/hash and caption/notification evidence | NOT TESTED |
| A02 | Telegram → Crisp image | Actual Telegram compressed representation recorded; one Crisp visible image or authorized-link delivery; original screenshot size not substituted | NOT TESTED |
| A03 | Crisp visitor → Telegram ordinary file | Actual allowed Crisp client upload or authenticated portal; file bytes/hash and original Topic delivery | NOT TESTED |
| A04 | Telegram → Crisp ordinary file | Real TXT/PDF/ZIP-type source; native-download Provider constraints or explicit operator portal; one visible safe link/file | NOT TESTED |
| A05 | Crisp real operator image mirror | Authenticated Mac Crisp client, or authorized web inbox fallback explicitly recorded; one human-labeled silent mirror | NOT TESTED |
| A06 | Crisp real operator ordinary attachment mirror | Genuine human inbox action; provenance and quiet-clock behavior; one file delivery | NOT TESTED |
| A07 | `/upload` | Authorized existing Topic creates one bound 15-minute invitation; no fabricated provider event | NOT TESTED |
| A08 | Continuous multi-file selection | More than the former three-file quota accepted over time; each has independent session/outcome, no silent truncation | NOT TESTED |
| A09 | Images and ordinary files in portal | Server bytes classify correctly despite misleading MIME/name; unsafe/unknown content forced download | NOT TESTED |
| A10 | Several MiB / tens of MiB | Representative controlled samples; progress, real storage and destination/linked download hashes | NOT TESTED |
| A11 | Above old 20 MiB | Real Staging multipart sample above 20 MiB, no product limit or old SQLite CHECK rejection | NOT TESTED |
| A12 | Multipart > one part | Ordered durable ETags/lengths/hashes; complete-object SHA matches original and downloaded bytes | NOT TESTED |
| A13 | Interrupt and resume | Browser pause/network interruption or reload, original-file checksum, no reupload of confirmed parts | NOT TESTED |
| A14 | Wrong reselected file | Same name/size with different bytes denied before completion; original session remains coherent | NOT TESTED |
| A15 | Duplicate part/event | Identical part and repeated gateway event converge; changed manifest denied; no duplicate visible effect | NOT TESTED |
| A16 | Actual upload progress | Browser XHR progress tracks real part bytes; hash/storage/queue/delivery phases stay distinct | NOT TESTED |
| A17 | Delivery after storage | Portal shows STORED/QUEUED while waiting and DELIVERED only after canonical effective Provider result; AMBIGUOUS is visible | NOT TESTED |
| A18 | `/upload_revoke` | Incomplete/new work denied, multipart abort retry coherent; already retained files not prematurely deleted | NOT TESTED |
| A19 | Invite expiry versus session | No new session after invite expiry; existing authorized session may resume within independent session expiry | NOT TESTED |
| A20 | Invalid/expired/revoked upload capability | Actual application denial, not a DNS/browser timeout misreported as 404; no new accepted bytes | NOT TESTED |
| A21 | Download GET / HEAD / Range | Actual full checksum; HEAD no body; byte-accurate 206 and Content-Range; invalid Range rejection | NOT TESTED |
| A22 | Invalid/expired/revoked download grant | Actual private rejection; no token/object existence leakage; file retention independent | NOT TESTED |
| A23 | Reauthorize retained files | Authorized Topic `/files` issues a valid grant without reopening an expired invitation; no retention extension | NOT TESTED |
| A24 | Ordinary-file 72-hour policy | Controlled-time automated boundary plus isolated short remote sample and restored default; no real 72-hour wait required | NOT TESTED |
| A25 | Image seven-day policy | Server classification + controlled-time boundary and short remote sample; correct restored default | NOT TESTED |
| A26 | R2 delete failure / retry | Local fault fixture proves key retained, backoff and later tombstone; remote cleanup smoke/lifecycle metadata separately recorded | NOT TESTED |
| A27 | Incomplete multipart cleanup | Expired/revoked session abort/idempotency and abort-failure retry; actual bucket abort policy | NOT TESTED |
| A28 | Orphan protection | Failed admission/complete and failed D1/R2 boundaries remain managed; no premature metadata loss | NOT TESTED |
| A29 | Telegram > hosted getFile limit | Real controlled file beyond upstream 20 MB boundary gives authenticated operator portal, never false file SENT | NOT TESTED |
| A30 | Telegram native versus link fallback | Native Provider photo/file constraints respected; larger stored content uses one ledger-backed safe link | NOT TESTED |
| A31 | Quiet-window attachment notification | Customer attachment within Crisp human window silent; expiry restores normal policy; delayed transfer keeps frozen options | NOT TESTED |
| A32 | Trusted origin / SSRF | Generated links use configured custom domain; spoofed Host/queued origin rejected; verified Provider storage-host redirects | NOT TESTED |
| A33 | Large-file technical ceiling/time | Boundary rejection is explicit; no infinite/full-R2-capacity claim; very large completion CPU/time separately measured | NOT TESTED |

Do not call a successful R2 write “customer received” without the destination observation. Telegram native photo transformations mean its actual Provider representation/hash may differ from the original browser fixture; preserve both identities and explain the transformation.

## 4. Genuine AI behavior matrix

Use only exact synthetic Staging conversations. Before any temporary allowlist change, record original values, narrowly include the tested internal UUIDs, and restore afterward. Listing models or clicking “测试 AI” alone cannot pass the customer-facing rows.

| ID | Required case | Observable pass condition | Current real/browser status |
| --- | --- | --- | --- |
| I01 | First automatic answer | Actual Crisp visitor question receives one visible answer | NOT TESTED |
| I02 | Natural language quality | Answer is relevant, understandable and does not expose provider errors/private instructions | NOT TESTED |
| I03 | Multi-turn context | Follow-up correctly uses bounded prior conversation context | NOT TESTED |
| I04 | Knowledge hit | Enabled synthetic knowledge influences the visible answer; source/status evidence retained | NOT TESTED |
| I05 | Knowledge miss | Safe fallback without invented hit or broken human support | NOT TESTED |
| I06 | Uncertain question | Bounded, truthful response or appropriate human handoff | NOT TESTED |
| I07 | Upstream timeout/error | Local isolated fault test plus safe runtime behavior; do not disrupt shared Provider globally | NOT TESTED |
| I08 | AI retry | Durable budget at most three Provider-boundary attempts and no duplicate reply | NOT TESTED |
| I09 | Crisp real human takeover | Authentic operator action pauses AI and preserves visible human support | NOT TESTED |
| I10 | Telegram human takeover | Actual Topic reply pauses AI without altering the independent Crisp notification clock | NOT TESTED |
| I11 | Interrupt in-flight AI | Local deterministic race plus real bounded observation where feasible; stale generated output discarded | NOT TESTED |
| I12 | `/ai_off` and `/ai_on` | Real authorized callbacks/commands persist correct modes; off remains manual until on | NOT TESTED |
| I13 | Auto-resume | New customer text after operator timeout resumes only under existing policy and authorization | NOT TESTED |
| I14 | AI versus notification silence | AI mode/generation and 15-minute Telegram silence remain independent | NOT TESTED |

## 5. Crisp / Telegram business matrix

| ID | Required case | Pass condition | Current real/browser status |
| --- | --- | --- | --- |
| B01 | New conversation / Topic / card | Exactly one Topic; Topic → one metadata card → first customer content ordering | NOT TESTED |
| B02 | Available profile / IP / region | Bounded genuine metadata card; no customer IP/body in public evidence or learning input | NOT TESTED |
| B03 | Bidirectional text | Real visitor and operator sends observed on the other side; exact canonical identities | NOT TESTED |
| B04 | Welcome / keyword reply | One appropriate automated reply; duplicate ingress does not repeat visible work | NOT TESTED |
| B05 | Picker buttons | Actual labels/callback selection; no text spoofing as a Picker command | NOT TESTED |
| B06 | Human versus automated provenance | Real human inbox action and automated/gateway echo distinguished, including media | NOT TESTED |
| B07 | Echo-loop fence | Provider return event observed and canonical/Telegram duplicate effects absent | NOT TESTED |
| B08 | Close / reopen | Real Crisp lifecycle closes/reopens the original Topic; no replacement Topic | NOT TESTED |
| B09 | RTM message / reconnect | Actual authenticated RTM activity and bounded reconnect; same provider identity; diagnostics are not per-message delivery proof | NOT TESTED |
| B10 | Signed webhook path | Actual webhook ingress and authenticated failure tests; RTM success cannot substitute for webhook proof | NOT TESTED |
| B11 | Ordering / delay | Record browser sends, Provider boundary timestamps and UI observation independently; no tool-wait duration as transport latency | NOT TESTED |
| B12 | Genuine Crisp 15-minute silence | Operator original-time receipt starts the clock; text/media inside quiet window silent | NOT TESTED |
| B13 | Telegram does not clear silence | Telegram reply does not prematurely remove Crisp quiet state | NOT TESTED |
| B14 | Quiet expiry / restart | Clock persists across restart; controlled shortened sample restores 15-minute default; normal notifications resume | NOT TESTED |

## 6. Telegram Admin matrix

For every supported settings workflow, distinguish navigation/input from an actual saved configuration. Record key/version/action only; never retain Secret values. A missing second Bot/group cannot be replaced by switching the only healthy identity during testing.

| ID | Menu / behavior | Required checks | Current real/browser status |
| --- | --- | --- | --- |
| M01 | AI settings | Page, model discovery/manual input, save/version/history, validation, back/return and completion health | NOT TESTED |
| M02 | AI knowledge | Add/edit/delete/enable/disable, search, list/page, version/CAS and effective AI use | NOT TESTED |
| M03 | Learning / Notion | Candidate views/review/actions, privacy and error paths; Notion account boundary below | NOT TESTED |
| M04 | Telegram settings | Current single-Bot/private-admin/forum identities; quiet setting shortcuts/custom/default/history/rollback | NOT TESTED |
| M05 | Crisp settings | Existing menu/identity/health/settings workflows, validation and safe history actions | NOT TESTED |
| M06 | Attachment settings | Correct separate 72-hour/seven-day defaults; retired size/count/unified TTL cannot change v2 policy | NOT TESTED |
| M07 | Keyword replies | Existing create/edit/delete/list/enable/version workflows and actual reply behavior | NOT TESTED |
| M08 | Reliability | Summary, audit, uncertain operations, supported action-specific confirmation; no unauthorized replay | NOT TESTED |
| M09 | System status / history | Actual page/buttons/back, bounded values, pagination when dataset supports it | NOT TESTED |
| M10 | Repeated/stale interactions | Duplicate update, stale page/version, wrong-session callback, input validation and timeout fail closed | NOT TESTED |
| M11 | Unauthorized Admin user | Local high-fidelity authorization integration; actual separate test user only if available and authorized | NOT TESTED |
| M12 | Bot rotation / group migration | High-fidelity integration without damaging current Bot/group; real switch NOT TESTED when a second identity is unavailable | NOT TESTED |

Pagination without enough records is **NOT APPLICABLE** for that real dataset or **NOT TESTED** as a behavior, with separate automated coverage; never invent a second page.

## 7. Knowledge / learning / Notion matrix

| ID | Required case | Pass condition | Current result |
| --- | --- | --- | --- |
| K01 | Knowledge create/edit/delete/enable/disable | Canonical D1/FTS/search/history converge and enabled content alone enters AI context | NOT TESTED at final head / real UI |
| K02 | Human candidate capture | Eligible confirmed human reply creates one durable sanitized candidate; retries converge | NOT TESTED at final head / real UI |
| K03 | Extraction / privacy | Capabilities, tokens and high-confidence PII removed before persistence/provider; hostile instructions treated as data | NOT TESTED at final head / real UI |
| K04 | Review / reject / publish | Only safe approved canonical state publishes one knowledge entry; reject remains terminal; audit intact | NOT TESTED at final head / real UI |
| K05 | Notion integration | If unconfigured, validate executable integration/error handling locally and mark genuine remote flow BLOCKED; no private-account connection without authorization | NOT TESTED; actual configuration must be checked by names/settings only |

## 8. Reliability, storage, security and recovery matrix

| ID | Required case | Minimum evidence boundary | Current result |
| --- | --- | --- | --- |
| R01 | Clean and legacy migrations | Exact 0001–0012 inventory, row/constraint/FK preservation and current runtime compatibility | NOT TESTED at final head |
| R02 | Queue/DLQ growth | Before/after/converged REST backlog metrics for both exact Staging Queues; D1 OPEN counts separately compared | NOT TESTED after this Work Unit's deployment |
| R03 | Duplicate / attempts / exhaustion | Stable source/event/outbound identity; bounded retry; no blind resend | NOT TESTED at final head |
| R04 | AMBIGUOUS reconcile/manual retry | Frozen positive evidence and explicit risk workflow, child uniqueness; incompatible native→link retry blocked | NOT TESTED at final head |
| R05 | Supported AI redrive | Exact eligible durable-state workflow; no generic replay/quarantine import | NOT TESTED at final head |
| R06 | R2 read/write/multipart | Real local workerd result plus bounded remote real-object smoke; fault injection local only | NOT TESTED remotely for v2 |
| R07 | Scheduled cleanup | Exact expiry, R2 delete/abort failure recovery and actual cron/lifecycle configuration; no real 72-hour/seven-day wait | NOT TESTED remotely for v2 |
| R08 | Webhook authentication | Signature/timestamp, Telegram secret/path/group, malformed/replay/duplicate rejection | NOT TESTED at final head |
| R09 | Privacy / capability access | No raw payload/URL/token/Secret in logs, AI/learning/Notion or public evidence; private download and authorization tests | NOT TESTED at final head |
| R10 | SSRF / Host / MIME | Exact source-host redirects, trusted configured public origin, server content classification and forced download | NOT TESTED at final head |
| R11 | Restore / rollback compatibility | Protected recovery point/coverage; old executable v2 compatibility explicit; no unplanned destructive restore | NOT TESTED as restore / full v2 rollback |
| R12 | Concurrent state / faults | Adversarial local leases/CAS, completion/revoke/cleanup races and unavailable stores; shared Staging not intentionally corrupted | NOT TESTED at final head |

## 9. Full engineering gates

Required commands/check groups: `typecheck`, lint, full regression, real local D1, Crisp/Telegram/AI/Admin, large attachment multipart/retry/storage expiry, knowledge/learning, reliability/security and `git diff --check`. Record actual commands, exit statuses and logs. New failures must be repaired; pre-existing failures must be distinguished rather than hidden. No additional test run is implied by a checklist entry.

Exact-head agy Formal Independent Review is a separate gate from embedded review and this document. A timeout, failed specialist call or tool check cannot be labeled PASS. Preserve accurate per-mode agy call accounting in the Engineer report. Candidate and main CI must point to the final relevant SHA; workflow existence is not evidence.

## 10. Sample, temporary-setting and final report records

For each real sample record: unique synthetic marker; original and Provider byte sizes (where transformed); original/stored/download SHA-256; verified class; native versus link/portal mode; stored/admitted/expiry timestamps; part count and resume boundary; exact attachment/event/outbound identities; browser/Provider observations; and PASS/FAIL/BLOCKED/NOT TESTED/NOT APPLICABLE. Publish no grant/upload/download capability URL, Secret, customer IP, full webhook or raw business payload.

Record original → temporary → restored nonsecret AI allowlist/scope, file/image sample TTL and quiet setting values. Verify restoration by actual reread; restoring a versioned setting creates a new legitimate version. Do not force its version number backward. Revoke this Work Unit's active invitations, confirm pending multipart disposition, retain accepted files for their applicable policy, preserve unknown chats/data and confirm no unintended Admin session remains.

The final report must state final GitHub SHA; candidate/main run URLs; Formal Review verdict; Staging deployment/version/100%/provenance; completed matrix and unpassed rows; real large-file/integrity/download evidence; file/image retention and cleanup; genuine AI answers/handoff; Admin; bidirectional support; knowledge/learning; reliability/security/recovery; and temporary-setting restoration.

Only all applicable executable functions passing permits `CZ2128 FULL STAGING ACCEPTED`. Any genuine remaining failure, blocker or uncompleted required acceptance means `CZ2128 FULL STAGING PARTIAL`, with the remaining rows and evidence. No Production/release workflow follows automatically from either verdict.
