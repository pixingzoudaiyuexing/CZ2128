# CZ2128 Staging Readiness

Status: **PHASE 4C IN EXECUTION / STAGING FOUNDATION DEPLOYED / SCOPED CRISP-02 THROUGH CRISP-05 EVIDENCE RECORDED / PRODUCTION NOT AUTHORIZED**

This document began as a non-sensitive readiness checklist based on the completed 4C-0A/4C-0B read-only inventory. The historical pre-provisioning snapshot is retained below for traceability. Read-only reconciliation on 2026-09-23 now records the later staging foundation plus the bounded Crisp-02, Crisp-03, Crisp-04 and Crisp-05 evidence accepted or retained by Primary. This document is not a production deployment approval and does not authorize any new acceptance run.

## Current Ground Truth

- Phase 4B-5 was accepted, completed, frozen and merged by PR #15 as `d6e111cbf79e4a64a396c749d60821d6a5a6d7f8`.
- `62c7c51120ad4d44fcdc4cff089173258b719c28` is the historical pre-PR #15 implementation base; it is not the completed documentation merge baseline.
- Phase 4C is now in execution. The isolated `cz2128-4c-staging*` foundation exists and has a deployed Worker; the earlier 4C-0A/4C-0B “absent” findings remain historical pre-creation evidence rather than current state.
- Crisp-06 read-only deployment metadata verifies the latest `cz2128-4c-staging` Worker version as `4d13f217-bd80-4c7c-a6bf-8ed13669be77`. The accepted Stage B deployment record binds that version to exact main merge `d635520b1cde7a49e75ef5f658c862d5e856c5db`; no deployment is performed by this reconciliation.
- D1 `cz2128-4c-staging-db` exists as UUID `6482f216-5357-4e93-9796-89eaf0c1299c`; Crisp-06 read-only durable migration metadata lists exactly `0001_initial_schema.sql` through `0007_crisp_upload_invites.sql`, including `0006_crisp_attachment_provider.sql`. Wrangler reports no pending migration.
- Main Queue `cz2128-4c-staging-queue` exists as `6a4ed17bccbb4d6db22fb5cd8407eeb3` with the staging Worker as its one producer and one consumer. DLQ `cz2128-4c-staging-dlq` exists as `6ec943a39dfe461ba33504593a5692f0` with the staging Worker as its one consumer.
- R2 buckets `cz2128-4c-staging-attachments` and `cz2128-4c-staging-dlq-quarantine` exist. Read-only lifecycle metadata verifies the frozen attachment rules: `attachments/` expires after seven days and incomplete multipart uploads abort after seven days. No quarantine object-expiry rule was observed; only the default incomplete-multipart abort rule was listed.
- The current Worker has progressed beyond the original provider-disconnected foundation gate and has configured Crisp and Telegram bindings/secrets by name. Historical Chatwoot bindings/secrets also remain present for compatibility; their presence is not Chatwoot acceptance evidence.
- Primary-accepted / retained scoped Staging evidence now covers: Crisp-02 basic support and Picker/fingerprint/handoff; Crisp-03 AI happy-path delivery plus handoff trigger fencing; Crisp-04 Crisp close/reopen to the same Telegram Topic; and Crisp-05 attachment transport plus the Stage B temporary ordinary-file upload/download, TTL and revoke flow. Each scope is bounded in `PREPRODUCTION-ACCEPTANCE.md`; none is a claim of platform-wide reliability or Production acceptance.
- `wrangler.toml` and templates remain declarations, not remote evidence; the current facts above come from read-only remote metadata/D1 inspection and exact Git/CI evidence.
- [PREPRODUCTION-ACCEPTANCE.md](PREPRODUCTION-ACCEPTANCE.md) still contains exactly 23 independent matrix items. The Crisp-02 through Crisp-05 sections are scoped evidence records; broader rows remain NOT VALIDATED unless their own complete criteria are met.
- Production remains **NOT DEPLOYED**. Production `DLQ_QUARANTINE` remains **NOT PROVISIONED / NOT VALIDATED**.

## Resource Inventory

| Resource | Historical 4C-0B finding | Current reconciled status (2026-09-23) | Known non-sensitive identity / remaining evidence |
| --- | --- | --- | --- |
| Cloudflare account/profile | VERIFIED for read-only inventory | VERIFIED for the current read-only queries | Owner-authorized account/profile; secret and personal identifiers excluded. Least-privilege policy remains an operational control for future writes. |
| 4C staging Worker | VERIFIED ABSENT at audit time | DEPLOYED / READ-ONLY VERIFIED | `cz2128-4c-staging`; latest version `4d13f217-bd80-4c7c-a6bf-8ed13669be77`; accepted Stage B deployment record ties it to main `d635520b1cde7a49e75ef5f658c862d5e856c5db`. |
| 4C staging D1 | VERIFIED ABSENT at audit time | CREATED / MIGRATED / READ-ONLY VERIFIED | `cz2128-4c-staging-db`; UUID `6482f216-5357-4e93-9796-89eaf0c1299c`; migrations exactly `0001`–`0007`. |
| 4C main Queue / DLQ | VERIFIED ABSENT at audit time | CREATED / TOPOLOGY PARTIALLY READ-ONLY VERIFIED | Main `6a4ed17bccbb4d6db22fb5cd8407eeb3`; DLQ `6ec943a39dfe461ba33504593a5692f0`; current producer/consumer ownership verified. Real duplicate/concurrency/retry-exhaustion behavior remains NOT VALIDATED. |
| 4C attachment R2 | VERIFIED ABSENT at audit time | CREATED / LIFECYCLE METADATA VERIFIED / STAGING PARTIAL DATA-PLANE EVIDENCE | `cz2128-4c-staging-attachments`; seven-day `attachments/` expiry and incomplete-multipart abort rules listed. Crisp-05 proved bounded private object write/read and a controlled download, but real multipart-at-limit, HEAD/Range/delete and long-term cleanup behavior remain NOT VALIDATED. |
| 4C DLQ quarantine R2 | VERIFIED ABSENT at audit time | CREATED / BOUND / LIFECYCLE METADATA READ | `cz2128-4c-staging-dlq-quarantine`; no object-expiry rule observed. Real quarantine capture/fault behavior remains NOT VALIDATED. |
| Chatwoot test instance/inbox | UNKNOWN | HISTORICAL COMPATIBILITY / NOT VALIDATED | Chatwoot secrets remain on the Worker, but D-022 makes Crisp the sole active helpdesk target. Do not infer real Chatwoot acceptance. |
| Telegram Support Bot | UNKNOWN | REAL SCOPED CRISP FLOWS OBSERVED | Crisp-02 text/Picker, Crisp-03 AI mirror/handoff, Crisp-04 close/reopen and Crisp-05 attachment/upload notifications produced real Telegram effects. Rotation, group migration and complete bot-identity acceptance remain NOT VALIDATED. |
| Telegram Admin Bot | UNKNOWN | NOT VALIDATED | No Admin-flow acceptance was performed by Crisp-02. |
| Telegram forum group | UNKNOWN | REAL SCOPED TOPIC/LIFECYCLE/ATTACHMENT FLOWS OBSERVED | Crisp-04 proved same-topic close/reopen on Topics 89 and 95; Crisp-05 used Topics 103 and 117 without duplicate topic creation. Group migration remains NOT VALIDATED. |
| AI project/model/budget | UNKNOWN | STAGING PARTIAL | Crisp-03 proved one real AI SUCCESS / Crisp delivery / Telegram mirror and post-handoff trigger suppression. Real provider failure/retry exhaustion, budget/load and historical redrive remain NOT VALIDATED. |
| Staging webhook/hostname | UNKNOWN | CRISP INGRESS OPERATIONAL; EXACT PUBLIC IDENTITY NOT RECORDED HERE | Real signed Crisp ingress reached the staging Worker/Queue/D1. This document intentionally does not record private URLs/secrets. |
| Monitoring/audit | UNKNOWN for staging | D1 AUDIT USED; OPERATIONS MONITORING NOT VALIDATED | Durable Crisp HTTP-400 diagnostics and handoff audit exist; alerting/incident-response acceptance remains NOT VALIDATED. |
| Evidence storage | UNKNOWN | TASK/PROJECT RECORDS EXIST; RETENTION OWNER NOT RECORDED HERE | Keep evidence private and sanitized; no credential/raw-payload evidence belongs in Git. |
| Retention/cleanup owner | UNKNOWN | NOT VALIDATED | Lifecycle metadata exists, but scheduled cleanup and operational ownership remain NOT VALIDATED. |

Binding declarations alone do not prove remote resource existence. Production quarantine's known NOT PROVISIONED state must not be used to infer staging quarantine status.

## 4C-0B Verified Snapshot

The Owner-authorized account has one identified default OAuth profile. Its permissions are broader than the least privilege required for routine staging deployment, so it was used only for the authorized read-only inventory.

Verified existing legacy CZ2128 staging resources:

- `cz2128-staging` Worker, last deployed during Phase 3/3.5; exact current Git SHA is not recorded.
- `cz2128-staging-db`, with migration metadata showing only `0001`–`0004`.
- `cz2128-staging-queue`, whose producer and consumer are the legacy Worker.
- `cz2128-staging-dlq`, with no current consumer.
- `cz2128-staging-attachments`, empty at audit time and configured with the frozen 7-day lifecycle.
- No `cz2128-staging-dlq-quarantine` bucket and no quarantine binding on the legacy Worker.

These legacy resources remain historical staging evidence. They must not be upgraded, reused, emptied or deleted by 4C-1.

The approved fresh names `cz2128-4c-staging`, `cz2128-4c-staging-db`, `cz2128-4c-staging-queue`, `cz2128-4c-staging-dlq`, `cz2128-4c-staging-attachments` and `cz2128-4c-staging-dlq-quarantine` were each verified absent at the 4C-0B audit time. That statement is retained as historical pre-creation evidence; these resources now exist and must not be recreated, adopted by name alone, emptied or replaced as a continuation of the old Gate A checklist.

## Mandatory Isolation

- Staging Worker, D1, Queue, DLQ, attachment R2 and quarantine R2 must be separate from production.
- Crisp is the sole active helpdesk target. Any current Crisp staging identity must remain isolated from production/customer traffic. The historical Chatwoot isolation rule applies only if Primary separately authorizes a compatibility test; it is not a prerequisite for the scoped Crisp-02 through Crisp-05 evidence.
- Support Bot and Admin Bot must use different tokens; test forum groups must contain no real support traffic.
- Staging webhook paths, secrets and hostnames must not reuse production credentials.
- Test data must be synthetic; never copy customer messages, attachments, webhook payloads or private URLs.
- AI project/key/model and call/cost budget must be approved before any future AI-provider test.
- Every future provider-visible mutation requires its own authorization and predeclared budget; the already completed Crisp-02 through Crisp-05 mutations are historical evidence, not standing authority.

## Owner Decisions Required

The original 4C-0B decisions below were preconditions for foundation creation. They are retained for provenance and are not automatically reintroduced as blockers for the already-created, independently identified staging foundation:

1. Use a separate Cloudflare account, or one account with strictly separate staging resources and environment-level permissions.
2. Identify the exact CZ2128 staging account/profile allowed for later read-only metadata verification.
3. Identify existing test resources and their owners, or approve a later 4C-1 provisioning task.
4. Assign credential custody and least-privilege administration without placing secret values in Git, PRs or chat.
5. Approve test budgets and the private evidence-storage location.
6. Assign test-data retention, cleanup and deletion approval responsibility.

For future Phase 4C rows, only the approvals, budgets, credentials, retention owners and fault/test scopes actually required by that row remain to be decided. This reconciliation does not authorize them.

## 4C Gates

The gates below are the historical foundation execution contract. They explain how the currently existing staging resources were intended to be created and accepted; they are not instructions to replay resource creation or deployment during later reconciliation work.

### 4C-0B: Authorized Metadata Verification

Only after an exact staging account/profile, allowed resource scope and owner authorization are recorded may an operator perform read-only remote metadata queries. No deployment, provision, migration, export/restore, Queue/R2 mutation, provider call or test message is authorized by this gate.

### 4C-1: Staging Foundation

Creating isolated resources, applying migrations, deploying a Worker, configuring webhooks or allocating budget requires a separate Primary approval after 4C-0B has verified the intended environment. The approval must define resource names, isolation, access scope, cost limit, cleanup plan and stop conditions.

Engineering artifacts and remote execution gates are documented in [STAGING-DEPLOYMENT.md](STAGING-DEPLOYMENT.md). Preparing those artifacts does not authorize a remote write.