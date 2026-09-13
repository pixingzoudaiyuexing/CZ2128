# CZ2128 - Phase 1 Handoff

## 状态
- **Current Branch**: `gemini/phase1-foundation`
- **Final SHA**: 待 Commit 之后最后更新
- **PR**: #1
- **CI**: GitHub Actions `build-and-test` 已真实通过。
- **Migration**: Schema V1 `0001_initial_schema.sql` 已经真实跑通。

## 实际数据表 (Minimum Phase 1 Schema)
1. `conversations` (对话映射实体与基础追踪)
2. `messages` (去重用的 provider source)
3. `event_receipts` (加入了 lease_until 支持 Atomic 消费的排队票据)
4. `outbound_operations` (对外的发信锁和 AMBIGUOUS 兜底)

## Known Limitations
- 在某些极端的重发或未定义 Webhook 的 payload 模型改变时，由于严格去重和 AMBIGUOUS 机制介入，可能会使得对应操作进入死信并需要管理员干预才能在数据库恢复状态；没有额外的监控 Dashboard 将其展现到 UI 是当前的唯一限制（将留给 Phase 4）。
- 本地开发对 D1 的 Mock 不可能 100% 还原 Cloudflare 线上 SQLite 方言，上线前需连接 Preview DB 测试。

## Codex Takeover Notes
对于后续接手阶段的 Codex，特别提醒：
1. **并发锁与队列**：Phase 1 已经打通 HTTP -> 队列 -> `queue()` runtime 的通道，并实装了基于 D1 CAS 的 `lease_until` 和 `AMBIGUOUS` 控制，这是出入两端的生命线。如果增加排队类型，请复用 `event_receipts` 的 Atomic 模型。
2. **Phase 2 (AI Handoff + Multi-turn Context)**：V1 Schema 被极度简化，只包含了必选项，没有任何与 AI 有关的结构字段。Phase 2 正式开始前你需要创建 `migrations/0002` 以将这些业务表重新补充回来。
3. Phase 5 才会有 RAG，请不要在 Phase 2 时提前做错。
