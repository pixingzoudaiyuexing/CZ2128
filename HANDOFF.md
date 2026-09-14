# CZ2128 - Phase 3.5 Runtime Control Plane Handoff

## 状态
- **Current Branch**: `codex/phase3.5-runtime-control-plane`
- **Phase 1 Merge Commit / Main Base**: `61f9ad26bd2e06d0c91389434af17bdc85936e43`
- **Phase 2 Previous Head**: `46ff0001f9df319f32145f6429d5de6c2465bb1b`
- **PR #1**: merged
- **PR #2**: merged; Phase 2 complete and frozen
- **PR #3**: merged; Phase 3 complete and frozen
- **PR #4**: Phase 3.5 implementation in review; do not merge before Primary approval
- **Phase 4**: not started
- **Final HEAD / CI**: 以 Phase 3 Merge & Main Freeze Return 和远端 `main` 为准，不在本文件保存自指 SHA。

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
- OpenAI-compatible errors are persisted and logged only as bounded categories; raw provider bodies, exception text and API keys are not recorded.
- Phase 4 reconciliation is not part of this branch.

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
- Cloudflare R2 account enablement and all Phase 3/3.5 real staging validation remain outstanding.
