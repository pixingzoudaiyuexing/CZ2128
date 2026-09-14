# CZ2128 Project

Status: **Phases 1-3.5 Complete / Phase 4A Frozen / Phase 4B-1 Complete**

## Purpose

CZ2128 is an independent, platform-agnostic customer support gateway. It connects a helpdesk platform, operator channels, AI providers, attachment storage, and optional external customer-data sources without making any one upstream platform part of the core domain.

The first production target is:

- Helpdesk: Chatwoot
- Operator channel: Telegram forum topics
- Runtime: Cloudflare Workers
- Database: Cloudflare D1
- Reliable asynchronous processing: Cloudflare Queues
- Attachment storage: Cloudflare R2
- AI: OpenAI-compatible API

Chatwoot, Telegram, Cloudflare, and any future business system are adapters/infrastructure, not the product's core identity.

## V1 Goals

1. Chatwoot user messages are reliably mirrored to a corresponding Telegram topic.
2. Telegram operator replies are delivered back to the correct Chatwoot conversation.
3. Chatwoot operator replies are mirrored to Telegram without creating echo loops.
4. AI auto-reply can be enabled/disabled per conversation.
5. Any human reply pauses AI; operator timeout can automatically restore AI on the next customer message.
6. Manual AI-off never auto-resumes until explicitly re-enabled.
7. AI replies use recent conversation context rather than only the current message.
8. Images and files use private temporary R2 storage and direct provider multipart delivery; an opaque-token proxy is available for explicit temporary-download consumers.
9. Incoming webhooks are authenticated and idempotent.
10. Queue retries use stable event/operation identity so normal retries do not duplicate customer-visible messages; ambiguous third-party delivery outcomes are explicitly recorded rather than hidden behind a false exactly-once guarantee.
11. Core flows have automated tests, including duplicate delivery and AI/operator race cases.
12. Frequently changed provider and runtime limits can be managed from an authenticated Telegram admin control plane without routine Worker redeployment.

## V1 Non-Goals

The following are intentionally deferred:

- Custom replacement for the Chatwoot customer widget
- Modifying/forking Chatwoot source code
- Full RAG/vector knowledge base
- Automatic permanent learning from every operator answer
- Multi-channel support beyond Telegram
- Multi-helpdesk support beyond Chatwoot
- Multi-tenant SaaS control plane
- Custom analytics/admin dashboard
- Durable Objects unless testing proves D1/Queues insufficient for conversation consistency
- KV caching without a measured need

## Product Principles

- **Upstream-friendly:** Keep Chatwoot unmodified whenever possible. Integrate through supported APIs/Webhooks.
- **Platform-agnostic core:** Core code uses conversation/message/customer/operator abstractions, not Chatwoot-specific domain types.
- **Reliable before clever:** Duplicate prevention, retries, message ordering, security, and observability come before advanced AI features.
- **AI is optional:** Human support must continue to work when the AI provider is unavailable.
- **Human wins races:** If an operator intervenes while AI is generating, the human state wins and stale AI output is discarded.
- **Private-by-default attachments:** R2 objects are private; access is granted through opaque expiring gateway links.
- **Exact logical expiration:** Application-level expiry is enforced even if physical R2 lifecycle deletion happens later.
- **No automatic unreviewed learning:** Human answers may become knowledge candidates, but publication requires review in a later phase.
- **Bootstrap remains recoverable:** The admin bot, its administrator allowlist and the runtime encryption master key remain deployment-level settings outside the runtime control plane.

## Legacy Reference

`pixingzoudaiyuexing/Crisp-Telegram-Bot` is a reference implementation only. Useful behavior may be migrated, especially:

- Telegram topic-per-conversation workflow
- AI on/off controls
- Human handoff and auto-resume behavior
- Silent-notification policy
- Learning-event concepts
- Echo-loop prevention intent

Crisp-specific APIs, session models, content-hash echo detection, and KV-as-primary-state patterns must not be copied blindly.

## Definition of V1 Done

V1 is complete only when the Chatwoot ↔ Telegram ↔ AI ↔ R2 flow works end-to-end with D1 persistence, webhook verification, provider-ID/operation-ID-based idempotency and echo prevention, Queue retry behavior, guarded AI generation, attachment expiry, and automated tests for critical state transitions and failure modes.
