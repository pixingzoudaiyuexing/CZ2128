# CZ2128 Handoff

## 1. Context
**Current Phase**: Phase 1 — Foundation + Chatwoot/Telegram Core
**Current Branch**: `gemini/phase1-foundation`
**Base SHA**: b1f05a9e069e85ad61a6f32228985daf34c8a27b
**Current/Final SHA**: 4b4791105126682a051484f801a0ce2e9ddbbdd8
**PR**: TBD (Pending creation)

## 2. Completed Scope
- **TypeScript & Cloudflare Workers 架构初始化**，包含完整的 Type 检查和测试。
- **核心数据模型 (D1)**: 包括 `conversations`, `messages`, `event_receipts`, `outbound_operations`, `attachments` (为 Phase 3 准备)。
- **Webhook 层安全校验**:
  - Chatwoot: 包含 `X-Chatwoot-Signature` (HMAC SHA256) 与 `X-Chatwoot-Timestamp` 校验（5分钟 replay window 防御）。
  - Telegram: 包含 `X-Telegram-Bot-Api-Secret-Token` 以及路径校验。
- **核心业务逻辑 (队列消费者)**:
  - 处理了 Cloudflare Queues 重复投递的情况（利用 `event_receipts`）。
  - 处理了外部 API 的幂等发送（利用 `outbound_operations` 加锁）。
  - **1 对 1 话题映射**: 创建 Topic, 关闭 Topic, 重新打开 Topic。
  - **双向消息投递**: 客户->Telegram; 坐席->Chatwoot; Chatwoot代理->Telegram。
  - 基于 `source_id` 的 Echo Loop 过滤。

## 3. In Progress
- 无，Phase 1 基础已全部编写完毕。

## 4. Not Started (Phase 2 & beyond)
- AI 生成 (RAG、知识库)。
- Durable Objects (非 Phase 1 需要)。
- Attachment (R2) 具体上传和处理。
- Analytics UI。
- 其他 Helpdesk 或多渠道支持。

## 5. Tests
测试包含:
- Chatwoot Webhook (Valid HMAC, Invalid HMAC, replay, etc)
- Telegram Webhook (Valid token, invalid path)
> **CI 状态**: (Local) npm run test 运行成功。CI 需要 GitHub Actions 配合，由于未连接生产环境可作为下一阶段的任务。

## 6. Known Issues / Limitations
- 尚未编写处理附件下载（Telegram 端文件下载和 R2 存储）的代码。
- 当前为了降低测试复杂性，Vitest 只对逻辑（Webhook）进行验证，D1 的真实集成测试需要本地 Miniflare / Wrangler D1 集成支持，由于依赖配置目前处于 Node 测试环境。

## 7. Architecture Deviations
- **无**。严格执行了 Architecture 中的 D1 为系统数据中心，Queue 确保重试操作安全的策略。

## 8. Important Implementation Notes
- `outbound-operations.ts` 实现了完整的 Lease（借出/租约）锁：在调用外部 API (Telegram / Chatwoot) 之前更新状态为 `SENDING`。防止队列由于 At-least-once 机制导致并发重复发送。
- `chatwoot-handler.ts` 确保了如果当前 Chatwoot conversation 未包含 `operator_thread_ref`，则立即调用 Telegram 创建话题 (Topic)，再转发消息。

## 9. Recommended Next Step
- 审查 `gemini/phase1-foundation` 代码并执行部署到 Cloudflare 预览环境验证。
- 随后开启 Phase 2 开发，添加 OpenAI-compatible adapter 并设计 AI Handoff。

## 10. Codex Takeover Notes
对于后续接管的 Codex 模型，建议:
- **最应该先检查什么**: `src/queue/consumer.ts` 以及 `src/core/outbound-operations.ts`，这里是保证消息幂等和并发安全的核心。
- **哪些部分风险最高**: 复杂的网络问题下 Chatwoot / Telegram 如果超时但已处理，需确保重试机制正确恢复 (可审查 `last_error` 和 `status` 的流转)。
- **哪些代码尚未完全验证**: 真实的 D1 和 Queue 环境需要集成测试；代码内使用了 Cloudflare Workers APIs。
- **哪些实现选择是有意为之**: `1 对话 = 1 话题` 强绑定。没有引入外加的数据层结构，保证精简。
