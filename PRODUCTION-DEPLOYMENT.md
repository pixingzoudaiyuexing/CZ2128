# CZ2128 v1.0.0 Production Deployment Contract

Status: **V1 RELEASE + GITHUB OPERATIONS AUTOMATION IN DEVELOPMENT / PRODUCTION DATA RESOURCES PROVISIONED / WORKER NOT DEPLOYED / PROVIDER TRAFFIC NOT CUT OVER**

Release target: **CZ2128 v1.0.0**

Owner authorization: the Owner has accepted the recorded Phase 4C residual risks and authorized the first Production release. Existing blocked, deferred, time-bound and human-acceptance gaps remain historical truth; this document does not relabel them as PASS.

## 1. Release Source and Behavior Boundary

Read-only baseline at release preparation:

- Git main/origin main: `a48a7c5eaeabe3d3d06216aa725e80f4d7ab34ea`.
- Package version: `1.0.0`.
- Main CI #274 / run `36313194153`: success at the exact baseline SHA.
- Current main contains Phase 1-6 V1 runtime, D-035 guarded single-Telegram-Bot rotation, D-036 human learning and `0010_human_learning.sql`.
- The release-preparation commit may add deployment/configuration validation and documentation without changing `src/` runtime behavior. The final reviewed release-prep SHA must be recorded before any Production mutation.

The Production executable must come from the exact reviewed final main after release-prep CI/review. A later evidence-only documentation commit, if any, is not automatically the release tag target.

## 2. Cloudflare Account and Resource Inventory

Verified read-only account fingerprint:

- Account ID: `def8e92deb7522f7d038c9741fa3cdef`.
- Account type reported by Wrangler: `standard`.
- Existing CZ2128 resources are staging-only; the unsuffixed Production candidate identities below were absent during the read-only inventory.

Frozen Production identities:

| Resource | Production identity | Release-prep inventory |
| --- | --- | --- |
| Worker | `cz2128` | absent |
| D1 | `cz2128-db` | absent |
| Main Queue | `cz2128-queue` | absent |
| DLQ | `cz2128-dlq` | absent |
| Attachment R2 | `cz2128-attachments` | absent |
| DLQ quarantine R2 | `cz2128-dlq-quarantine` | absent |

No same-name resource may be adopted later without re-running provenance/emptiness checks. If any identity unexpectedly appears before creation, stop with `AMBIGUOUS_EXISTING_PRODUCTION_RESOURCE`; do not empty, overwrite or reuse it.

Staging resources named `cz2128-4c-staging-*` and legacy `cz2128-staging-*` are outside the Production mutation boundary.

## 3. Reviewed Production Configuration

Committed template:

- `wrangler.production.template.jsonc`

Generated local file:

- `wrangler.production.jsonc`
- ignored by Git;
- created only after the real Production D1 UUID is independently recorded;
- the D1 placeholder is the only template field replaced to generate the local deployment file.

The production validator must prove:

- Worker `cz2128`;
- D1 `cz2128-db` and exact independently supplied UUID;
- main Queue `cz2128-queue` -> DLQ `cz2128-dlq`;
- private R2 bindings `cz2128-attachments` and `cz2128-dlq-quarantine`;
- hourly cron `0 * * * *`;
- compatibility `2024-03-20` + `nodejs_compat`;
- Workers.dev enabled, preview URLs disabled and no unreviewed custom routes;
- no staging or local-development resource reference;
- no plaintext credential-like config key;
- `AI_TEST_SCOPE_ENABLED=false` and empty production AI test allowlist;
- `NOTION_LEARNING_ENABLED=true`;
- Learning Candidates Data Source UUID `91108397-2842-48ce-ac6d-68df8bd80399`;
- Knowledge Sources Data Source UUID `8ff03b80-6d0f-4c31-b0bc-1c13ab8fa300`.

The Owner-provided Notion targets were expressed as `collection://<uuid>`; the runtime configuration stores the UUID portion because the Notion adapter sends it as a Data Source ID.

## 3A. GitHub One-Click Operations

Committed manual workflows:

- `.github/workflows/deploy-production.yml` — first installation only.
- `.github/workflows/update-production.yml` — later release-tag updates.
- `.github/workflows/rollback-production.yml` — Worker-only rollback.

All three use the GitHub `production` Environment and an owner gate. They have no push, pull-request, schedule or release-event trigger. The optional `CZ2128_DEPLOY_ACTOR` variable can name the only authorized actor; otherwise the repository owner is required.

The Production Environment holds Cloudflare credentials and all Worker secret values. The committed Wrangler template contains only secret **names** through `secrets.required`; missing required secrets fail before Worker upload/deploy. Secret values are written only to an ephemeral runner file with restrictive permissions and are never committed or printed.

First deployment uses `wrangler deploy`, because Cloudflare does not permit `wrangler versions upload` as the first Worker upload. Later updates decouple upload and promotion with `wrangler versions upload` followed by `wrangler versions deploy`.

The Update workflow:

1. requires a Git tag whose `vX.Y.Z` value matches `package.json`;
2. requires that tag commit to be reachable from `origin/main`;
3. verifies the existing Worker/D1/Queue/R2 identities;
4. records the current 100% Worker version and a D1 Time Travel recovery point;
5. compares remote `d1_migrations` with the release and rejects pending destructive schema SQL such as table/column drop or rename;
6. applies only accepted forward migrations;
7. uploads the new Worker Version with the release tag and refreshed GitHub-managed secrets;
8. promotes it to 100%;
9. verifies the active version changed;
10. automatically rolls the Worker back to the previously active version if cutover verification fails.

The one-click migration rule is deliberately **expand-only**. A release requiring destructive/contracting schema change is not eligible for the generic Update button and must use a separately reviewed expand/migrate/contract release sequence.

The Rollback workflow:

- can target only a Worker Version that previously served as a single 100% deployment;
- defaults to the prior 100% deployment when no target is supplied;
- requires explicit rollback confirmation;
- immediately restores that Worker Version;
- never down-migrates D1 and never deletes/recreates D1, R2 or Queues.

Cloudflare Worker versions include code/config/bindings, while storage state is outside Worker version history. This is why the update migration guard and no-down-migration rollback rule are mandatory.

## 4. Production Resource Creation

Only after release-prep exact-head CI and agy Gate 1 PASS:

1. re-confirm the Cloudflare account fingerprint and absence of all six unsuffixed identities;
2. create D1 `cz2128-db`;
3. create DLQ `cz2128-dlq`;
4. create main Queue `cz2128-queue` with the reviewed Worker config supplying producer/consumer topology at deployment;
5. create private R2 `cz2128-attachments`;
6. apply attachment lifecycle: `attachments/` expires after seven days and incomplete multipart uploads abort after seven days;
7. create private R2 `cz2128-dlq-quarantine` with no attachment-expiry rule;
8. do not create KV, Durable Objects, additional databases/queues/buckets or additional providers.

If any create operation requires a new paid plan or a clearly new recurring commitment, stop for Owner cost approval before accepting the upgrade.

## 5. D1 Migration Contract

A newly created Production D1 must be proven empty before migration.

Before migration record:

- exact D1 UUID and creation timestamp;
- `wrangler d1 info` metadata;
- D1 Time Travel/recovery metadata available for the new database;
- empty business-table state.

Apply repository migrations forward only:

`0001_initial_schema.sql`
through
`0010_human_learning.sql`.

After migration require:

- all `0001`-`0010` applied;
- no pending migration;
- foreign-key/integrity checks;
- expected core reliability, runtime-config, knowledge/FTS and human-learning schema objects;
- no unexpected business data.

Do not down-migrate. A migration failure stops Worker/provider rollout and follows `MIGRATION-RECOVERY.md`.

## 6. Production Secrets and Settings

Never record secret values in Git, chat, agy evidence or release logs.

Required Production-owned secret/settings classes for the enabled V1 runtime:

**Unified Telegram**
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_SECRET_PATH`
- `BOT_GROUP_ID`
- `ADMIN_TELEGRAM_USER_IDS`

A separate legacy Admin Bot credential is not required for normal Production operation. If kept later for break-glass compatibility, it must remain offline and must not leave a second active CZ2128 webhook.

**Runtime/upload**
- `RUNTIME_CONFIG_MASTER_KEY`
- `UPLOAD_CAPABILITY_SECRET`

**Crisp**
- `CRISP_WEBHOOK_SECRET`
- `CRISP_API_IDENTIFIER`
- `CRISP_API_KEY`
- `CRISP_WEBSITE_ID`

Optional Crisp welcome/menu/identity overrides may be added only if explicitly chosen; they are not a prerequisite for the core bridge.

**AI**
- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_MODEL`
- optional reviewed `AI_SYSTEM_PROMPT`

**Phase 6 Notion**
- `NOTION_API_TOKEN`

The two Notion Data Source IDs and `NOTION_LEARNING_ENABLED=true` are reviewed non-secret vars in the Production config.

For the GitHub one-click path, Owner-owned values are configured once as GitHub `production` Environment secrets. They may alternatively be entered through Cloudflare or a trusted local terminal for a separately reviewed manual deployment. Do not paste raw credentials into chat or commit them to the repository.

## 7. Deployment and Live-Cutover Gates

Before the first live Provider cutover:

1. release-prep exact-head CI SUCCESS;
2. agy Gate 1 Production plan PASS;
3. Production resources verified;
4. D1 `0001`-`0010` applied and verified;
5. generated Production config passes `validate:production`;
6. Production secret names/settings verified without reading values;
7. exact reviewed Worker is deployed;
8. Worker deployment/bindings/cron are verified while Provider webhooks still point away from the new Worker;
9. agy Gate 2 PASS on actual identities/deployment/cutover/rollback evidence.

Only then cut over Crisp and the single unified Telegram Bot webhook. Enable Notion learning only when the token and both Data Source schemas pass health validation. AI health validation is bounded.

## 8. Minimum Production Smoke

Use only synthetic Production test data and legitimate clients; do not forge provider webhooks or write D1 directly to mimic business smoke.

Required minimum:

- Worker healthy;
- D1 `0001`-`0010`;
- exact Queue/DLQ bindings;
- both R2 buckets private and attachment lifecycle correct;
- hourly cron present;
- Telegram webhook points to Production;
- Crisp Production webhook/signing configuration correct;
- bounded AI provider health succeeds;
- Notion integration/data-source health succeeds with learning enabled;
- authorized Production Bot `/start`;
- one synthetic Crisp conversation -> Telegram Topic;
- one operator reply -> Crisp;
- one real AI on/off callback.

Production support smoke must not use real customer data.

## 9. Rollback Readiness

First-release rollback prioritizes traffic withdrawal over resource deletion.

Before cutover record the prior Provider webhook state.

- Worker: record the first Production version/deployment and any immediately previous deployable Production version if one later exists.
- Telegram: restore the prior webhook state or safely delete the new webhook if no prior Production endpoint existed.
- Crisp: restore the prior endpoint/configuration.
- D1: no down migration. Migration `0010` is additive, but executable rollback still requires compatibility evidence for the exact target Worker.
- D1/R2/Queues: never delete Production data/resources as an automatic rollback.
- On critical failure, stop new Provider traffic first, preserve durable state and investigate.

## 10. Final Release Closure

After smoke:

- observe Worker errors, Queue/DLQ state, AMBIGUOUS operations, Admin sessions, Telegram/Crisp/AI/Notion health and unexpected R2 objects;
- run agy Gate 3 Final Production Review and require `PRODUCTION RELEASE PASS`;
- update this document plus README, PROJECT, ROADMAP, PREPRODUCTION-ACCEPTANCE and HANDOFF with sanitized Production evidence while retaining all Phase 4C residual-risk truth;
- run docs candidate CI + agy review, fast-forward main and main CI;
- publish GitHub tag/Release `v1.0.0` only after all gates pass;
- bind the tag to the explicitly selected reviewed Production executable source commit rather than a later evidence-only docs commit unless the final record explicitly justifies otherwise.

Final success string is reserved for the complete work unit:

`CZ2128 V1.0.0 PRODUCTION RELEASE COMPLETE`