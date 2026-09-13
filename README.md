# CZ2128

## 什么是 CZ2128?
CZ2128 是一个独立于平台的客户服务网关。它连接 Helpdesk（Chatwoot）、客服渠道（Telegram）和AI提供商，形成可靠的通讯桥梁。核心系统不将任何特定的上游平台作为领域模型，保障未来平滑迁移的能力。

## Architecture Overview
CZ2128 使用 Cloudflare Workers 架构：
- **Cloudflare Workers**: 无状态 HTTP 处理和 Webhook 入口
- **Cloudflare D1**: 核心的关系型状态数据库，记录对话映射、幂等性 Receipts 以及 Outbound Operations。
- **Cloudflare Queues**: 确保可靠异步处理（At-least-once），消费者执行状态转移和外部 API 调用。
- **Cloudflare R2**: 私有文件/图片存储（未来阶段使用）。

在当前 Phase 1 阶段，1 个 Chatwoot 对话会被映射到 1 个 Telegram Forum Topic。

## Current Phase
**Phase 1 — Foundation + Chatwoot/Telegram Core**
目前完成了核心的消息桥接，实现了双向文字同步，没有引入 AI 功能。具备 Webhook 验证、幂等控制、队列安全重试功能。

## Local Development
1. `npm install`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test`

## Cloudflare Resources
项目依赖如下 Cloudflare 资源：
- D1 数据库：用于规范数据（Conversations, Messages, Outbound Operations, Event Receipts, Attachments）。
- Queues：一个主队列，带 DLQ 用于失败事件处理。
- R2 桶（待定）：用于附件存取。

## D1 / Queue Requirements
- **D1 必须强制一致性**：核心使用关系表确保不创建重复的话题映射。
- **Queue At-least-once**：消费者代码必须设计为幂等的。所有重试操作和外部副作用，都受到 `event_receipts` 表和 `outbound_operations` 锁表保护。

## Secrets
配置的 Cloudflare 环境变量/Secrets：
- `CHATWOOT_WEBHOOK_SECRET`: Chatwoot 的 Webhook 验签密钥 (例如 `cw_test_secret_abc123`)
- `CHATWOOT_API_URL`: Chatwoot API 地址 (例如 `https://chat.example.com`)
- `CHATWOOT_API_TOKEN`: Chatwoot API Token (例如 `fake_chatwoot_token_xyz`)
- `TELEGRAM_WEBHOOK_SECRET`: Telegram Bot API Token 的 webhook secret header (例如 `tg_secret_123`)
- `TELEGRAM_SECRET_PATH`: Telegram Webhook 隐藏路径 (例如 `some_opaque_path`)
- `BOT_GROUP_ID`: Telegram 指定处理业务的群组 ID (例如 `-100123456789`)
- `TELEGRAM_BOT_TOKEN`: Telegram Bot Token (例如 `123456:fake_bot_token`)

**请注意：本文档中的任何 Token 皆为假数据，生产环境请在 Cloudflare Secrets 中配置。**

## Chatwoot Setup
1. 在 Chatwoot 配置 Webhook URL 为 `https://<YOUR_WORKER>/webhooks/chatwoot`
2. 订阅 `message_created`, `conversation_resolved`, `conversation_opened` 事件。
3. 提取对应的 Webhook Secret。

## Telegram Setup
1. 准备一个 Telegram 机器人并获取 Token。
2. 设定 Webhook：调用 `setWebhook` 接口将 URL 设为 `https://<YOUR_WORKER>/webhooks/telegram/<TELEGRAM_SECRET_PATH>`，并传入 `secret_token`。
3. 将机器人加入指定的启用了 Forum 功能的 Group，并将其设为 Admin（可以管理 Topics）。

## Tests
所有测试都使用 Vitest 进行。包括：
- `tests/webhook.test.ts`: Chatwoot 和 Telegram Webhook 的签名校验。
运行 `npm run test` 进行完整测试验证。
