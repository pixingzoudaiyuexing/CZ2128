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

The repository is currently in **architecture review / pre-implementation**.

Do not begin application implementation until `ARCHITECTURE.md` is marked approved after independent review and Primary final decision.

## Architectural Boundaries

- Chatwoot is an upstream helpdesk adapter, not the core domain.
- Telegram is an operator channel adapter, not the core domain.
- AI providers are replaceable adapters.
- R2 is the first attachment-store adapter.
- D1 is the V1 canonical gateway database unless the approved architecture changes.
- Core code must not import provider-specific concepts unnecessarily.
- Do not modify or fork Chatwoot as part of CZ2128 V1.
- Do not copy the legacy Crisp implementation wholesale.

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

## Implementation Rules

- Use TypeScript.
- Keep modules small and dependency direction clear.
- Provider adapters depend on core contracts; core must not depend on provider implementations.
- All incoming webhooks require authentication/verification before processing.
- Every externally delivered event must be idempotent.
- Retries must not create duplicate customer-visible messages.
- Do not place file bodies in queue messages.
- R2 objects are private by default.
- Secrets belong in Cloudflare secrets/environment bindings, never committed files.
- Logs must redact secrets and sensitive URL/query values.
- Human support must keep working if AI is disabled or unavailable.

## Testing Rules

A task is not complete because code compiles.

For changed behavior:

- Add/update automated tests.
- Run typecheck/lint/tests as applicable.
- Validate migrations against a clean local/test database.
- For webhook/state changes, include duplicate-delivery tests.
- For retry changes, prove no duplicate visible messages.
- For attachment changes, test expiration and unauthorized access.

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