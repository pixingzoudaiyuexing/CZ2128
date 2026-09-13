# CZ2128 - Phase 2 Handoff

## 状态
- **Current Branch**: `gemini/phase2-ai-handoff`
- **Phase 1 Merge Commit / Main Base**: `61f9ad26bd2e06d0c91389434af17bdc85936e43`
- **Phase 2 Previous Head**: `46ff0001f9df319f32145f6429d5de6c2465bb1b`
- **PR #1**: merged
- **PR #2**: open; Phase 2 independent audit in progress
- **Final HEAD / CI**: 以独立审计 Return Package 和 PR #2 当前远端 HEAD 为准，不在本文件保存自指 SHA。

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
- Phase 3 attachments/R2 are not part of this branch.
