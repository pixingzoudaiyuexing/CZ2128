# AGENTS.md

This repository uses an AI-assisted development workflow. Git is the source of truth.

## Required Reading Order

Before making implementation changes, read:

1. `PROJECT.md`
2. `ARCHITECTURE.md`
3. `DECISIONS.md`
4. `ROADMAP.md`
5. This file

If code and documentation conflict, stop and verify ground truth before changing behavior. Record the final decision in project documentation.

## Current Phase

Phases 1, 2, 3 and 3.5 are complete and merged. Phase 4A reliability architecture is frozen. Phase 4B-1 error-taxonomy and retry-contract implementation is complete; Phase 4B-2A COMPLETE; Phase 4B-2B COMPLETE / FROZEN; Phase 4B-2C-1 COMPLETE / FROZEN; Phase 4B-2C-2 COMPLETE / FROZEN; Phase 4B-2C-3 COMPLETE / FROZEN / MERGED. Phase 4B-2C overall is COMPLETE / FROZEN. Phase 4B-3 is COMPLETE / FROZEN / MERGED. Phase 4B-4A is COMPLETE / FROZEN / MERGED. Phase 4B-4B is IMPLEMENTED / IN REVIEW / NOT ACCEPTED / NOT FROZEN / NOT MERGED. Phase 4B-4 overall is IN PROGRESS. Phase 4B-5 and 4C remain NOT STARTED.

`ARCHITECTURE.md` and `DECISIONS.md` remain the approved V1 baseline. Phase 3 preserves the hardened webhook, Queue, outbound ambiguity and AI handoff contracts from Phases 1 and 2. Real provider, R2, proxy, cleanup, Queue/D1 concurrency and load validation remain pre-production requirements rather than completed production validation.

Runtime provider settings must be resolved as one D1 snapshot per HTTP request or Queue event. Bootstrap secrets, including the runtime master key and admin-bot identity, must never be writable through the admin control plane. A present but invalid encrypted override is authoritative and must not silently fall back to an older env secret.

## Architectural Boundaries

- Chatwoot is an upstream helpdesk adapter, not the core domain.
- Telegram is an operator channel adapter, not the core domain.
- AI providers are replaceable adapters.
- R2 is the first attachment-store adapter.
- D1 is the V1 canonical gateway database.
- Cloudflare Queues is part of V1 ingress/async reliability.
- KV is not required for V1 correctness.
- Durable Objects are deferred unless measured concurrency/ordering evidence proves they are needed.
- Core code must not import provider-specific concepts unnecessarily.
- Do not modify or fork Chatwoot as part of CZ2128 V1.
- Do not copy the legacy Crisp implementation wholesale.
- Do not build unused adapters or generalized framework layers for hypothetical future providers.

## Frozen V1 Concurrency / Idempotency Rules

- Cloudflare Queues is at-least-once; duplicate delivery must be assumed.
- Provider webhook/message IDs and stable internal operation IDs are primary identity; message-text hashes are not.
- Chatwoot gateway-originated messages should use a stable `source_id` marker such as `cz2128:<operation_id>` where supported.
- D1 event receipts remain authoritative inbound duplicate records.
- D1 outbound operation records remain authoritative provider side-effect records.
- Never blindly repeat a visible external side effect because a Queue message was retried.
- AI human handoff mode is separate from the transient generation lease.
- An operator pause must win even if an AI request is already in flight; stale AI output must be discarded.
- Outbound subject identity and versioned target evidence must be persisted before a provider-visible request and remain immutable for a deterministic operation ID.
- Historical `AMBIGUOUS` remains `AMBIGUOUS`; reconciliation status supplies effective delivery semantics without creating a resend path.
- Phase 4B-2C-1 may confirm Chatwoot delivery only through an exact unique `source_id`; zero or multiple bounded-search matches remain ambiguous.
- Phase 4B-2C-2 manual retry always creates or resumes one deterministic direct child; the parent remains historical `AMBIGUOUS` with `MANUAL_RETRY_CREATED`.
- Manual retry accepts duplicate risk explicitly, reconstructs payload only from durable domain state and fails closed if the provider destination changed.
- Effective delivery repairs attachment and Telegram topic domain state through idempotent D1 CAS without replaying a provider action.
- AI generation has a three-attempt durable budget. `attempt_count` advances only through an owned CAS immediately before `generateChatCompletion()`.
- New AI runtime writes use `FAILED_RETRYABLE`, `RETRY_EXHAUSTED` or `FAILED_FINAL`; legacy `FAILED` is read-compatible only and lazily normalized.
- `AI_RUN` manual retry is allowed only from a matching durable `SUCCESS` response and never regenerates AI; `CONTROL_ACK` is not manually retried.
- Effective Chatwoot delivery of an `AI_RUN` repairs one durable AI message idempotently; Telegram mirror delivery alone does not create another context message.

## Telegram Topic Rule

V1 uses:

```text
1 Chatwoot conversation = 1 Telegram forum topic
```

- Resolve -> close topic.
- Reopen -> reopen topic.
- Do not switch to one-customer-one-topic without an explicit architecture decision.

## Legacy Reference

Reference repository:

`pixingzoudaiyuexing/Crisp-Telegram-Bot`

It may be inspected for proven behavior, especially Telegram topic mapping, AI handoff semantics, auto-resume logic, notification policy, and learning event concepts.

Do not inherit the following without explicit review:

- Crisp-specific APIs/domain models
- KV as primary state
- content-hash-only echo detection
- monolithic single-file Worker architecture
- syntax-check-only test strategy
- EasyImages as a required dependency

## Implementation Rules

- Use TypeScript.
- Keep modules small and dependency direction clear.
- Provider adapters depend on core contracts; core must not depend on provider implementations.
- Keep HTTP ingress thin: verify, validate, normalize, enqueue, acknowledge.
- All incoming webhooks require authentication/verification before processing.
- Chatwoot verification uses the raw request body, signature and timestamp/replay window.
- Telegram verification uses the secret-token header plus the configured group/chat constraints.
- Every externally delivered event must be idempotent.
- Retries must not normally create duplicate customer-visible messages.
- Model ambiguous third-party delivery outcomes honestly; do not claim exactly-once guarantees the provider cannot support.
- Do not place file bodies in Queue messages.
- R2 objects are private by default.
- Secrets belong in Cloudflare secrets/environment bindings, never committed files.
- Logs must redact secrets, sensitive URL/query values and authorization/webhook-secret headers.
- Human support must keep working if AI is disabled or unavailable.
- Do not expose raw upstream error bodies to customers.

## Testing Rules

A task is not complete because code compiles.

For changed behavior:

- Add/update automated tests.
- Run typecheck/lint/tests as applicable.
- Validate migrations against a clean local/test database.
- For webhook/state changes, include duplicate-delivery tests.
- For Queue retry changes, prove stable operation/event identity and no ordinary duplicate visible message.
- For AI generation changes, test operator-interrupt and rapid-message races.
- For attachment changes, test expiration, unauthorized access, size limits and missing R2 objects.

## Phase 1 Scope Guard

Phase 1 is the human bridge foundation. It includes:

- Worker/TypeScript foundation
- D1 migrations/repositories
- Chatwoot webhook/API adapter
- Telegram webhook/API adapter
- Queues ingress/consumer
- conversation/topic mapping and lifecycle
- bidirectional human text sync
- event/message idempotency
- outbound operation ledger
- structured logging
- critical automated tests

Phase 1 does **not** require:

- AI implementation
- RAG/knowledge base
- learning workflow
- analytics UI
- attachment implementation beyond interfaces needed to avoid architectural dead ends
- Durable Objects
- KV caching

## Git / Task Hygiene

- Work in focused branches/PRs unless explicitly instructed otherwise.
- Keep unrelated refactors out of functional tasks.
- Do not rewrite history on shared branches.
- Each task return package should include changed files, tests run, test results, unresolved risks, and the final commit/PR reference.

## Documentation Updates

Update project docs when a task changes:

- system boundaries
- state model
- storage model
- security assumptions
- external contracts
- rollout/migration requirements

Do not let implementation silently diverge from the documented architecture.
