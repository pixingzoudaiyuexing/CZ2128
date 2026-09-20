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
| Cloudflare account/profile | UNKNOWN | None recorded for CZ2128 staging | Explicit profile/account identity and owner authorization |
| Staging Worker | UNKNOWN | Repository declares `cz2128`; no staging environment recorded | Worker ID/name, environment, deployed SHA and owner |
| Staging D1 | UNKNOWN | Binding `DB`; repository ID is `local-dev-only` | Remote D1 ID, migration state and access scope |
| Main Queue / DLQ | UNKNOWN | Planned names `cz2128-queue` / `cz2128-dlq` | Queue IDs/configuration and owner |
| Attachment R2 | UNKNOWN | Planned `cz2128-attachments` | Bucket ID, private access and lifecycle evidence |
| DLQ quarantine R2 | UNKNOWN for staging | Planned `cz2128-dlq-quarantine` | Bucket ID and metadata-only access evidence |
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
