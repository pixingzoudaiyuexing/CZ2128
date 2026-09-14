# CZ2128 - Phase 4B-2C-2 Implemented / In Review

## 状态
- **Current Branch**: `codex/phase4b2c2-manual-retry-domain-resolution`
- **Phase 1 Merge Commit / Main Base**: `61f9ad26bd2e06d0c91389434af17bdc85936e43`
- **Phase 2 Previous Head**: `46ff0001f9df319f32145f6429d5de6c2465bb1b`
- **PR #1**: merged
- **PR #2**: merged; Phase 2 complete and frozen
- **PR #3**: merged; Phase 3 complete and frozen
- **PR #4**: merged; Phase 3.5 complete and frozen
- **Phase 4A**: reliability architecture complete and frozen
- **Phase 4B-1**: canonical error taxonomy and retry contracts complete
- **Phase 4B-2A**: reliability persistence foundation complete
- **Phase 4B-2A**: COMPLETE
- **Phase 4B-2B**: COMPLETE / FROZEN / MERGED
- **Phase 4B-2C-1**: COMPLETE / FROZEN / MERGED
- **Phase 4B-2C-2**: IMPLEMENTED / IN REVIEW
- **Phase 4B-2C-3**: NOT STARTED
- **Phase 4B-3**: NOT STARTED
- **Final HEAD / CI**: 以 Phase 3.5 Merge & Main Freeze Return 和远端 `main` 为准，不在本文件保存自指 SHA。

## Phase 1 Reliability Baseline
- Provider ingress is authenticated before normalization into a version 1 typed Queue envelope.
- `event_receipts` uses `lease_until` and `claim_token` ownership fencing.
- `outbound_operations` uses deterministic identity, CAS, bounded attempts and `AMBIGUOUS` no-blind-resend semantics.
- Visible provider actions classify transport exceptions, HTTP 408 and HTTP 5xx as `AMBIGUOUS`; HTTP 429 is retryable.
- Conversation/topic mapping and `OPEN/CLOSED` lifecycle state are protected by D1 uniqueness and CAS.

## Phase 2 Scope
- Optional OpenAI-compatible provider.
- `ENABLED`, `PAUSED_OPERATOR` and `PAUSED_MANUAL` human handoff modes.
- Generation lease plus persistent `ai_handoff_epoch` cancellation boundary.
- Durable `ai_runs` keyed by stable customer trigger.
- Bounded, deterministic recent D1 context.
- Customer messages map to `user`, AI answers to `assistant`, and human operator replies to labeled `system` context so operator text is never represented as an AI answer.
- Telegram `/ai_on` and `/ai_off` controls through outbound operations.
- AI delivery to Chatwoot followed by an optional Telegram mirror.

## Known Reliability Boundary
- Third-party staging and real D1/Queue concurrency remain required before production acceptance.
- `AMBIGUOUS` visible delivery outcomes require Phase 4 reconciliation or manual inspection and are never blindly resent.
- Phase 4B-2C-1 now supplies internal reconciliation services, immutable outbound subject/target evidence and audited manual mark-delivered/cancel persistence. Historical `AMBIGUOUS` rows are not rewritten to `SENT`.
- Chatwoot reconciliation can confirm only an exact unique `source_id=cz2128:<operation_id>` after a bounded read-only `after`-cursor scan proves provider history exhaustion. It starts at `after=0`, advances with the largest returned valid message ID, and reads at most five pages of up to 100 messages. A full fifth page, invalid/non-advancing cursor, zero match, duplicate match, lookup failure or any Telegram operation remains ambiguous and never becomes an automatic resend opportunity.
- Chatwoot target evidence fingerprints the canonical full API base, including its base pathname, while keeping the raw URL absent. Message, attachment, candidate-validation and reconciliation requests share one URL builder. Reconciliation derives the current runtime identity internally and cannot be bypassed with caller-supplied old evidence.
- Existing attempted rows without target evidence are not backfilled from current runtime configuration. Only provably pre-request rows (`attempt_count=0`, `request_started_at IS NULL`, safely unsent status) may receive CAS backfill.
- OpenAI-compatible errors are persisted and logged only as bounded categories; raw provider bodies, exception text and API keys are not recorded.
- The AI durable retry state machine remains outside this branch.
- Phase 4B-2C-2 now supplies internal manual retry child execution for `MESSAGE`, `ATTACHMENT` and Telegram conversation lifecycle operations. One parent has one deterministic direct child; the parent remains `AMBIGUOUS` and records `MANUAL_RETRY_CREATED`.
- Child creation, parent transition and the sanitized creation audit use one D1 batch. Duplicate callers locate the same child, while the existing outbound lease prevents two visible provider effects.
- Payload reconstruction is durable-state-only. Message text comes from `messages`; attachment bytes must be unexpired and retrievable from private R2 before the decision is consumed; topic creation uses the durable canonical fallback title.
- A dedicated domain-resolution service repairs attachment delivery and Telegram topic mapping/status after effective delivery. It is idempotent, CAS-safe and never invokes a provider action.
- `AI_RUN` and `CONTROL_ACK` manual retry remain rejected. Phase 4B-2C-3, Admin reliability exposure, DLQ consumption and `CONFIRMED_NOT_SENT` activation remain not started.

## Phase 3 Attachment Contract
- Private R2 binding: `ATTACHMENTS_BUCKET` / bucket `cz2128-attachments`.
- 20 MiB per attachment, ten attachments per provider message, 24-hour business TTL.
- Source-to-R2 uses bounded multipart chunks; provider delivery uses one bounded single-file buffer at a time.
- Chatwoot downloads use exact HTTPS allowlists, manual redirects and cross-origin credential stripping.
- Secure proxy supports GET, HEAD and single byte ranges with uniform 404 access failures.
- Hourly cleanup removes at most 100 expired rows after R2 deletion succeeds.
- Real R2, Chatwoot and Telegram staging validation remains required.

## Pre-Production Requirements
- Real Cloudflare R2: write, multipart, read, Range and delete.
- Real Telegram: `getFile` plus multipart `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio` and `sendVoice`.
- Real Chatwoot: attachment `data_url` download/redirect behavior and multipart `attachments[]`.
- Secure proxy: GET, HEAD, Range and response headers in staging.
- Cleanup: hourly scheduled trigger and R2-before-D1 deletion behavior.
- Real Queue/D1 concurrency and 20 MiB `ArrayBuffer` -> `Blob` -> `FormData` memory/load behavior.
- Apply and verify the seven-day R2 object/aborted-multipart lifecycle.
- Residual risks include DNS rebinding through an explicitly trusted allowlisted DNS hostname and an extreme R2 I/O stall outliving the attachment event receipt lease.

## Phase 3.5 Runtime Control Plane
- `runtime_config` stores plain overrides or AES-256-GCM encrypted secrets with optimistic versions.
- `runtime_config_history` is append-only; rollback creates a new version and never reveals secret values.
- Missing overrides use env fallback; present but invalid encrypted overrides fail closed.
- One coherent snapshot is resolved per support HTTP request, Admin request or Queue event.
- Admin ingress requires its bootstrap path, webhook secret, private chat and exact positive Telegram user-ID allowlist.
- Admin sessions expire after ten minutes and `admin_update_receipts` makes mutations idempotent by `update_id`.
- Support Bot rotation creates a new token/path/secret profile and group migration clears old topic mappings atomically.
- The Support profile version scopes Queue/event/message/outbound identity and `(profile version, update_id)` ordering; old-generation Queue events cannot perform side effects.
- Runtime-config store read failure fails closed for runtime-controlled providers; env fallback requires a successful D1 read proving absence.
- Support Bot rotation requests `drop_pending_updates=true` when setting the candidate webhook.
- The Cloudflare R2 account is enabled, but real R2 staging remains incomplete and bucket/lifecycle validation is pending.
- Real Admin Bot, Support Bot rotation, Telegram group migration, Telegram provider, Chatwoot and Queue/D1 concurrency validation remain NOT TESTED.
- Phase 4B-2C-2 does not add `0006`, Admin reliability UI/commands, a DLQ consumer, AI durable retry state activation or legacy AI `FAILED` retirement.
