# oh-bot

QQ 聊天机器人，保留旧版 NapCat Bot，并提供独立的 Companion：版本人格、关系、长期记忆、终端聊天和管理端。

## 先选启动方式

| 你想做什么 | 使用入口 |
| --- | --- |
| 运行原有 QQ Bot、插件和旧管理端 | [旧版 Bot](#旧版-qq-bot) |
| 本地试聊模型，无需数据库 | [终端试聊](#终端试聊无需数据库) |
| 使用新的人格、关系、持久会话和管理端 | [Companion](#companion本地启动) |

`pnpm start`、`pnpm dev` 启动的是旧版 Bot。连接同一个 QQ 账号时，只运行一条消息处理链路，避免重复回复。

## 安装

需要 **Node.js 24、pnpm 11.25.0**。Companion 另需 PostgreSQL 17；下面提供 Docker 启动示例。

```bash
git clone https://github.com/sekaiai/oh-bot.git
cd oh-bot
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
```

以下命令均从仓库根目录执行；环境变量示例使用 Bash。

## 旧版 QQ Bot

```bash
cp .env.example .env
```

编辑 `.env`，至少配置 NapCat 的 `NAPCAT_WS_URL`、`NAPCAT_ACCESS_TOKEN`，以及模型的 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。需要管理页面时，设置自己的 `ADMIN_PASSWORD`。

```bash
pnpm dev              # Bot + 管理 API，默认 3100
# 另开终端
pnpm admin:dev        # 旧管理页面，默认 http://127.0.0.1:5173
```

在 NapCat 登录 QQ 后，通过私聊或群聊使用机器人。天气、DS2API、富媒体及部署配置见 [旧版详细说明](docs/legacy-guide.md)。

构建后运行：`pnpm build && pnpm start`；旧管理端构建：`pnpm admin:build`。

## 终端试聊（无需数据库）

配置你自己的 OpenAI 兼容服务：

```bash
export COMPANION_CHAT_API_URL='https://你的服务地址/v1'
export COMPANION_CHAT_API_KEY='你的业务密钥'
export COMPANION_CHAT_MODEL='实际模型名称'
pnpm --filter @oh-bot/companion build
node packages/companion/dist/cli/chat.js
```

输入消息开始聊天，`/exit` 退出。试验人格可追加 `--sandbox --sandbox-file .local/persona.json`，用 `/persona 你的设定` 修改。

此模式会调用真实模型并产生费用，不保存数据库会话，也不接入 QQ。

## Companion：本地启动

### 1. 准备数据库

已有 PostgreSQL 17 可直接创建独立开发库；否则用 Docker：

```bash
docker run -d --name oh-bot-local-db \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=companion \
  -e POSTGRES_PASSWORD=local-dev-only \
  -e POSTGRES_DB=oh_bot_local \
  -v oh-bot-local-pg:/var/lib/postgresql/data \
  pgvector/pgvector:pg17
```

这里的密码仅用于本机开发。等待数据库启动完成；以后使用 `docker start oh-bot-local-db`，无需重复创建容器。

### 2. 初始化并启动 API + worker

```bash
export COMPANION_DATABASE_URL='postgresql://companion:local-dev-only@127.0.0.1:5432/oh_bot_local'
export COMPANION_ADMIN_TOKEN="$(openssl rand -hex 32)"
export COMPANION_ADMIN_HOST='127.0.0.1'
export COMPANION_ADMIN_PORT='3010'
export COMPANION_ADMIN_CORS_ORIGINS='http://127.0.0.1:5174'
export COMPANION_ONEBOT_ENABLED='0'
export COMPANION_PROACTIVE_ENABLED='0'

pnpm --filter @oh-bot/companion build
node packages/companion/dist/cli/start.js --setup  # 首次初始化后退出
node packages/companion/dist/cli/start.js          # 日常启动
```

Companion **不会自动读取根目录 `.env`**，需在启动它的终端导出变量。保存好生成的管理令牌，管理页面登录时需要使用；再次启动时复用自己的令牌。

另开终端检查：`curl -fsS http://127.0.0.1:3010/health`。数据库就绪应返回 `status: "ready"`；worker 日志应出现 `COMPANION_WORKER_READY`。按 Ctrl+C 同时停止 API 和 worker。基础就绪不代表模型或 QQ 已连通。

### 3. 打开新管理端

另开终端运行：

```bash
VITE_COMPANION_ADMIN_API_BASE_URL=http://127.0.0.1:3010 \
  pnpm --dir packages/companion-admin exec vite --host 127.0.0.1 --port 5174 --strictPort
```

访问 **http://127.0.0.1:5174**，用上面的 `COMPANION_ADMIN_TOKEN` 登录。新旧管理端分别使用不同的认证和配置。

### 4. 使用持久聊天

持久模式读取**数据库中的角色模型绑定**，仅设置 `COMPANION_CHAT_*` 不够。先按 [持久聊天配置步骤](docs/implementation/startup.md#persistent-local-chat) 完成：

1. 初始化本地 session profile，取得角色 ID。
2. 创建 `chat` 模型 profile，配置凭据引用及精确模型价格。
3. 在管理端测试模型，再启用，并绑定到该角色；测试会产生费用，失败会停用该 profile。
4. 发布角色人格，然后运行：

```bash
node packages/companion/dist/cli/chat.js \
  --persistent --session-file .local/companion-profile.json
```

启动聊天的终端也要导出数据库 URL、profile 引用的业务密钥及 `COMPANION_MODEL_PRICING_JSON`。复用同一 session 文件可延续本地身份与历史。

QQ、长期记忆和主动联系需要额外配置，默认关闭。接入方法见 [完整启动与运维说明](docs/implementation/startup.md)。

## 检查与更多说明

```bash
pnpm check                                  # 旧版类型检查和构建
pnpm --filter @oh-bot/companion typecheck
pnpm --filter @oh-bot/companion test          # 基础测试，非完整集成验收
```

完整离线检查使用 `bash .github/codex/check.sh`，需先准备隔离测试库及 PostgreSQL 17 客户端，见 [检查环境要求](docs/implementation/startup.md#acceptance)。

- [完成记录](docs/implementation/completion.md) · [55 场景验收映射](docs/implementation/acceptance-map.md)
- 真实模型、QQ 和完整跨存储恢复仍需实际验收；离线测试通过不代表这些能力已验收。
- 密钥、`.env`、`.local/`、聊天记录及 `data/` 运行数据请保留在本地，不要提交。
