# oh-bot 本地开发接手说明（2026-10-23）

## 整合来源
- `main`：保留已合并 PR #11–#14 及已暂停的自动编码工作流。
- `feat/companion-v3`：整合 QQ Bot、Vue 管理端、Companion、Compatibility、Drizzle 迁移、测试与实现文档。
- `dev`：其业务代码已包含在 `feat/companion-v3`，不重复合并。
- `automation/retry-*`：有未通过完整验收的试验增量，保留原分支，未并入 `main`。

## 开发命令
```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm -r --if-present typecheck
pnpm -r --if-present test
pnpm --filter @oh-bot/companion build
pnpm exec tsx packages/companion/src/cli/chat.ts --help
```

旧 QQ Bot 需要 `cp .env.example .env`，配置 NapCat、模型 API 后执行 `pnpm dev`，Vue 管理端执行 `pnpm admin:dev`。

Companion 终端聊天需要 `COMPANION_CHAT_API_URL`、`COMPANION_CHAT_API_KEY`、`COMPANION_CHAT_MODEL`，执行 `pnpm exec tsx packages/companion/src/cli/chat.ts`。该入口尚未集成可信身份、数据库多轮历史或 QQ。

PostgreSQL 集成测试需要**专用隔离数据库** `oh_bot_core_v2_compat` 和 `oh_bot_worker_compat`，设置 `CORE_TEST_DATABASE_URL`、`WORKER_TEST_DATABASE_URL` 后执行 `bash .github/codex/check.sh`。切勿使用生产库。GitHub CI 会准备隔离数据库并运行相同检查。

## 功能现状
已实现基础：业务 schema/Drizzle 迁移、身份绑定与披露策略、消息事务/租约/幂等、管理 API、pg-boss Worker、记忆 ACL 与更正/遗忘账本、OpenAI-compatible 模型网关及本地终端聊天、Mem0/LangGraph 兼容性实验。

未完成或未验证：新 Companion 的多用户聊天历史完整接线、人格与关系运行闭环、Mem0/LangGraph 正式业务集成、真实 QQ/OneBot 接线、真实模型 API 验收和生产端到端。旧 QQ Bot 与新 Companion 是**并存而非已经打通**的两条代码路径。

## 隐私与自动化
`data/*.json`、`data/plugins/*.json`、`docker/ds2api/config.json` 是本地运行数据/凭据，不纳入主分支。可用 `data/rules.example.json` 与 `docker/ds2api/config.example.json` 作为脱敏参考。运行数据缺失时旧 Bot 会使用代码默认值。

**安全提醒**：历史开发分支曾提交真实会话记录、平台用户标识、API Key 和账户密码。本次排除主分支合并，但历史 Git 对象可能仍可访问；请轮换密钥并另行清理历史。

`unattended-codex.yml`、`parallel-mvp.yml` 保持暂停；`ci.yml` 只测试，不调用编码模型、不写代码、不部署。
