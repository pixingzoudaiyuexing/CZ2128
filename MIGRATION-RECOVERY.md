# CZ2128 Migration, Backup and Recovery

Status: **HISTORICAL PHASE 4B-5 BASELINE RETAINED / ATTACHMENT V2 RECOVERY CONTRACT IN PROGRESS**

This document defines recovery boundaries for the current repository. It is not a production change plan and grants no authority to restore D1, pause/purge Queue messages, change R2, roll back a deployment or edit canonical data.

The current work is limited to existing Staging. Production status statements in the frozen Phase 4B material below are historical; no Production inspection or mutation is authorized by the current task.

Frozen Phase 4B-4B runtime baseline: `8499a5d4eaa40d4461d1882aaf6f4e2ac93efa08`

Phase 4B-5 accepted documentation merge baseline: `d6e111cbf79e4a64a396c749d60821d6a5a6d7f8`

Historical pre-PR #15 implementation base: `62c7c51120ad4d44fcdc4cff089173258b719c28`

See [Reliability Operations Runbook](RELIABILITY-RUNBOOK.md) for state handling and [Pre-Production Acceptance Matrix](PREPRODUCTION-ACCEPTANCE.md) for uncompleted validation.

## 1. Capability Classification

| Capability | Current classification | Boundary |
| --- | --- | --- |
| Apply repository migrations forward | Implemented by Wrangler/repository CI | Production application requires separate deployment authorization |
| Clean local migration verification | Implemented and exercised in CI | Local evidence only |
| D1 metadata and migration inspection | Platform CLI capability verified by Wrangler help | Authorized account/environment required; remote behavior not exercised here |
| D1 export | Platform CLI capability verified by Wrangler help | Export contains sensitive application data; separate backup authorization and protected destination required |
| D1 Time Travel information | Platform CLI capability verified by Wrangler help | Read-only inspection; remote behavior not exercised here |
| D1 Time Travel restore | Platform capability exists | **REQUIRES SEPARATE AUTHORIZATION**; no CZ2128 orchestration or D1/R2/Queue atomicity |
| Runtime-config generic rollback | Implemented as a new monotonic D1 version | Not a database/schema/deployment rollback; excludes Support Bot and group keys |
| Support Bot rotation/group migration | Implemented dedicated Admin workflows | Provider-visible/high-impact; not a generic rollback path |
| Queue delivery pause/resume | Platform capability exists | **REQUIRES SEPARATE AUTHORIZATION**; not automated by this repository |
| Queue purge | Platform capability exists | **OPERATOR STOP** by default; destructive, loses evidence and is not a recovery method |
| D1 down migration | **NOT IMPLEMENTED** | No migration rollback files exist |
| R2 object/bucket rollback | **NOT IMPLEMENTED** | D1 restore cannot restore R2 |
| Quarantine-to-D1 import or replay | **NOT IMPLEMENTED** | Quarantine is terminal sanitized evidence only |
| Generic DLQ replay | **NOT IMPLEMENTED** | Only eligible historical `internal / ai_trigger` has confirmed Admin redrive |

## 2. Schema History

The historical Phase 4B recovery baseline was `0001` through `0005`. The current candidate forward migration inventory is `0001` through `0012`; use the actual reviewed Git inventory for any new rollout. Migrations `0006`–`0010` add Crisp attachment/upload/UX and knowledge/learning state. `0011_crisp_human_quiet.sql` adds only a nullable conversation notification clock and immutable human-message-time receipts. It does not backfill or modify existing conversations, Topic mappings, messages, attachments, runtime config or AI state. Apply 0011 before running the new Worker.

For the quiet-window Staging rollout, capture the existing Worker version, bindings, secret-name set, queues/cron, complete migration list and immediate pre-migration D1 Time Travel bookmark. Time Travel is the full-database recovery point, including FTS state; D1 portable export currently cannot export a database containing virtual tables. Do not drop FTS to manufacture an export. Any optional table-scoped export must be encrypted and its limited coverage stated. For the earlier 0011-only change, Worker-only rollback could ignore its extra clock/receipt fields and must leave the database/receipts intact; this narrow claim does not cover attachment v2. That earlier rollback restores the older notification behavior. Database restore is a separate destructive recovery action, not part of automatic code rollback.

| Migration | Durable contract introduced | Recovery concern |
| --- | --- | --- |
| `0001_initial_schema.sql` | Conversations, messages, event receipts and outbound operations | Base canonical identities and provider-side-effect ledger |
| `0002_ai_handoff.sql` | AI mode/generation/epoch and durable `ai_runs` | Old code may not understand later AI statuses or retry fields |
| `0003_attachments.sql` | Attachment metadata, status, expiry and private R2 identity | D1 metadata and R2 bytes are separate systems |
| `0004_runtime_config.sql` | Encrypted/plain runtime config, append-only history, Admin sessions/update receipts | Restoring D1 can rewind config generation and Admin idempotency state |
| `0005_reliability.sql` | Attempt evidence, reconciliation, parent-child retries, expanded AI states, audit and DLQ receipts | Rebuilds `ai_runs`; rolling compatibility retains legacy `FAILED`, but arbitrary code rollback is not proven safe |

Migration `0005` is covered by real local SQLite migration tests for row/identity preservation, legacy `FAILED`, new status compatibility, integrity and foreign keys. This is not production migration or restore evidence.

## 2A. Attachment transfer v2 migration 0012

`0012_attachment_transfer_v2.sql` adds columns and tables without rebuilding the old attachment/invite/item tables or dropping their CHECKs. Existing source identities, delivery ledger, row IDs and foreign-key audit relationships remain. Schema additivity is not a complete old-runtime compatibility guarantee.

| State | v2 representation | Recovery/compatibility rule |
| --- | --- | --- |
| Declared versus actual bytes | `declared_size_bytes` before storage; `stored_size_bytes` after verified admission | Old `size_bytes` stays null above 20 MiB because its historical CHECK remains. Never coerce that null to zero or use it as the only large-file size. |
| Storage and policy | Immutable `stored_at`, `retention_class`, `retention_expires_at`, full SHA-256 | 72-hour FILE/seven-day IMAGE defaults begin after completion/verification, not invite creation. A retry or grant renewal must not refresh retention. Existing historical rows retain their recorded expiry unless a separately defined safe migration changes them. |
| New versus historical transfer | `transfer_version=2`, `attachments-v2/<id>`; old rows remain v1 | Old Queue envelope version 1 alone does not make an old Worker understand v2 jobs, grants or byte fields. |
| Multipart progress | `attachment_upload_sessions`, `attachment_upload_parts` | Preserve upload IDs, immutable number/size/hash/ETag manifests, lease ownership and completion phase. Do not erase state to retry a part/completion. |
| Authorization | Independent session and `attachment_access_grants` validity/generation/revocation | Expired invite is not expired retained file. Revoked pending sessions cannot admit bytes; completed-file access still checks its grant and retention. |
| Cleanup | Tombstone and cleanup attempts/deadline; multipart abort state | Keep R2 key/upload ID until delete/abort succeeds; retain minimal D1/FK audit after physical deletion. Never mark cleanup successful from a failed R2 request. |

Before applying 0012, capture the exact old/new SHAs, active 100% Worker version, all migrations/hashes, live D1 UUID, bindings/secret-name set, custom domain, cron, Queue/DLQ backlog and D1 OPEN receipts separately, active upload/ambiguous work, and a fresh Time Travel bookmark. Validate the migration against both a clean local database and preserved synthetic legacy rows, including foreign keys and values within the old CHECK. Apply only the reviewed forward migration to the independently verified existing Staging D1.

The prior Worker may ignore new SQL columns yet still mishandle v2 sizes, grant access, pending multipart recovery or cleanup. Do not call rollback fully compatible based only on an additive SQL diff. The preferred recovery after v2 work begins is a reviewed forward fix. A Worker-only rollback requires exact compatibility fixtures for the durable v2 states and backlog it will encounter, plus a plan that prevents unrecognized work without purging it. No automatic down-migration, table rebuild, queue purge or database restore is supplied.

D1 Time Travel is the native full-D1 recovery point, including FTS state. It is not a verified restore test, and it does not rewind R2, Queue or Provider sends. A SQL export restricted to ordinary tables is supplementary and its table coverage, encryption and integrity must be recorded; it is not a full atomic backup. Current D1 export documentation excludes databases containing virtual tables. Do not drop `knowledge_entries_fts` to bypass that limit. Export content can contain customer data, ciphertext and capability hashes: use an encrypted access-controlled destination and never print it in logs/review prompts. [Official Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations).

A database restore can remove v2 grants/session receipts while post-bookmark objects and externally delivered links still exist, or make a previous `SENT`/`AMBIGUOUS` operation appear unsent. It is a separate destructive decision with delivery isolation and forward reconciliation, never the automatic rollback for this Staging deployment. Preserve the existing original target evidence and accepted duplicate-risk boundaries.

The v2 protocol separates network chunks from R2 multipart parts: requests carry at most 8 MiB, logical R2 parts adapt up to 5 GiB, and only R2’s physical 5 TiB / 10,000-part boundary limits the declared file size. Files above 64 MiB are verified through successive 16 MiB R2 range reads; SHA-256 and content-parser checkpoints persist in D1, so verification can resume after process loss. No whole-file buffer or single multi-terabyte verification invocation is required. Real local workerd evidence includes 32 MiB transport and an 80 MiB verification/restart case; it does not validate the entire provider capacity or replace cloud/browser acceptance. [R2 multipart limits](https://developers.cloudflare.com/r2/objects/upload-objects/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## 3. Required Evidence Before Any Change

Collect and protect the following before proposing a migration, code rollback or restore:

- Environment/account name and exact resource identifiers.
- Current deployed Worker version/SHA and intended target SHA.
- Repository migration file hashes and the exact candidate/applied inventory; `0001`–`0012` is the current candidate set, while older phase sections retain their original `0001`–`0005` scope.
- D1 information, migration status and Time Travel information/bookmark where available.
- Queue names, consumer configuration, backlog/retry state and incident window.
- R2 bucket identities and attachment lifecycle configuration.
- Runtime-config generation/history summary without exposing secret values.
- Counts and bounded identities for active event receipts, `SENDING`, `AMBIGUOUS`, retryable outbound/AI work, OPEN DLQ and reliability audit.
- Provider-visible operations that may have occurred after a proposed restore point.
- Approval owner, action scope, expected effect, stop condition and rollback/forward-recovery choice.

Do not store raw customer messages, attachment bytes, bearer tokens, webhook payloads, private URLs, authorization headers, decrypted runtime secrets or full provider bodies in the change ticket.

## 4. Verified Diagnostic Commands

The following command shapes exist in Wrangler `4.131.1`. They were verified through local help only; no remote command was executed by Phase 4B-5. Before running a Cloudflare command, replace every `REPLACE_WITH_...` value, then independently confirm the Cloudflare account, environment, resource identity and command impact.

Read-only repository checks:

```bash
git status --short
git rev-parse HEAD
git log --oneline --decorate -10
find migrations -maxdepth 1 -type f -print
```

Read-only Cloudflare checks, after independently confirming profile/environment/resource identity:

```bash
# Bash/Zsh: replace every value before execution.
D1_DATABASE_NAME="REPLACE_WITH_ACTUAL_D1_DATABASE_NAME"
TIME_TRAVEL_TIMESTAMP="REPLACE_WITH_RFC3339_TIMESTAMP"
MAIN_QUEUE_NAME="REPLACE_WITH_ACTUAL_MAIN_QUEUE_NAME"
DLQ_NAME="REPLACE_WITH_ACTUAL_DLQ_NAME"
ATTACHMENTS_BUCKET_NAME="REPLACE_WITH_ACTUAL_ATTACHMENTS_BUCKET_NAME"
DLQ_QUARANTINE_BUCKET_NAME="REPLACE_WITH_ACTUAL_DLQ_QUARANTINE_BUCKET_NAME"

if [[ "$D1_DATABASE_NAME" == REPLACE_WITH_* ||
      "$TIME_TRAVEL_TIMESTAMP" == REPLACE_WITH_* ||
      "$MAIN_QUEUE_NAME" == REPLACE_WITH_* ||
      "$DLQ_NAME" == REPLACE_WITH_* ||
      "$ATTACHMENTS_BUCKET_NAME" == REPLACE_WITH_* ||
      "$DLQ_QUARANTINE_BUCKET_NAME" == REPLACE_WITH_* ]]; then
  printf '%s\n' 'Replace every REPLACE_WITH_ value after confirming account, environment, resource identity and impact.'
else
  npx wrangler d1 info "$D1_DATABASE_NAME" --json
  npx wrangler d1 migrations list "$D1_DATABASE_NAME" --remote
  npx wrangler d1 time-travel info "$D1_DATABASE_NAME" --timestamp "$TIME_TRAVEL_TIMESTAMP" --json
  npx wrangler queues info "$MAIN_QUEUE_NAME"
  npx wrangler queues info "$DLQ_NAME"
  npx wrangler r2 bucket info "$ATTACHMENTS_BUCKET_NAME" --json
  npx wrangler r2 bucket info "$DLQ_QUARANTINE_BUCKET_NAME" --json
  npx wrangler r2 bucket lifecycle list "$ATTACHMENTS_BUCKET_NAME"
fi
```

The repository's `wrangler.toml` uses `database_id = "local-dev-only"`. Do not edit it during an incident to target a remote database. Use a separately reviewed environment/configuration.

Sensitive backup capability, not a default diagnostic:

`wrangler d1 export` accepts a remote D1 database name, `--remote` and a required `--output` path. It is intentionally not shown as a copyable command here. Although it does not modify remote D1, it writes sensitive canonical data locally. A backup procedure must separately authorize the export, use an encrypted access-controlled destination and a concrete reviewed path, record retention and audit requirements, and prohibit upload to a PR, chat or ordinary incident ticket.

No destructive command is provided here. D1 Time Travel restore, Queue pause/resume/purge, migration apply against remote D1, deployment and R2 mutation require a separate reviewed runbook/action authorization.

## 5. Compatibility Rules

### Schema versus code

- Forward migrations must be applied only with the exact reviewed runtime that expects them.
- A migration being additive does not prove an older runtime is safe. New statuses, identity evidence and Admin behavior can be semantically incompatible even when SQL still parses.
- `0005` deliberately retains legacy AI `FAILED` for rolling compatibility. This narrow contract does not authorize rollback to any arbitrary pre-`0005` or pre-Phase-4B runtime.
- Code rollback after a forward migration is **NOT VALIDATED** until the exact target SHA passes migration/schema/state fixtures and staging rollback tests.
- Never down-migrate by dropping columns/tables or rebuilding D1 manually during an incident.

### Queue versus runtime

- Queue envelopes use version `1`, but version equality alone does not prove semantic compatibility.
- Backlog can contain events created by a newer runtime/configuration generation.
- Telegram events are scoped by Support Bot profile version. New runtime drops stale-generation events and retries future-generation events; an older rollback target may not preserve this contract.
- AI, attachment and reliability rows may contain states unknown to an older runtime.
- Never purge Queue messages to make a rollback appear successful. Preserve and classify them.

### D1 versus R2/provider state

- D1 Time Travel affects D1 only. It does not undo provider messages, restore/delete R2 objects or rewind Queue state.
- Current v2 cleanup deletes R2 before setting a retained D1 tombstone; failed R2 deletion leaves retry metadata intact. Historical implementations used different ordering. A restore can still reintroduce an accessible-looking D1 row whose object no longer exists.
- A restore can rewind `SENT`, `AMBIGUOUS`, child links, audit or Admin receipts while provider side effects remain real.
- DLQ quarantine may contain terminal evidence not present at the restored D1 point. It must not be imported or replayed.

## 6. Scenario: Migration Fails Before Runtime Activation

**Detect**

- Migration command fails, integrity/foreign-key checks fail, or expected schema is absent before the new runtime is activated.

**Preconditions**

- Prove whether any migration statement committed and whether the new runtime received traffic.
- Preserve exact migration output and D1/Time Travel information.

**Allowed Actions**

- Keep the prior reviewed runtime active if it is still compatible with the observed schema.
- Stop rollout and investigate in an isolated copy/staging database.
- Prefer a reviewed forward repair when safety can be proven.

**Forbidden Actions**

- Do not rerun blindly, hand-edit schema, delete migration records or deploy new code to conceal a failed migration.

**Stop Conditions**

- Partial schema state, unknown commit boundary, new runtime traffic, or unproven prior-runtime compatibility.

**Evidence to Preserve**

- D1 identity, exact migration set/SHA, command output, timestamps, schema/integrity results and deployment state.

**Recovery / Escalation**

- Automatic migration rollback is **NOT IMPLEMENTED**.
- Any Time Travel restore or forward-repair migration **REQUIRES SEPARATE AUTHORIZATION**.

**Verification of Recovery**

- Exact target runtime and schema pass clean migration, integrity, typecheck/lint/tests and isolated runtime acceptance before traffic proceeds.

## 7. Scenario: Runtime Failure After Forward Migration

**Detect**

- New runtime fails after migration `0001`-`0005` is already durable.

**Preconditions**

- Determine new states written since activation, Queue backlog generations and provider-visible operations.
- Compare the exact rollback SHA's schema/status/event compatibility.

**Allowed Actions**

- Stop rollout expansion and preserve evidence.
- Use staging/copy tests to prove whether the prior runtime can read every current status and envelope without mutating incorrectly.
- Prefer a reviewed forward fix when rollback semantics are uncertain.

**Forbidden Actions**

- Do not assume Git rollback reverses D1, R2, Queue or provider effects.
- Do not reset AI/outbound attempts or rewrite unknown states to values understood by older code.

**Stop Conditions**

- Rollback target predates a durable state it cannot interpret, target evidence rules, Support Bot generation fencing, or DLQ semantics.

**Evidence to Preserve**

- Old/new SHA, activation window, rows/status counts, Queue state, runtime config generations, outbound/audit/provider evidence.

**Recovery / Escalation**

- Arbitrary code rollback is **OPERATOR STOP** until exact compatibility is demonstrated and authorized.
- A forward fix requires normal review and deployment authorization.

**Verification of Recovery**

- No duplicate provider side effects, no state downgrade, normal Queue convergence, intact audit and successful acceptance at the exact deployed SHA.

## 8. Scenario: D1 Point-in-Time Restore Consideration

**Detect**

- Confirmed D1 corruption or destructive mutation cannot be safely repaired forward.

**Preconditions**

- Establish an exact restore point and list every Queue/R2/provider effect after it.
- Obtain D1 Time Travel information and confirm platform retention/availability for the specific environment.
- Plan delivery isolation without purging messages.

**Allowed Actions**

- Build a reviewed restore plan and rehearse it in an isolated environment/copy.
- Use read-only Time Travel info and protected backups for analysis.

**Forbidden Actions**

- Do not run Time Travel restore directly from this document.
- Do not restore while Queue/provider work continues, or assume D1 restore rolls back R2/provider effects.
- Do not delete post-restore conflicting evidence.

**Stop Conditions**

- Restore point is uncertain; post-point sends cannot be enumerated; Queue cannot be safely isolated; R2/provider reconciliation is incomplete; required owners are absent.

**Evidence to Preserve**

- Time Travel bookmark/timestamp, D1 identity, affected tables/rows, post-point operation/audit/provider references, Queue and R2 inventories.

**Recovery / Escalation**

- D1 restore is **NOT IMPLEMENTED BY CZ2128 / REQUIRES SEPARATE AUTHORIZATION**.
- The plan must define forward reconciliation for post-point `SENT`/`AMBIGUOUS`, attachments, runtime config and Admin receipts before execution.

**Verification of Recovery**

- Schema/integrity valid; no delivered side effect becomes resendable; R2 references are classified; Queue resumes without duplicate visible effects; audit records the recovery externally and, where supported, canonically.

## 9. Scenario: D1/R2 Divergence

**Detect**

- D1 attachment row references a missing object, an R2 object has no expected D1 row, or quarantine evidence has no D1 receipt.

**Preconditions**

- Identify bucket/prefix and D1 identity without reading private object bodies.
- Determine whether divergence is expected cleanup ordering, failed storage, restore aftermath or unknown mutation.

**Allowed Actions**

- Preserve metadata and classify each side independently.
- Let attachment cleanup retain D1 metadata when R2 deletion fails.
- Treat quarantine-only records as terminal evidence requiring manual escalation.

**Forbidden Actions**

- Do not fabricate D1 rows from R2, delete unmatched evidence, expose object bodies, extend expiry or resend attachment/provider operations.

**Stop Conditions**

- Identity conflict, private bytes required to decide, active delivery, or provider effect cannot be determined.

**Evidence to Preserve**

- D1 ID/status/expiry/storage key, R2 key/metadata/time, operation/audit/provider reference and incident timeline.

**Recovery / Escalation**

- Generic D1/R2 reconciliation is **NOT IMPLEMENTED**.
- Missing attachment bytes or quarantine import is **OPERATOR STOP** and requires separate design/authorization.

**Verification of Recovery**

- Every retained D1 row and R2 object has a documented disposition; no evidence is silently deleted and no duplicate provider action occurs.

## 10. Scenario: Runtime Configuration Rollback

**Detect**

- A validated runtime override causes a service/configuration failure and a known prior history entry or env fallback is desired.

**Preconditions**

- Use the authenticated private Admin Bot and inspect current version/history.
- Confirm the key is `GENERIC`, expected version is current, and target value belongs to the same key.
- For secret history, current master key must decrypt the stored value.

**Allowed Actions**

- Generic restore-to-env removes the override and appends a new `RESTORE_ENV` history version.
- Generic rollback writes the selected history value as a new monotonic `ROLLBACK` version.
- High-impact generic keys require the existing confirmation session.

**Forbidden Actions**

- Do not reveal history secrets, edit history, decrease versions or use generic rollback for `TELEGRAM_SUPPORT_PROFILE` or `BOT_GROUP_ID`.
- Do not assume changing Chatwoot API settings reconfigures webhooks or signing secrets.

**Stop Conditions**

- Version conflict, invalid/decryption-failed value, dedicated key, unknown environment fallback or provider target identity consequences are not understood.

**Evidence to Preserve**

- Key name, old/new version, action, Admin update/audit identity and validation result. Never preserve plaintext secret values.

**Recovery / Escalation**

- Support Bot rotation and group migration use dedicated confirmed workflows and require separate operational authorization.
- A generic rollback cannot reverse provider-side setup performed by a dedicated workflow.

**Verification of Recovery**

- Next request/event resolves one coherent expected snapshot, provider validation succeeds where applicable, history remains append-only and no target-evidence rule is bypassed.

## 11. Scenario: Queue Backlog Across Runtime Change

**Detect**

- Queue contains messages created before/after a runtime or Support Bot profile change.

**Preconditions**

- Record Queue names, runtime SHA transition, envelope version, Support Bot generation and affected event types.

**Allowed Actions**

- Let the reviewed runtime enforce stable event IDs, event receipts, profile-generation checks and outbound operation IDs.
- Prove compatibility in staging before rollback/resume decisions.

**Forbidden Actions**

- Do not purge, rewrite, bulk replay or manually re-enqueue the backlog.
- Do not assume envelope `version=1` alone makes old/new runtime semantics compatible.

**Stop Conditions**

- Future-generation events reach older code, unknown status/schema is present, or provider-visible identity rules differ between versions.

**Evidence to Preserve**

- Queue/runtime transition times, bounded event IDs/types, profile versions, event receipt/outbound state and retry/DLQ results.

**Recovery / Escalation**

- Queue delivery pause/resume **REQUIRES SEPARATE AUTHORIZATION** and a defined recovery window.
- Queue purge remains **OPERATOR STOP**.

**Verification of Recovery**

- Stale generation drops safely, future generation retries only under the reviewed runtime, duplicates converge canonically and no visible parent operation is repeated.

## 12. Backup and Recovery Evidence Template

```text
Environment:
Cloudflare account/profile identifier (non-secret):
Incident/change ID:
UTC start/end:
Current deployed SHA:
Target SHA:
Migration files/hashes:
D1 database identity and info capture:
D1 migration status:
Time Travel info/bookmark (if authorized):
Protected export location and retention (if authorized):
Main Queue/DLQ information:
R2 bucket/lifecycle information:
Runtime configuration versions (no secret values):
Active/ambiguous/retryable state counts:
Post-restore-point provider-visible operations:
Expected action and blast radius:
Stop conditions:
Approvers:
Verification evidence:
Unverified gaps:
```

## 13. Required Manual Decision Boundaries

The following are never implied by this runbook:

- Approval to run remote migrations, restore D1 or import an export.
- Approval to pause/resume/purge Queue delivery.
- Approval to delete or rewrite D1/R2 evidence.
- Approval to deploy or roll back Worker code.
- Approval to perform provider-visible reconciliation, Manual Retry or AI redrive.
- Proof that production recovery works.

All remain **REQUIRES SEPARATE AUTHORIZATION** until Phase 4C provides environment-specific evidence and Primary approves the action.
