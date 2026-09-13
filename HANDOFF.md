# CZ2128 - Phase 1 Handoff

## 状态
- **Current Branch**: `gemini/phase1-foundation`
- **Reviewed Implementation Base SHA**: `2cdf7b7ea4011d50739263914d829632df06bab3`
- **PR**: #1
- **Final HEAD / CI**: 以独立审计 Return Package 和 PR #1 当前远端 HEAD 为准，不在本文件保存自指 SHA。
- **Migration**: Schema V1 `0001_initial_schema.sql` 由本地验证和 CI 从 clean D1 执行。

## 实际数据表 (Minimum Phase 1 Schema)
1. `conversations` (对话映射实体与基础追踪)
2. `messages` (去重用的 provider source)
3. `event_receipts` (`lease_until` + `claim_token` 实现带 ownership fencing 的 Atomic 消费票据)
4. `outbound_operations` (`lease_until` + `lease_token` 实现对外发信锁和 `AMBIGUOUS` 兜底)

## Known Limitations
- 第三方请求开始后若连接中断，或第三方已成功但 D1 结果落账失败，操作会进入/保留为 `AMBIGUOUS`，需要 Phase 4 的 reconciliation 或人工确认；系统不会盲目重发。
- Queue 最终失败会进入 `cz2128-dlq`，Phase 4 才提供完整检查和恢复工具。
- 本地开发对 D1 的 Mock 不可能 100% 还原 Cloudflare 线上 SQLite 方言，上线前需连接 Preview DB 测试。

## Codex Takeover Notes
对于后续接手阶段的 Codex，特别提醒：
1. **并发锁与队列**：Phase 1 已经打通 HTTP -> 归一化 version 1 envelope -> Queue -> `queue()` runtime，并实装 D1 CAS、owner token、`lease_until` 和 `AMBIGUOUS` 控制。如果增加事件类型，请版本化内部 contract 并复用 `event_receipts` 的 Atomic 模型。
2. **Phase 2 (AI Handoff + Multi-turn Context)**：V1 Schema 被极度简化，只包含了必选项，没有任何与 AI 有关的结构字段。Phase 2 正式开始前你需要创建 `migrations/0002` 以将这些业务表重新补充回来。
3. Phase 5 才会有 RAG，请不要在 Phase 2 时提前做错。
