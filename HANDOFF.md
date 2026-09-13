# CZ2128 - Phase 2 Handoff

## 状态
- **Parent Branch**: `gemini/phase1-foundation`
- **Parent SHA**: 2cdf7b7ea4011d50739263914d829632df06bab3
- **Current Branch**: `gemini/phase2-ai-handoff`
- **Final SHA**: 3430e14aa88e673538d1bb95915df4fa036c31d6
- **PR #1**: Phase 1 frozen / unmerged
- **PR #2**: Phase 2 stacked PR
- **CI**: SUCCESS
- **Migration**: Schema V2 `0002_ai_handoff.sql` 已添加并验证通过。

## Phase 2 Scope Completed
- 实现完整的 OpenAI-compatible AI adapter。
- 引入了 `ai_mode` (ENABLED, PAUSED_OPERATOR, PAUSED_MANUAL) 人类接管状态机。
- 引入了严格的 `ai_generation_id` 和基于 D1 CAS 的并发生成排他锁（Generation Concurrency）。
- 处理了并发 Race：人工在生成期间回复会安全丢弃旧 AI 结果，连续客户发问安全退避并依赖排队重试。
- 具备严格的 Message Context Budget 控制与稳定的 Tie-breaker 排序。
- `/ai_on` 与 `/ai_off` Telegram 命令支持，并通过 `outbound_operations` 进行可靠的回执。
- AI Outbound 完全桥接复用 Phase 1 管道并带回显消除。
- 完善的可靠性强化（Reliability Hardening）：延时重试（Delayed Retry）、稳定的生成尝试身份验证（Stable AI Job Identity）、持久化生成结果复用（Durable Generated Result）。

## Tests
新增和优化的测试位于 `tests/ai-handoff.test.ts` (共计 9 个测试)：
- duplicate AI trigger: ATOMIC CAS 锁竞争失败测试
- generated result retry: 模拟 AI 成功但外部投递失败导致重试时复用 AI 生成结果
- Telegram mirror retry: 由于 Chatwoot 投递失败导致后续不重新请求 AI，并能够安全重试
- rapid customer message eventual success: 第二条客户消息因当前正处于生成 Lease 保护抛出 RetryLaterError
- operator during AI request: 在生成期间人工插入，结果被 DISCARD
- operator after AI result before outbound: 在 HTTP 发包前的 Preflight guard 被阻截
- PAUSED_MANUAL no auto resume: 手动关闭 AI 即使超时也不会自动恢复
- Chatwoot operator pause: 正常由 Chatwoot 客服人工触发的暂停
- context order/budget: 严谨测试超大字符消息直接截断，且采用相同的 timestamp 能被 tie-breaker 稳定排序
- AI unconfigured: 未配置 AI 时自动 bypass

## AI Retry Strategy
- **Stable AI Job Identity**: 每一个 AI 触发源（Customer 消息创建事件）作为稳定的唯一标识（`trigger_event_ref`）。
- **Generation Attempt Identity**: 每次向 AI 发起真正请求前，会分配唯一的 `generation_id`，并记录在 `ai_runs` 中，防止因 Lease 超时、过期以及各种并发造成的状态混淆。
- **Delayed Retry**: Cloudflare Queue 利用了原生的 `message.retry({ delaySeconds })`。当 `acquireGenerationLease` 检测到已经有一个未过期的并发生成进行中时，它会通过预估 `leaseExpiryThreshold - now + margin`，抛出 `RetryLaterError(delay)` 控制合理的 Queue 延时退避，而不阻塞当前 Worker 运行。
- **Durable Generated Result**: 在执行昂贵的 Chatwoot/Telegram 网络传输前，将成功的 AI 生成结果保存至 `ai_runs` 表中。一旦由于外部投递失败而触发重试，重试执行将首先检查是否有历史 SUCCESS 生成并直接跳过 LLM 环节，防止再次调用改变语意并节省 Token 成本。
- **Stable Outbound Operation IDs**: 基于固定的 Job ID 进行投递标识：`ai_reply:<job-id>` 与 `ai_tg_mirror:<job-id>`。结合 D1 事务保证幂等，彻底防止重试时造成多发或者丢包。

## Event Receipt Lease & Configs
- **AI Event Receipt Lease**: 普通 webhook 触发保留默认 30s 锁；`ai_trigger` 内部事件动态计算为 `generationLeaseSeconds + 15`，以满足最长时间限制。
- **Configs**: 所有的变量引入了 `parseBoundedInt` 进行合法区间校验。
  - `AI_REQUEST_TIMEOUT_MS`: 5000 ~ 120000 (默认 30000)
  - `AI_CONTEXT_MAX_MESSAGES`: 1 ~ 100 (默认 20)
  - `AI_CONTEXT_MAX_CHARS`: 1000 ~ 100000 (默认 12000)
  - `AI_GENERATION_LEASE_SECONDS`: 10 ~ 300 (默认 60，并且代码保证大于等于 `ceil(requestTimeoutMs/1000) + 10` 安全冗余)
  - `AI_OPERATOR_PAUSE_TIMEOUT_SECONDS`: 60 ~ 86400 * 30 (默认 3600)

## Context Rules
- 稳定排序：`ORDER BY created_at DESC, id DESC`，确保并发毫秒下记录相对顺序一致。
- 硬性截断：只要叠加当前累加记录超出 `contextMaxChars`，立刻 `substring` 裁剪截断当前消息，不让后续更老消息进入上下文。
- 可见性绑定：只有等到最终对 Chatwoot `SEND_MESSAGE` Http 调用宣告完毕或进入队列后，`actor_role = AI` 记录才真正落入 `messages` 表，从根源断绝“AI 回复由于外部原因失败，下一次会话仍然看到其存在于上下文”这一隐患。

## Codex Takeover Notes
对于后续接手的 Codex：
1. **重点重新验证**：`src/core/ai-state.ts` 中的 `acquireGenerationLease` 及其 `UPDATE ... WHERE ... AND ... < ...` 的逻辑。
2. **Race condition**：最危险的场景是 AI 请求耗时几十秒期间，发生了多次人工接管、人工解除、客户连续留言，这套依靠 `ai_generation_id` 强绑定的方案以及 `verifyGenerationLease` preflight 拦截，在理论上安全，但需要 Staging 环境与真实 provider 进行长时间检验。
3. 请严格按照 ROADMAP 定义的 Phase 演进：
   - Phase 3 = Unified Temporary Attachments / R2
   - Phase 4 = Reliability Hardening
   - Phase 5 = Knowledge / RAG
   请勿跨越。

