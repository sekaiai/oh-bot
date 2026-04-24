# oh-bot

基于 NapCat WebSocket 的轻量 QQ Bot 中间层，当前已接入：

- NapCat / OneBot 消息接收与发送
- 会话上下文与回复决策
- 基于和风天气的天气工具路由
- 图文、图片、语音、视频的统一发送接口

## 环境要求

- Node.js `>= 20`
- 一个可连接的 NapCat WebSocket 服务
- 一个可用的 OpenAI 兼容接口
- 如果要启用天气能力，需要和风天气 API Key

## 安装与启动

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm start
```

如果同时在做后端和管理端开发，常用命令是：

```bash
pnpm dev:bot
pnpm dev:admin
pnpm check
pnpm codex:doctor
```

其中 `pnpm check` 会统一执行：

- TypeScript 类型检查
- 后端构建
- 管理端构建

`pnpm codex:doctor` 会额外检查：

- 环境变量是否完整
- 管理端是否启用
- 媒体发送模式和临时目录配置是否匹配
- `data/plugins/*.json` 是否存在明显缺项

如果你希望一次跑完构建和诊断，可以直接执行：

```bash
pnpm codex:check
```

仓库根目录也新增了 [AGENTS.md](./AGENTS.md)，里面整理了当前项目的入口文件、运行期数据说明和对 Codex 更友好的开发约定。

## 环境变量

主 AI 仍然固定读取 `.env`。
插件配置会单独保存到 `data/plugins/*.json`，旧的 `data/runtime-settings.json` 仅作为兼容迁移来源。

参考 [.env.example](./.env.example)：

```env
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_ACCESS_TOKEN=

AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=gpt-4o-mini
AI_TIMEOUT_MS=30000

QWEATHER_API_HOST=https://devapi.qweather.com
QWEATHER_API_KEY=
QWEATHER_LANG=zh

MAX_CONTEXT_MESSAGES=20
LOG_LEVEL=info

ADMIN_PASSWORD=change_me
ADMIN_PORT=3100
ADMIN_WEB_ORIGIN=http://127.0.0.1:5173
ADMIN_SESSION_TTL_SECONDS=43200
```

如果没配置和风 Key，机器人命中天气类请求时会直接返回配置缺失提示，而不是伪造天气结果。

## 插件配置

管理端新增了“插件配置”页面。

当前内置三个插件：

- `ds2api`：默认执行层，主 AI 会按意图把普通问答、复杂分析、代码问题分发到不同模型路由
- `qweather`：处理天气、空气质量、预警、日出日落等请求
- `qingmeng`：处理图片、视频、语音、新闻、图片分析等外部接口能力

每个插件：

- 独立展示
- 独立保存
- 独立落盘到 `data/plugins/<plugin-id>.json`

例如 `ds2api` 插件的典型配置：

- `baseUrl`: `http://127.0.0.1:6011/v1`
- `routes[0]`: 日常对话 -> `gpt-4o`
- `routes[1]`: 复杂分析 -> `o3`
- `routes[2]`: 代码技术 -> `gpt-5-codex`

当前流程是主 AI 先统一判断应该交给哪个插件；如果不是天气或外部接口类能力，就默认进入 `ds2api`，再从路由表里选择合适模型。

## 天气能力

当前内置的是自建 `Tool Router` 方案，不依赖模型原生函数调用。

处理流程：

1. `ReplyEngine` 先判断这条消息是否应该回复
2. 主 AI 判断消息应该路由到哪个插件
3. 当路由目标是 `qweather` 时，`ToolRouter` 调用和风 GeoAPI 做地点解析
4. 再聚合查询：
   - 实时天气
   - 天气预警
   - 天气指数
   - 空气质量
   - 日出日落
5. 最后把工具结果交给模型组织成自然语言回复

当前支持的典型提问：

- `北京天气`
- `上海空气质量`
- `深圳今天有预警吗`
- `杭州紫外线指数`
- `苏州日出时间`

如果用户没有给地点，机器人会先追问城市或地区。

## 富媒体发送

发送层位于 [src/adapters/napcat/sender.ts](./src/adapters/napcat/sender.ts)。

现在有两种调用风格：

- 继续使用 `sendText()` 发送纯文本
- 使用 `sendMessage()` / `sendRichMessage()` 发送消息段数组

### 1. 纯文本

```ts
await sender.sendText({
  chatType: 'group',
  groupId: '123456',
  message: '你好'
});
```

### 2. 图文消息

图文消息本质上是一条消息里组合多个消息段：

```ts
await sender.sendRichMessage({
  chatType: 'group',
  groupId: '123456',
  message: [
    { type: 'text', data: { text: '今天天气如下：\n' } },
    { type: 'image', data: { file: 'https://example.com/weather.png' } },
    { type: 'text', data: { text: '\n出门记得带伞。' } }
  ]
});
```

### 3. 图片

```ts
await sender.sendImage({
  chatType: 'group',
  groupId: '123456',
  file: 'https://example.com/a.jpg'
});
```

### 4. 语音

```ts
await sender.sendRecord({
  chatType: 'private',
  userId: '10001',
  file: 'https://example.com/a.mp3'
});
```

说明：

- 这里底层发送的是 `record` 消息段
- 这是 OneBot 语义里更常见的语音段类型

### 5. 视频

```ts
await sender.sendVideo({
  chatType: 'group',
  groupId: '123456',
  file: 'https://example.com/a.mp4'
});
```

### 6. 通用发送接口

如果你希望自己控制消息段，可以直接调用通用接口：

```ts
await sender.sendMessage({
  chatType: 'group',
  groupId: '123456',
  message: [
    { type: 'text', data: { text: '请看附件：' } },
    { type: 'image', data: { file: 'https://example.com/demo.jpg' } }
  ]
});
```

## 代码入口

- 启动入口：[src/index.ts](./src/index.ts)
- 回复编排：[src/services/reply-engine.ts](./src/services/reply-engine.ts)
- AI 调用：[src/services/ai-client.ts](./src/services/ai-client.ts)
- 天气工具路由：[src/services/tool-router.ts](./src/services/tool-router.ts)
- 和风天气客户端：[src/services/qweather-client.ts](./src/services/qweather-client.ts)
- NapCat 发送层：[src/adapters/napcat/sender.ts](./src/adapters/napcat/sender.ts)

## 注意事项

- 富媒体的 `file` 当前直接透传给 NapCat，具体支持 URL、本地路径还是其他格式，取决于 NapCat 的实际能力
- 现在的地点提取是轻量规则版，适合常见问法；复杂地名歧义场景后续可以再做候选地点澄清
- 当前天气工具是单一内置工具，后续如果要扩成搜索、地图、新闻，建议继续沿用 `ToolRouter` 结构


## 管理端（Vue3 + TS + Pinia）

项目新增了一个独立管理端（不依赖 UI 组件库），用于：

未配置 `ADMIN_PASSWORD` 时，机器人主服务仍可启动，但管理端 API 不会监听端口。

- 单密码登录（`ADMIN_PASSWORD`）
- 运行概览查看
- 插件配置（DS2API / 和风天气）
- `rules.json` 可视化编辑
- `personas.json` 可视化编辑
- `sessions.json` 会话查询

### 启动后端（含管理 API）

```bash
pnpm dev
```

默认管理 API 地址：`http://127.0.0.1:3100`。

### 启动管理端前端

```bash
pnpm admin:dev
```

默认地址：`http://127.0.0.1:5173`。

### 构建管理端前端

```bash
pnpm admin:build
```

如需改 API 地址，可在管理端环境变量中配置：

```env
VITE_ADMIN_API_BASE_URL=http://127.0.0.1:3100
```

生产部署如果通过 `docker/docker-compose.yml` 的 `admin-web` 访问管理端，前端默认使用同域 `/admin/*` API，不需要设置 `VITE_ADMIN_API_BASE_URL`。

## Docker Compose 部署

统一部署文件位于 `docker/docker-compose.yml`，包含 NapCat、DS2API、机器人后端、管理端静态服务。

部署前在本地或 CI 构建产物：

```bash
pnpm build
pnpm admin:build
```

服务器只需要运行打包后的目录，不在服务器上构建：

- `dist/`：机器人后端 bundle
- `admin/dist/`：管理端静态文件
- `data/`：运行数据，作为持久化目录保留
- `docker/`：Compose、NapCat、DS2API 配置

启动：

```bash
cd docker
docker compose up -d
```

管理端默认暴露在 `http://服务器:8080`，可通过 `ADMIN_WEB_HOST_PORT` 调整。

在 Docker 网络内，DS2API 插件地址建议配置为：

```text
http://ds2api:5001/v1
```

### DS2API 自动更新

默认推荐固定 `DS2API_IMAGE=ghcr.io/cjackhwang/ds2api:v3.6.1`，由 Renovate 自动提交升级 PR，合并后再部署。

如果要让服务器无人值守自动拉取 DS2API 新镜像，可以把 `docker/.env` 中的 `DS2API_IMAGE` 改为：

```env
DS2API_IMAGE=ghcr.io/cjackhwang/ds2api:latest
```

然后启用 Watchtower profile：

```bash
cd docker
docker compose --profile auto-update up -d
```

这个模式会自动更新带有 Watchtower 标签的 `ds2api` 容器；更省心，但版本变化不可通过 PR 预审。
