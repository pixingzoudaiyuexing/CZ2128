# CZ2128 4C Staging Foundation Deployment Plan

Status: **HISTORICAL FOUNDATION PLAN / STAGING DEPLOYED / READ-ONLY RECONCILED 2026-09-23**

Historical engineering baseline: `29e20c0649b73f7aaed8ff7901cd9fc4106a683e`

This document originally prepared a new, provider-disconnected staging foundation. The Gate A–F text is retained as the historical execution contract and must not be replayed merely because this document is being reconciled. The staging foundation has since been created and the Worker has progressed through separately bounded Crisp-02, Crisp-03, Crisp-04 and Crisp-05 validation. This document still does not authorize any new resource creation, migration, deployment, secret/webhook change, Provider call, Queue mutation or cleanup.

Related documents:

- [Staging Readiness](STAGING-READINESS.md)
- [Pre-Production Acceptance Matrix](PREPRODUCTION-ACCEPTANCE.md)
- [Migration, Backup and Recovery](MIGRATION-RECOVERY.md)
- [Reliability Operations Runbook](RELIABILITY-RUNBOOK.md)

## 1. Approved Resource Boundary

| Resource | Exact staging name | Current read-only evidence (2026-09-23) |
| --- | --- | --- |
| Worker | `cz2128-4c-staging` | Crisp-06 read-only deployment list shows latest version `4d13f217-bd80-4c7c-a6bf-8ed13669be77`; the accepted Stage B deployment record ties it to exact main `d635520b1cde7a49e75ef5f658c862d5e856c5db`. |
| D1 | `cz2128-4c-staging-db` | UUID `6482f216-5357-4e93-9796-89eaf0c1299c`; read-only `d1_migrations` lists exactly `0001`–`0007`, including the Crisp attachment/upload migrations; no migration is pending. |
| Main Queue | `cz2128-4c-staging-queue` | ID `6a4ed17bccbb4d6db22fb5cd8407eeb3`; staging Worker is the one producer and one consumer. |
| DLQ | `cz2128-4c-staging-dlq` | ID `6ec943a39dfe461ba33504593a5692f0`; staging Worker is the one consumer. |
| Attachment R2 | `cz2128-4c-staging-attachments` | Exists; `attachments/` expires after seven days and incomplete multipart uploads abort after seven days. |
| Quarantine R2 | `cz2128-4c-staging-dlq-quarantine` | Exists and is bound; no object-expiry lifecycle was observed in the current listing. |

Historical Gate A required re-confirming the exact Cloudflare account and proving all six names absent before the first write. That requirement remains part of the creation record, not a current instruction: all six approved 4C resources now exist. A matching name alone is still never proof of ownership. Do not modify, reuse, empty or delete legacy `cz2128-staging-*`, unsuffixed `cz2128*`, production or other-project resources.

### 1A. Current Deployment / Acceptance Snapshot

- Exact current main before Crisp-06: `d635520b1cde7a49e75ef5f658c862d5e856c5db` (PR #36 merge). The accepted Stage B deployment record used this exact main tree.
- Exact latest Worker version independently re-read by Crisp-06: `4d13f217-bd80-4c7c-a6bf-8ed13669be77`.
- Compatibility date/flag: `2024-03-20` / `nodejs_compat`.
- Current resource bindings point to the 4C D1, main Queue and two 4C R2 buckets listed above; runtime Queue identity variables name the 4C main Queue and DLQ.
- Provider secret **names** are now configured for Crisp and Telegram. Historical Chatwoot secret names also remain. Secret values were not read or recorded by this reconciliation.
- The current evidence record now contains separately bounded Crisp-02 basic support, Crisp-03 AI/handoff, Crisp-04 lifecycle and Crisp-05 attachment/upload scopes described in [PREPRODUCTION-ACCEPTANCE.md](PREPRODUCTION-ACCEPTANCE.md). Those scopes do not accept the whole R2/proxy/cleanup matrix, real Queue/D1 concurrency/fault injection, Admin recovery, load/multi-region or Production.

## 2. Configuration Artifacts

`wrangler.staging.template.jsonc` is intentionally non-deployable. Its D1 ID is `REPLACE_WITH_CZ2128_4C_STAGING_D1_UUID`, which is not a valid UUID.

The template declares:

- Worker entry `src/index.ts`, compatibility date `2024-03-20` and `nodejs_compat`;
- Workers.dev enabled, preview URLs disabled and no custom route/domain;
- one D1 `DB` binding and migration directory `migrations`;
- one `QUEUE` producer for the staging main Queue;
- main Queue and DLQ consumers, with three main-queue retries and the exact main-to-DLQ relationship;
- `ATTACHMENTS_BUCKET` and `DLQ_QUARANTINE` R2 bindings;
- hourly cron `0 * * * *`;
- exactly two non-sensitive Queue identity variables matching the staging Queue and DLQ bindings;
- no other plaintext variables, secrets, Provider identities or webhook configuration.

The generated `wrangler.staging.jsonc` is ignored by Git. In the historical foundation flow, after D1 creation an authorized operator could create it locally from the template and replace only the D1 placeholder with the independently recorded D1 UUID. The generated file is not present in the current checkout, so this reconciliation does not claim to have revalidated that historical local artifact.

Local checks:

```bash
npm run validate:staging-template
```

Strict final-config validation requires the same independently recorded UUID through both the config and command input:

```bash
STAGING_D1_ID="REPLACE_WITH_RECORDED_STAGING_D1_UUID"

if [[ "$STAGING_D1_ID" == REPLACE_WITH_* ]]; then
  printf '%s\n' 'Replace STAGING_D1_ID with the independently recorded staging D1 UUID.'
else
  npm run validate:staging -- --config wrangler.staging.jsonc --expected-d1-id "$STAGING_D1_ID"
fi
```

Passing validation proves static configuration structure only. It does not prove resource ownership, existence, migration, deployment or runtime behavior.

## 3. Historical Provider-Disconnected Startup Gate

At the original infrastructure-only deployment gate, the Worker was required not to configure Chatwoot, Telegram or AI credentials and not to register any webhook. The template contains no Provider variables or secrets. This was a startup isolation requirement, not a permanent description of the staging Worker.

Expected behavior before 4C-2:

- AI remains disabled because no complete AI profile exists.
- Admin webhook remains unavailable without complete Admin bootstrap settings.
- No Provider webhook points to staging, so no Provider event enters the Queues.
- Empty Queue/D1/R2 resources prevent Provider-visible work.
- The hourly cleanup handler may inspect the empty D1/R2 attachment set but has no external Provider action.

If the Worker cannot deploy or serve an inert route without Provider credentials, stop and return to Primary. Do not fill missing values with production credentials and do not modify frozen reliability behavior in the infrastructure task.

Current reconciliation note: the staging Worker has since progressed past this gate and now has provider secret names configured; real bounded Crisp/Telegram traffic has been recorded through Crisp-05. This does not retroactively change the original zero-provider-mutation Gate A–F evidence, authorize another deployment, or validate retained historical Chatwoot settings / broader untested reliability scopes.

## 4. Historical Permission and Credential Boundary

At foundation-planning time, the default OAuth profile had broad write permissions and was not the intended default deployment identity for 4C-1. The least-privilege principles below remain valid for future authorized writes, but they are not a request to recreate the already-existing foundation.

Before remote execution, create or designate a staging-only execution identity with:

- access limited to the approved Owner account;
- only the Workers, D1, Queues and R2 permissions needed by the authorized gate;
- route/zone permission omitted while Workers.dev is sufficient;
- secrets permission omitted until a separately approved bootstrap/provider task requires it;
- no production credential values and no credentials committed to Git, PRs, logs or evidence packages.

If Cloudflare cannot restrict a permission to individual resources, use a dedicated profile, exact command allowlist, reviewed config and two-person verification of account/resource identity before each write.

## 5. Historical Remote Execution Gates — Do Not Replay

These gates preserve the original foundation creation/acceptance sequence. They are historical provenance for resources that now exist. Do not re-create resources, re-apply migrations, redeploy, or repeat Provider-disconnected acceptance merely to make the old plan read like current state.

At execution time, each gate required a separate Primary authorization. Completing one gate did not authorize the next.
The six-resource foundation is created across Gate A and Gate E: Gate A creates the five backing resources, while the first reviewed Worker deployment in Gate E creates the Worker resource.

### Gate A: Create Five Backing Resources and Reserve Worker Identity

**Preconditions**

- Exact account fingerprint, owner, monthly Cloudflare budget and executor are recorded.
- All six names are rechecked and still absent.
- Attachment and quarantine retention decisions are approved.

**Allowed scope**

- Create only the D1, two Queues and two R2 buckets listed in Section 1.
- Create DLQ before main Queue so the dead-letter relationship can be configured safely.
- Reconfirm the Worker name is absent, but do not create or deploy the Worker in this gate.

**Permissions**

- Account read plus narrowly scoped D1, Queues and R2 create permissions. Worker write is not needed until deployment.

**Evidence**

- Non-sensitive backing-resource IDs, creation timestamps, account fingerprint, empty-resource metadata and Worker-name absence.

**Stop conditions**

- Name conflict, paid-plan escalation, unexpected region/jurisdiction, non-empty resource or wrong account.

**Failure handling**

- Stop without deleting, emptying or recreating anything. Record which resources were created and return to Primary.
- Continuation requires the previous authorization record, the same account identity, each created resource's exact ID and creation evidence, current metadata matching that record, and a new Owner/Primary continuation authorization.
- Treat an existing same-name resource as a conflict unless that complete chain of evidence proves it is the resource created by the interrupted Gate A. Never adopt an identity-unknown resource.

### Gate B: Finalize and Review Configuration

**Preconditions**

- Gate A D1 ID is independently recorded.
- Local `wrangler.staging.jsonc` is generated from the reviewed template.

**Allowed scope**

- Replace only the D1 placeholder; run strict validator and Wrangler `deploy --dry-run` with the staging config.
- Confirm the two Queue identity variables exactly match the producer, main consumer, DLQ consumer and main-to-DLQ relationship.

**Permissions**

- No Cloudflare write permission is needed for validator or dry-run.

**Evidence**

- Template hash, exact Git SHA, strict validator output, dry-run bindings and zero secret/plaintext-variable findings.

**Stop conditions**

- Any legacy/production name, D1 mismatch, missing binding, route, plaintext secret or unexpected generated change.

**Failure handling**

- Do not edit remote resources. Correct the reviewed config in a normal PR or return to Primary if scope changes.

### Gate C: Apply D1 Migrations

**Preconditions**

- Exact new D1 identity is confirmed from both resource evidence and strict config validation.
- D1 is empty; migration list shows exactly `0001`–`0005` pending and no unknown migration.
- Separate D1 mutation authorization is recorded.

**Allowed scope**

- Apply repository migrations `0001` through `0005` once to the new D1.

**Permissions**

- D1 read/write on the approved account only.

**Evidence**

- Before/after migration lists, exact filenames, timestamps, resulting schema/integrity metadata and zero business test data.

**Stop conditions**

- Existing business rows, partial/unknown schema, wrong UUID, migration `0006`, failed migration or concurrent Worker traffic.

**Failure handling**

- Preserve output and Time Travel metadata; do not rerun blindly, edit business data, down-migrate or restore. Return to Primary under `MIGRATION-RECOVERY.md`.

### Gate D: Configure R2 Lifecycle

**Preconditions**

- Both exact buckets are empty and private.
- Separate R2 mutation authorization is recorded.

**Allowed scope**

- Attachment bucket: prefix `attachments/`, expire after 7 days and abort incomplete multipart uploads after 7 days.
- Quarantine bucket: no automatic expiry until Primary approves a dedicated sanitized-evidence retention period.

**Evidence**

- Bucket identity, private-access metadata and lifecycle listing.

**Stop conditions**

- Existing objects, public access, wrong bucket, unexpected lifecycle or unapproved quarantine expiry.

**Failure handling**

- Stop without deleting objects or rules. Return exact metadata to Primary.

### Gate E: Deploy Exact Worker SHA

**Preconditions**

- Gates A-D pass; config PR and independent review are accepted.
- Exact deployment SHA and staging-only execution profile are recorded.
- Queues are empty and no Provider webhook points to staging.
- Separate deployment authorization is recorded.

**Allowed scope**

- Create the sixth resource by deploying the exact reviewed SHA to the previously absent `cz2128-4c-staging` Worker name, using only `wrangler.staging.jsonc`.
- Configure no Provider or Admin credentials.

**Permissions**

- Workers script write plus binding/consumer permissions for the approved resources only.

**Evidence**

- Worker version/deployment ID, exact SHA record, handler list, compatibility settings, four expected resource bindings, two approved Queue identity variables and two expected Queue consumers.

**Stop conditions**

- Remote drift, wrong account/name, unexpected secret/route, Queue identity variable/binding mismatch, missing DLQ consumer/quarantine binding or non-empty Queue.

**Failure handling**

- Do not deploy another version or roll back automatically. Preserve deployment/config evidence and return to Primary.

### Gate F: Read-Only Foundation Acceptance

**Preconditions**

- Gate E reports one active reviewed deployment.

**Allowed scope**

- Read deployment/version metadata, D1 migration metadata, Queue producer/consumer metadata, R2 bucket/lifecycle metadata and the assigned Workers.dev hostname.
- Perform only inert HTTP requests that cannot enqueue or call a Provider, such as `GET /`, with expected non-success method/routing response.

**Evidence**

- Exact resource IDs/names, active version, handlers, bindings, five migration names, Queue topology, private buckets/lifecycle and inert HTTP status/headers.

**Stop conditions**

- Provider request, Queue mutation, missing/extra binding, unexpected data, unexpected route or any production identifier.

**Failure handling**

- Stop. Do not purge Queue, edit D1, replay quarantine, add secrets or send test messages.

## 6. Cost, Retention and Cleanup

- Historical Gate A required Owner/Primary approval of a monthly Cloudflare budget. No paid upgrade was implied by existing account access.
- Historical 4C-1 had a Provider/AI/message mutation budget of exactly zero.
- Attachment R2 follows the frozen 7-day orphan lifecycle while application authorization remains 24 hours.
- Proposed staging quarantine retention: retain sanitized evidence for 30 days, then lifecycle-expire only prefix `terminal-dlq/v1/`. This is a proposal, not authorization. Until Primary accepts a period, configure no quarantine expiry and do not start fault tests that could create quarantine objects.
- Use synthetic identifiers only. No production customer data may be copied into D1, R2, Queue or evidence storage.
- Resource deletion, Queue purge, D1 restore/export and old-staging cleanup are separate operations requiring explicit authorization.

## 7. Isolation Proof Checklist

At the original 4C-1 foundation acceptance point, all of the following were required:

- every resource name starts with `cz2128-4c-staging`;
- D1 UUID in strict config equals independently recorded Gate A evidence;
- active Worker is the approved sixth resource and references only the five approved backing resources;
- legacy `cz2128-staging-*` and unsuffixed resources show zero changes from the preflight snapshot;
- no Provider/Admin secrets, webhook routes or custom domains are configured;
- Queue metadata shows one main producer/consumer, one DLQ consumer and the main-to-DLQ relationship;
- runtime Queue identity variables exactly match those bindings, and legacy/staging cross-environment receipts are rejected by reviewed regression tests;
- R2 buckets are private and attachment lifecycle matches the frozen rule;
- D1 migration metadata contains exactly `0001`–`0005`;
- all evidence references the exact reviewed Git SHA and staging account fingerprint;
- no matrix item requiring a real Provider was marked PASS at the provider-disconnected foundation stage.

That final bullet is intentionally historical. Subsequent authorized work progressed to Crisp-02 and produced Primary-accepted, scoped real Crisp/Telegram basic-support evidence. The current acceptance state is recorded in [PREPRODUCTION-ACCEPTANCE.md](PREPRODUCTION-ACCEPTANCE.md); it must not be projected onto unrelated rows.