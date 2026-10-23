# 陪伴系统持久化兼容性门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成完整重建的第一道门禁：真实 SDK 的持久化、过滤、更正、删除、恢复与第三方 API 配置验证，禁止未验证即替换旧运行路径。
**Architecture:** 在独立 workspace 包中安装锁定版本 SDK，保留旧机器人不变。数据库实测使用隔离的 pgvector 容器；确定性本地 OpenAI-compatible HTTP fixture 仅验证协议，真实第三方 API 另设显式 opt-in 验证。
**Tech Stack:** Node24、pnpm、TypeScript、Mem0 OSS、LangGraph、PG checkpointer、pgvector。
**Spec:** `docs/superpowers/specs/2026-10-22-companion-execution-brief.md`（用户原设计的约束摘要，非原文副本）

## Global Constraints
- Node.js 24 LTS、TypeScript、pnpm workspace。
- Mem0 OSS TypeScript 为唯一自动记忆引擎；禁止默认内存向量与隐式临时历史。
- LangGraph 生产使用 PostgreSQL checkpoint，禁止仅 MemorySaver。
- 所有推理与向量计算使用第三方 API；本地 HTTP fixture 仅测试，不成为业务服务。
- 不改动 `data/`，不删除旧代码，不推送、不部署、不发实际 QQ 消息。
- commit message 全中文，secret 不写日志或版本库。
- 测试结果区分 protocol-fixture、live-api、blocked；缺配置必须非零退出，不能跳过后报成功。

## Review Focus
- 不同人物、圈子、私聊范围过滤不能因重启丢失或扩大。
- Mem0 的 history、vector 和 LangGraph checkpoint 要分别持久化并验证恢复。
- 更正/删除应检查旧结论实际不可检索，不只检查 API 返回成功。
- 向量维度、模型/端点缺失与密钥不能被默认值掩盖或日志泄漏。
- 外部网络失败应有界退出，测试进程、连接池和 fixture 均须释放。

### Task 1: 锁定版本与可运行的隔离兼容性包
**Files:** `pnpm-workspace.yaml`, `packages/compatibility/package.json`, `packages/compatibility/tsconfig.json`, `packages/compatibility/src/config.ts`, `packages/compatibility/test/config.test.ts`, `.gitignore`, `pnpm-lock.yaml`。
**Interfaces:** produces `loadConfig(env: NodeJS.ProcessEnv): CompatibilityConfig` containing mode, database URL, explicit memory/chat/embedding models/endpoints/keys/dimension and persistent history path. Missing config throws sanitized errors.
- [ ] Write tests for missing database, models/keys/dimensions/history, invalid dimension, and no credential disclosure.
- [ ] Run tests; expected missing module/export failure before implementation, then actual assertion failures if stubbing.
- [ ] Implement config and lock versions from inspected published SDK; explicitly allow required native build scripts only.
- [ ] Run unit tests and package typecheck; expected pass. Run old `pnpm codex:check`; preserve baseline evidence.
- [ ] Commit with Chinese message.

### Task 2: 真实数据库 SDK 集成验证

实施拆为2a（Mem0/HTTP fixture）与2b（PostgreSQL图恢复/CLI）；均完成并复审后才算本任务通过。接口由2a报告固定，2b消费，原验收范围不减少。
**Files:** `packages/compatibility/src/run.ts`, `packages/compatibility/test/protocol-fixture.ts`, `packages/compatibility/test/persistence.test.ts`, `packages/compatibility/compose.yaml`, `packages/compatibility/README.md`。
**Interfaces:** consumes Task1 config; produces CLI returning nonzero on failure and sanitized report with separate protocol/live status, SDK versions, check outcomes.
- [ ] Write failing persistence tests using actual Mem0 OSS + actual Postgres/pgvector + actual PostgresSaver and a deterministic HTTP fixture. Assert two identities/scopes, add/search, update old text absent, delete absent, new client restart recovery, durable history, checkpoint interrupted/resumed without rerunning completed node.
- [ ] Run tests and inspect intended failure.
- [ ] Implement SDK adapters/harness from inspected APIs, not guessed Platform APIs. Use test-owned databases/tables/namespaces; require explicit isolated test target; close all SDK pools, graph savers, HTTP servers.
- [ ] Run tests, restart database container retaining volume and run persistence verification; expected actual persisted values survive. Document exact unsupported OSS filters rather than hiding them.
- [ ] Add live opt-in CLI; missing credentials must fail clearly without secret values. No real API requests without user-provided configuration. Document environmental blocks separately.
- [ ] Commit Chinese message.

### Task 3: 验证报告与后续迁移门禁
**Files:** `docs/implementation/compatibility-report.md`, `docs/implementation/progress.md`, package scripts and README as needed.
**Interfaces:** consumes Task2 outcomes; produces explicit go/no-go for next stage, tested dependency versions, exact rerun commands and missing conditions.
- [ ] Run package unit/typecheck/integration and old codex check, inspect output. Verify runtime data unchanged.
- [ ] Review complete diff independently; fix Important findings with regression tests.
- [ ] Record status honestly: protocol-fixture passing is not live API passing. If live credentials absent, full first-stage acceptance remains blocked, no old-source deletion or production cutover.
- [ ] Commit report with Chinese message; preserve branch locally.

## 后续计划边界
完整业务重建仍按设计阶段2—7实施。本计划先解决设计明确要求的 SDK 可行性前置条件；外部 API 或 SDK 能力无法满足时，不猜测核心持久化行为并继续破坏性重建。下一计划从已验证接口出发细化数据库、身份、outbox、迁移、备份、图流程、业务网关和管理端。未完成事项持续列在 progress.md。
