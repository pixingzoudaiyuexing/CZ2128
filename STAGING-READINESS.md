# CZ2128 Staging Readiness

Status: **PHASE 4C NOT STARTED / PREPARATION ONLY**

This is a non-sensitive readiness checklist based on the completed 4C-0A read-only inventory. It is not a staging configuration, provision plan, deployment approval or test result.

## Current Ground Truth

- Phase 4B-5 was accepted, completed, frozen and merged by PR #15 as `d6e111cbf79e4a64a396c749d60821d6a5a6d7f8`.
- `62c7c51120ad4d44fcdc4cff089173258b719c28` is the historical pre-PR #15 implementation base; it is not the completed documentation merge baseline.
- Phase 4C has not started implementation. 4C-0A completed only a read-only environment inventory.
- `wrangler.toml` declares expected bindings, not evidence that any remote resource exists.
- [PREPRODUCTION-ACCEPTANCE.md](PREPRODUCTION-ACCEPTANCE.md) contains 23 independent real-environment acceptance items. All still require their specified evidence.
- Production remains **NOT DEPLOYED**. Production `DLQ_QUARANTINE` remains **NOT PROVISIONED / NOT VALIDATED**.

## Resource Inventory

| Resource | Current status | Known non-sensitive identity | Required evidence before use |
| --- | --- | --- | --- |
| Cloudflare account/profile | VERIFIED | One Owner-authorized account/profile; secret and personal identifiers excluded | Dedicated least-privilege 4C-1 execution profile |
| 4C staging Worker | VERIFIED ABSENT at audit time | Approved `cz2128-4c-staging`; legacy `cz2128-staging` exists separately | Recheck absence immediately before creation |
| 4C staging D1 | VERIFIED ABSENT at audit time | Approved `cz2128-4c-staging-db`; legacy D1 has only `0001`–`0004` | Recheck absence; record new UUID independently |
| 4C main Queue / DLQ | VERIFIED ABSENT at audit time | Approved `cz2128-4c-staging-queue` / `cz2128-4c-staging-dlq` | Recheck absence and verify new consumer topology |
| 4C attachment R2 | VERIFIED ABSENT at audit time | Approved `cz2128-4c-staging-attachments`; legacy bucket exists separately | Recheck absence, privacy and lifecycle after creation |
| 4C DLQ quarantine R2 | VERIFIED ABSENT at audit time | Approved `cz2128-4c-staging-dlq-quarantine`; legacy quarantine is absent | Recheck absence; approve retention before lifecycle |
| Chatwoot test instance/inbox | UNKNOWN | None recorded | Isolated instance/account/inbox and owner |
| Telegram Support Bot | UNKNOWN | None recorded | Dedicated Bot identity and owner declaration |
| Telegram Admin Bot | UNKNOWN | None recorded | Dedicated Bot identity and owner declaration |
| Telegram forum group | UNKNOWN | None recorded | Isolated forum group and owner declaration |
| AI project/model/budget | UNKNOWN | None recorded | Dedicated project/key custodian, model and call/cost budget |
| Staging webhook/hostname | UNKNOWN | Routes are defined in code only | Isolated hostname/path/secret ownership |
| Monitoring/audit | UNKNOWN for staging | D1 reliability audit exists in code | Sink, alerts, access policy and owner |
| Evidence storage | UNKNOWN | None recorded | Private location, readers, retention and deletion approver |
| Retention/cleanup owner | UNKNOWN | Code defines attachment TTL/cleanup only | Responsible operator and approved cleanup policy |

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

The approved fresh names `cz2128-4c-staging`, `cz2128-4c-staging-db`, `cz2128-4c-staging-queue`, `cz2128-4c-staging-dlq`, `cz2128-4c-staging-attachments` and `cz2128-4c-staging-dlq-quarantine` were each verified absent at the 4C-0B audit time. Absence must be rechecked immediately before any future write.

## Mandatory Isolation

- Staging Worker, D1, Queue, DLQ, attachment R2 and quarantine R2 must be separate from production.
- Staging Chatwoot must use a dedicated test account/inbox and must not receive real customer webhooks.
- Support Bot and Admin Bot must use different tokens; test forum groups must contain no real support traffic.
- Staging webhook paths, secrets and hostnames must not reuse production credentials.
- Test data must be synthetic; never copy customer messages, attachments, webhook payloads or private URLs.
- AI project/key/model and call/cost budget must be approved before any provider-visible test.
- Every provider-visible mutation requires a later, separate authorization and predeclared budget.

## Owner Decisions Required

1. Use a separate Cloudflare account, or one account with strictly separate staging resources and environment-level permissions.
2. Identify the exact CZ2128 staging account/profile allowed for later read-only metadata verification.
3. Identify existing test resources and their owners, or approve a later 4C-1 provisioning task.
4. Assign credential custody and least-privilege administration without placing secret values in Git, PRs or chat.
5. Approve test budgets and the private evidence-storage location.
6. Assign test-data retention, cleanup and deletion approval responsibility.

## 4C Gates

### 4C-0B: Authorized Metadata Verification

Only after an exact staging account/profile, allowed resource scope and owner authorization are recorded may an operator perform read-only remote metadata queries. No deployment, provision, migration, export/restore, Queue/R2 mutation, provider call or test message is authorized by this gate.

### 4C-1: Staging Foundation

Creating isolated resources, applying migrations, deploying a Worker, configuring webhooks or allocating budget requires a separate Primary approval after 4C-0B has verified the intended environment. The approval must define resource names, isolation, access scope, cost limit, cleanup plan and stop conditions.

Engineering artifacts and remote execution gates are documented in [STAGING-DEPLOYMENT.md](STAGING-DEPLOYMENT.md). Preparing those artifacts does not authorize a remote write.
