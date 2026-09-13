# CZ2128 - Phase 2 Handoff

## 状态
- **Parent Branch**: `gemini/phase1-foundation`
- **Parent SHA**: 2cdf7b7ea4011d50739263914d829632df06bab3
- **Current Branch**: `gemini/phase2-ai-handoff`
- **PR #1**: Phase 1 frozen / unmerged
- **PR #2**: Phase 2 stacked PR
- **CI**: SUCCESS
- **Migration**: Schema V2 `0002_ai_handoff.sql` 已添加。

## Phase 2 Scope Completed
- 实现完整的 OpenAI-compatible AI adapter。
- 引入了 `ai_mode` (ENABLED, PAUSED_OPERATOR, PAUSED_MANUAL) 人类接管状态机。
- 引入了严格的 `ai_generation_id` 和基于 D1 CAS 的并发生成排他锁（Generation Concurrency）。
- 处理了并发 Race：人工在生成期间回复会安全丢弃旧 AI 结果，连续客户发问安全退避并依赖排队重试。
- 具备基础的 Message Context Budget 控制。
- `/ai_on` 与 `/ai_off` Telegram 命令支持。
- AI Outbound 完全桥接复用 Phase 1 管道并带回显消除。

## Tests
- Race Tests: Operator reply during generation -> DISCARD, Rapid customer messages -> RETRY, AI provider failure -> RELEASE.
- Context & Config defaults, Handoff transitions.

## Known Limitations
- AI Budget 目前只依靠粗略字符数 (`AI_CONTEXT_MAX_CHARS`) 计算，可能对实际 LLM Token 数目略有偏差。
- 错误日志没有上报机制，必须依靠 Cloudflare 后台排查。

## Codex Takeover Notes
对于后续接手的 Codex：
1. **重点重新验证**：`src/core/ai-state.ts` 中的 `acquireGenerationLease` 及其 `UPDATE ... WHERE ... AND ... < ...` 的逻辑。
2. **Race condition**：最危险的场景是 AI 请求耗时几十秒期间，发生了多次人工接管、人工解除、客户连续留言，这套依靠 `ai_generation_id` 强绑定的方案在理论上安全，但需要 Staging 环境与真实 provider 进行长时间检验。
3. Phase 3 如果要增加 RAG 或 Vector DB，请利用 Phase 2 的 Context 提取做挂载，不应破坏现有的流转安全锁。
