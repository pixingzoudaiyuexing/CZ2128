# CZ2128 - Phase 2 Handoff

## 状态
- **Implementation Base SHA**: 2cdf7b7ea4011d50739263914d829632df06bab3
- **Last Reviewed Implementation SHA**: bc782d9b75f7b6cff87e95a950f1cb925f77d16d
- **Current Branch**: `gemini/phase2-ai-handoff`
- **PR #1**: Phase 1 frozen / unmerged
- **PR #2**: Phase 2 stacked PR
- **Migration**: Schema V2 `0002_ai_handoff.sql` 已添加并验证通过。

## Phase 2 Scope Completed
- 实现完整的 OpenAI-compatible AI adapter。
- 引入了 `ai_mode` (ENABLED, PAUSED_OPERATOR, PAUSED_MANUAL) 人类接管状态机，包含 SQLite `CHECK` 约束。
- 引入了严格的 `ai_generation_id` 和 `ai_handoff_epoch`。
- 处理了并发 Race：人工在生成期间或真正发包前回复，均会通过 epoch mismatch 断然放弃并标为 `CANCELLED_BY_HANDOFF`。连续客户发问安全退避抛出 `RetryLaterError(delay)` 并依靠 Cloudflare 排队重试。
- 具备严格的 Message Context Budget 控制与基于 `rowid` 的稳定 Tie-breaker 排序。
- `/ai_on` 与 `/ai_off` Telegram 命令支持，并通过 `outbound_operations` 进行可靠的回执。
- AI Outbound 完全桥接复用 Phase 1 管道并带回显消除。
- 完善的可靠性强化（Reliability Hardening）：延时重试（Delayed Retry）、稳定的生成尝试身份验证（Stable AI Job Identity）、持久化生成结果复用（Durable Generated Result）。

## AI Retry Strategy
- **Stable AI Job Identity**: 每一个 AI 触发源（Customer 消息创建事件）作为稳定的唯一标识（`trigger_event_ref`）。
- **Generation Attempt Identity**: 每次向 AI 发起真正请求前，会分配唯一的 `generation_id`，并记录在 `ai_runs` 中。每个 Attempt 会重新分配。
- **Delayed Retry**: Cloudflare Queue 利用了原生的 `message.retry({ delaySeconds })`。当 `acquireGenerationLease` 检测到已经有一个未过期的并发生成进行中时，它会通过预估 `leaseExpiryThreshold - now + margin`，抛出 `RetryLaterError(delay)`，在 `index.ts` Worker 顶层捕获并实施重试。
- **Durable Generated Result**: 在执行昂贵的 Chatwoot/Telegram 网络传输前，将成功的 AI 生成结果保存至 `ai_runs` 表中。一旦由于外部投递失败而触发重试，重试执行将首先检查是否有历史 SUCCESS 生成并直接跳过 LLM 环节。
- **Stable Outbound Operation IDs**: 基于固定的 Job ID 进行投递标识：`ai_reply:<job-id>` 与 `ai_tg_mirror:<job-id>`。结合 D1 事务保证幂等，彻底防止重试时造成多发或者丢包。

## Event Receipt Lease & Configs
- **AI Event Receipt Lease**: 普通 webhook 触发保留默认 30s 锁；`ai_trigger` 内部事件动态计算为 `generationLeaseSeconds + 15`，以满足最长时间限制。

## Context Rules
- 稳定排序：`ORDER BY created_at DESC, rowid DESC`，确保并发毫秒下记录相对顺序一致。
- 硬性截断：只要叠加当前累加记录超出 `contextMaxChars`，立刻 `substring` 裁剪截断当前消息，不让后续更老消息进入上下文。
- 可见性绑定：只有等到最终对 Chatwoot `SEND_MESSAGE` Http 调用宣告完毕或进入队列后，`actor_role = AI` 记录才真正落入 `messages` 表，从根源断绝“AI 回复由于外部原因失败，下一次会话仍然看到其存在于上下文”这一隐患。

## Codex Takeover Notes
对于后续接手的 Codex：
1. **重点重新验证**：`src/core/ai-state.ts` 中的 `acquireGenerationLease` 以及 `ai_handoff_epoch` 的控制与递增。
2. **Race condition**：最危险的场景是 AI 请求耗时几十秒期间，发生了多次人工接管、人工解除、客户连续留言，这套依靠 `ai_handoff_epoch` 强绑定的方案以及 `verifyHandoffEpoch` preflight 拦截，在理论上安全，但需要 Staging 环境与真实 provider 进行长时间检验。
3. 请严格按照 ROADMAP 定义的 Phase 演进：
   - Phase 3 = Unified Temporary Attachments / R2
   - Phase 4 = Reliability Hardening
   - Phase 5 = Knowledge / RAG
   请勿跨越。

