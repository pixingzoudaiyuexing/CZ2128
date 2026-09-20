# CZ2128 4C Staging Foundation Deployment Plan

Status: **ENGINEERING PREPARED / REMOTE EXECUTION NOT AUTHORIZED**

Engineering baseline: `29e20c0649b73f7aaed8ff7901cd9fc4106a683e`

This plan prepares a new, provider-disconnected staging foundation. It does not authorize resource creation, remote migration, deployment, secrets, webhook changes, Provider calls, Queue mutation or cleanup.

Related documents:

- [Staging Readiness](STAGING-READINESS.md)
- [Pre-Production Acceptance Matrix](PREPRODUCTION-ACCEPTANCE.md)
- [Migration, Backup and Recovery](MIGRATION-RECOVERY.md)
- [Reliability Operations Runbook](RELIABILITY-RUNBOOK.md)

## 1. Approved Resource Boundary

| Resource | Exact staging name |
| --- | --- |
| Worker | `cz2128-4c-staging` |
| D1 | `cz2128-4c-staging-db` |
| Main Queue | `cz2128-4c-staging-queue` |
| DLQ | `cz2128-4c-staging-dlq` |
| Attachment R2 | `cz2128-4c-staging-attachments` |
| Quarantine R2 | `cz2128-4c-staging-dlq-quarantine` |

Before every future write, re-confirm the exact Cloudflare account and prove all six names remain absent. Stop if any name exists or resolves outside the approved account. Do not modify, reuse, empty or delete legacy `cz2128-staging-*`, unsuffixed `cz2128*`, production or other-project resources.

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
- no plaintext vars, secrets, Provider identities or webhook configuration.

The generated `wrangler.staging.jsonc` is ignored by Git. After D1 creation, an authorized operator may create it locally from the template and replace only the D1 placeholder with the independently recorded D1 UUID.

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

## 3. Provider-Disconnected Startup

The infrastructure-only Worker deployment must not configure Chatwoot, Telegram or AI credentials and must not register any webhook. The template contains no Provider variables or secrets.

Expected behavior before 4C-2:

- AI remains disabled because no complete AI profile exists.
- Admin webhook remains unavailable without complete Admin bootstrap settings.
- No Provider webhook points to staging, so no Provider event enters the Queues.
- Empty Queue/D1/R2 resources prevent Provider-visible work.
- The hourly cleanup handler may inspect the empty D1/R2 attachment set but has no external Provider action.

If the Worker cannot deploy or serve an inert route without Provider credentials, stop and return to Primary. Do not fill missing values with production credentials and do not modify frozen reliability behavior in the infrastructure task.

## 4. Permission and Credential Boundary

The current default OAuth profile has broad write permissions and is not the default deployment identity for 4C-1.

Before remote execution, create or designate a staging-only execution identity with:

- access limited to the approved Owner account;
- only the Workers, D1, Queues and R2 permissions needed by the authorized gate;
- route/zone permission omitted while Workers.dev is sufficient;
- secrets permission omitted until a separately approved bootstrap/provider task requires it;
- no production credential values and no credentials committed to Git, PRs, logs or evidence packages.

If Cloudflare cannot restrict a permission to individual resources, use a dedicated profile, exact command allowlist, reviewed config and two-person verification of account/resource identity before each write.

## 5. Remote Execution Gates

Each gate requires a separate Primary authorization. Completing one gate does not authorize the next.
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

- Stop without deleting anything. Record which resources were created and return to Primary for cleanup/continuation authorization.

### Gate B: Finalize and Review Configuration

**Preconditions**

- Gate A D1 ID is independently recorded.
- Local `wrangler.staging.jsonc` is generated from the reviewed template.

**Allowed scope**

- Replace only the D1 placeholder; run strict validator and Wrangler `deploy --dry-run` with the staging config.

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

- Worker version/deployment ID, exact SHA record, handler list, compatibility settings, four expected environment bindings and two expected Queue consumers.

**Stop conditions**

- Remote drift, wrong account/name, unexpected secret/route, missing DLQ consumer/quarantine binding or non-empty Queue.

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

- Owner/Primary must approve a monthly Cloudflare budget before Gate A. No paid upgrade is implied by existing account access.
- 4C-1 has a Provider/AI/message mutation budget of exactly zero.
- Attachment R2 follows the frozen 7-day orphan lifecycle while application authorization remains 24 hours.
- Proposed staging quarantine retention: retain sanitized evidence for 30 days, then lifecycle-expire only prefix `terminal-dlq/v1/`. This is a proposal, not authorization. Until Primary accepts a period, configure no quarantine expiry and do not start fault tests that could create quarantine objects.
- Use synthetic identifiers only. No production customer data may be copied into D1, R2, Queue or evidence storage.
- Resource deletion, Queue purge, D1 restore/export and old-staging cleanup are separate operations requiring explicit authorization.

## 7. Isolation Proof Checklist

4C-1 is ready for acceptance only when all are true:

- every resource name starts with `cz2128-4c-staging`;
- D1 UUID in strict config equals independently recorded Gate A evidence;
- active Worker is the approved sixth resource and references only the five approved backing resources;
- legacy `cz2128-staging-*` and unsuffixed resources show zero changes from the preflight snapshot;
- no Provider/Admin secrets, webhook routes or custom domains are configured;
- Queue metadata shows one main producer/consumer, one DLQ consumer and the main-to-DLQ relationship;
- R2 buckets are private and attachment lifecycle matches the frozen rule;
- D1 migration metadata contains exactly `0001`–`0005`;
- all evidence references the exact reviewed Git SHA and staging account fingerprint;
- no matrix item requiring a real Provider is marked PASS.
