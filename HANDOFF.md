# CZ2128 - Phase 3 Handoff

## 状态
- **Current Branch**: `codex/phase3-attachments`
- **Phase 1 Merge Commit / Main Base**: `61f9ad26bd2e06d0c91389434af17bdc85936e43`
- **Phase 2 Previous Head**: `46ff0001f9df319f32145f6429d5de6c2465bb1b`
- **PR #1**: merged
- **PR #2**: merged; Phase 2 complete and frozen
- **Phase 3**: implementation in PR #3; do not merge before Primary review
- **Final HEAD / CI**: 以 Phase 2 Merge & Main Freeze Return 和远端 `main` 为准，不在本文件保存自指 SHA。

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
