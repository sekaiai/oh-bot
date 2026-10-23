# 实施进度

设计：用户 oh-bot-companion-design-2026-10-21.md v3.1。
计划：docs/superpowers/plans/2026-10-22-companion-compatibility.md。
基线：dev 3d849ad；本地分支 feat/companion-v3。
GitHub同步：用户已明确授权持续推送全部源码修改；`feat/companion-v3`已建立远端追踪，首次同步至75579ea。后续修复继续推送该分支，不自动合并dev或部署。
执行分工：主控集成验收，Luna 编码测试；主控实际精确模型型号未获运行时证实。

## 已确认
- 网络需允许终端访问；权限更新后 clone 成功。
- Node 24.19.0、pnpm 11.25.0、Docker 28.4.0 可用。
- 没有第三方模型凭据绑定，不注册服务或创建密钥。
- 原附件临时路径在环境恢复后消失，已读取内容归纳为实施约束摘要，不声称保存了原文。

## 前置检查
| 范围 | 生产/消费接口 | 结果 |
| --- | --- | --- |
| 任务1自身 | 配置与测试一致 | 缺失必须明确失败；不默认内存/临时历史 |
| 任务2自身 | 真实 SDK + HTTP fixture | fixture 与 live 标签分离 |
| 任务3自身 | 报告与退出结果 | 不能以协议测试冒充真实提供商验证 |
| 任务1→2 | CompatibilityConfig | 先锁定真实 SDK 后落实字段 |
| 任务2→3 | 各项结果 | live 未配置则门禁未完全通过 |

## 待完成
- [x] SDK 能力调查与兼容性包
- [x] 真实数据库、history、checkpoint、SDK显式纠正删除与重启测试（不是全链路忘记）
- [ ] 真实第三方 API 验证（缺配置）
- [ ] 设计阶段2—7：数据迁移、身份、权限、队列、备份、QQ、完整记忆、人际关系、工具/Agent、管理端、50个场景。

## 基线验证 2026-10-22
- 命令：`CI=true pnpm --config.store-dir=/workspace/.pnpm-store --config.cache-dir=/workspace/.pnpm-cache --config.state-dir=/workspace/.pnpm-state run codex:check`。
- `tsc --noEmit`、后端 tsup、管理端 Vite 构建通过。
- doctor 进程退出0，但明确报告缺少 NAPCAT_WS_URL、AI_BASE_URL、AI_MODEL；不把退出0解释为运行环境完备。
- pnpm 11 自动依赖校验使用的 store 必须与 node_modules/.modules.yaml 一致；本机显式配置 /workspace/.pnpm-store，未将绝对机器路径写入项目配置。

## 提供方选择更新
用户暂定 DeepSeek 聊天/提取、阿里百炼 Embedding；尚无具体模型、地域/业务空间或key。官方兼容接口与当前型号已核对，见 model-providers.md。不默认旧型号或测试维度，不把文档兼容等同真实API验证。

## 阶段1本地验证进度
- 兼容性包已锁定成熟SDK版本；无依赖发布年龄例外，旧根包直接依赖版本保留。
- 配置/隔离库 unit10通过；Mem0真实PG+SQLite integration4通过（含错误事实、非测试库入口和secret错误回归）；已独立review并修复2项Important。
- 主控保留数据库卷重启后，只读恢复既存memoryId和history成功；不是备份导出恢复证明。
- LangGraph真实PG checkpoint中断恢复与统一CLI已完成并经主控复验。
- 55个完整首版固定场景已列为验收要求，并非55项已通过。

## 本地持久化门禁最终结果
主控在9e7a39b最终代码重跑：typecheck、14/14单测、6/6集成，0 skipped。保留卷docker重启后新CLI --verify三项只读恢复检查通过。全部代码独立review发现的问题均已修复；真实API仍未配置。下一步按foundation plan实现业务schema与身份基础，不切换旧运行路径。

## 当前执行
业务基础F1a已完成并通过独立复审与主控实库验证。当前测试库为oh_bot_core_v2_compat；早期oh_bot_core_compat保留作诊断，不用于宣称升级成功。
F1b记忆、模型、任务和运维表已完成。复审发现的memory revision正数约束已通过新增0003迁移修复，旧迁移未改写；a937925经独立复审通过，主控重新运行typecheck/build/unit5项/integration1项全部通过（0 skipped）。接下来实现身份绑定及披露策略；完整产品和真实提供商验收尚未完成。
身份绑定与披露策略F2a已实现并完成两轮修复复审（614b4b7）：双端验证、同昵称隔离、历史身份保留、主伴侣与管理权限分离、私聊/群聊/圈子范围、未确认参与者拒绝和撤权复核。复审无剩余Critical/Important；下一步是入站消息事务、租约及发信回执状态机。尚未接入真实QQ，也未完成真实模型验收。
消息事务与发信状态机F2b已完成（6917783），独立复审无剩余Critical/Important；主控重新运行typecheck/build/unit7项/integration9项全部通过，0 skipped。包括真实锁等待过期、身份绑定后消息重投、JSON幂等、名单时间屏障及回执未知不自动重发。下一步实现独立Nest/Fastify管理API、认证与pg-boss worker；仍不切换旧运行路径。
管理API与认证F3a已完成（d4c01a9），独立复审无Critical/Important；主控重跑typecheck/build/unit11项/integration11项/health1项/startup2项全部通过，0 skipped。覆盖编码路径认证绕过回归、CORS、数据库审计回滚/CAS及缺表未就绪。4项Minor随下一步worker/API扩展处理；队列、完整记忆和真实通道尚未接入。
worker/outbox F3b已实现并推送（75579ea）；主控重新运行typecheck/build/unit12项/integration16项/health1项/startup3项全部通过，0 skipped。但独立复审发现5项恢复与资源清理问题，正在修复，尚未通过本阶段验收。缺处理器后的恢复、执行租约、锁等待过期和崩溃窗口将补针对性测试；不据现有测试通过宣称生产可用。
F3b修复A-D完成并推送（最终提交be87380）：管理恢复/status过滤/readiness一致性/独立worker队列、attempt lease fencing、生命周期资源归属和锁等待安全，以及重启/耗尽/发送后finalize崩溃/receipt_unknown恢复均通过真实PG验证。独立复审最终无Critical/Important/Minor；最终矩阵typecheck、build、unit14/14、顺序integration25/25、health1/1、startup4/4全部通过，0 skipped。API/worker仍未配置真实模型或QQ发送器；这只代表F3阶段完成，不代表F4-F8或真实第三方验收完成。
F4a记忆读取与提示前ACL已完成并独立复审通过（dd622d1）：只返回当前validated revision、active/direct/user source，按当前可信身份、会话、圈名单/策略及披露规则过滤；授权查询与读取同处REPEATABLE READ事务，并锁定当前与来源群权限依赖。真实PG覆盖私聊/群隔离、未确认名单、各类不可读来源/状态、规则拒绝和跨会话撤权并发。主控最终 typecheck/build、unit14/14、顺序integration28/28全部通过，0 skipped。该阶段没有接入Mem0写入或live API；候选提取、修订/更正、忘记及删除/备份重放不复活仍未实现。
F4b记忆来源、更正与遗忘账本已完成并通过独立复审PASS：管理员审批绑定可信Guard principal、source原文精确引文及与候选事实一致的人工审核内容；需要明确第一人称陈述且没有常见假设/转述/虚构措辞，歧义来源默认拒绝，更正事实须与原始用户消息对应；无效审批返回客户端错误；forget覆盖完整修订链与所有engine ID，空修订链按source独立幂等，事务回滚有真实PG注入测试。主控最终 typecheck/build、unit14/14、顺序integration29/29、health1/1、startup4/4全部通过，0 skipped。措辞分类是保守规则，不能代替后续提取审核；Mem0写入/删除worker仍未完成，F4c及F5-F8仍待实现。
本地兼容性阶段最终独立review无Critical/Important；低优先级限制：同目录并发运行probe可能覆盖manifest，当前须串行或使用不同state目录。

## 2026-10-23：MVP 交付优先级调整

用户要求提高交付效率。现有 F1-F4 基础保留，优先执行 `docs/implementation/unattended-tasks.md` 中的 M1a→M3b，先交付本地可对话、可信多轮历史、稳定人格与多用户关系、记忆、可选 QQ 接入和体验验证；完成后继续原 F 系列未完成任务。不得将已验证的“自动编码 API 连通性”当作“机器人业务聊天 API 可用”。

原自动任务 F4b 指 SDK 历史删除适配器，和本进度文档已完成的 F4b 来源/更正/遗忘账本不同；二者不是同一个验收项，原 F4b 未经 SDK 验证不得勾选。

此次只调整任务优先级和验收路线，**没有声称 M1a-M3b 已实现或通过真实模型/QQ 测试**。自动执行结果以后续 GitHub Actions 和本文件新增证据为准。

## M1a：最小真实聊天 ModelGateway 与本地终端聊天（本轮实现，待控制器验证）

代码于本轮编写，未由本代理运行任何测试；实际测试/审查结果由受信控制器记录。任务复选框仍保持未勾选。

交付入口：
- `packages/companion/src/models/chat-gateway.ts`：`ModelGateway` 接口、`OpenAiCompatibleChatGateway`、`loadChatProviderConfig`、`createChatGatewayFromEnv`、`ModelGatewayError`。仅读取显式业务聊天变量 `COMPANION_CHAT_API_URL`、`COMPANION_CHAT_API_KEY`、`COMPANION_CHAT_MODEL`；缺失/空/占位值报 `model_not_configured`，非 HTTP(S)、含 URL 凭据、含 query/hash 或返回 3xx 重定向报 `model_invalid_config`；不回退到 `DEEPSEEK_API_KEY`/`AI_BASE_URL`/`AI_MODEL` 等自动编码凭据。请求体只含显式 messages（及可选 temperature/max_tokens），响应/错误不输出密钥，返回稳定错误码。请求使用 `redirect: 'manual'`，3xx 作为普通响应返回后分类为 `model_invalid_config`，不会跟随到 location 目标（此前 `redirect: 'error'` 会在 fetch 层抛 `TypeError` 被误归类为 `model_unreachable`，本轮已修正使实现与测试一致）。
- `packages/companion/src/cli/chat.ts`：仅限本地开发的终端聊天入口，从 `src/cli/chat.ts` 通过现有 `pnpm exec tsx` 运行；进程内保存多轮历史，支持 `--system/--max-turns/--temperature/--verbose`；未配置时以 `error: model_not_configured` 退出且不访问提供方。用户能获得真实模型回答的前提是显式配置 `COMPANION_CHAT_*`，本轮环境无凭据。
- `packages/companion/src/index.ts` 与 `src/models/index.ts` 导出网关；`tsup.config.ts` 增加 CLI 构建入口（未改动任何 `package.json` scripts）。
- 业务聊天凭据变量与自动编码凭据完全分离；`COMPANION_CHAT_*` 缺失时不读取 `AI_*`/`DEEPSEEK_API_KEY`，保证 GitHub Actions 的自动编码密钥不会被业务聊天复用。
- 测试：`test/chat-fixture.ts`（本地 `node:http` 协议 fixture）、`test/chat-endpoint.test.ts`（端点拼接与非法 URL）、`test/chat-gateway.test.ts`（缺失/占位配置失败、无自动编码凭据回退、显式 `/chat/completions` 与 base URL 拼接、请求体/authorization 断言、401/403/429/5xx/超时/不可达/非法响应/空内容/重定向不跟随分类、密钥不外泄）、`test/chat-cli.test.ts`（未配置明确失败、不借用编码密钥、多轮历史随请求重放、`--max-turns`、提供方错误不泄露密钥、参数及 `--help` 校验）。
- 本地运行说明已写入 `packages/companion/README.md`（含导出变量、`pnpm exec tsx packages/companion/src/cli/chat.ts` 命令与限制）。
- M1a 测试命令（由控制器执行，不新增脚本）：`cd packages/companion && pnpm exec tsx --test test/chat-endpoint.test.ts test/chat-gateway.test.ts test/chat-cli.test.ts`；`typecheck`/`build` 覆盖 `src/cli/chat.ts` 与网关。

明确未验证/未包含：
- 未配置真实业务聊天凭据，**未执行 live 模型验收**；fixture 通过不等同 live API 通过。
- 未持久化历史、未接入身份/ACL/Mem0/LangGraph、无流式与重试；这些属于 M1b 及后续任务。
- 不修改既有 `package.json` scripts；根 `pnpm codex:check` 不覆盖 companion 包，M1a 测试需按上述文件路径单独执行。

## 主分支同步验证（2026-10-23）

- 从历史重试分支整合 M1b1 `LocalChatSessionService`、可信私聊历史读取、私聊成员校验及 Worker 信号退出修复，保留主分支已有的 M1a 模型网关和终端聊天实现。
- 在专用 PostgreSQL 测试数据库上执行 `.github/codex/check.sh`：构建、类型检查、基础测试、29 项集成测试、健康检查、启动检查，以及自动发现的 71 项 Companion 测试全部通过；根目录 `codex:check` 通过。
- M1b1 新增 3 项 PostgreSQL 测试覆盖身份隔离、多轮历史、伪造证据拒绝、重复事件幂等和重放冲突。
- 不导入旧分支的聊天记录、运行数据或凭据；不恢复已暂停的自动编码工作流。CLI/模型历史接线和真实 QQ/模型验收仍未完成。

## M1b2：持久化本地终端聊天（实现与 fixture 验证，待控制器验收）

- `LocalChatService` 在可信 evidence 校验后先取得 PostgreSQL session try-lock，再接受入站消息；忙碌时不会写入额外用户消息。它使用 `LocalChatSessionService` 授权/恢复历史、`TurnService` claim/persist/fail 围栏；只在回复事务提交后向终端返回内容。已完成 event replay 返回已存回复，失败回复保留失败 turn，不创建 assistant。
- `--persistent` 显式启用数据库模式，要求 `COMPANION_DATABASE_URL` 和手动迁移；不配置时原有内存 CLI 保持可用。`--session-file` profile 严格使用 `local-cli:` 合成 identity、随机 character/user/channel 标识、专用 0600 文件；它属于当前 OS 账户的本地沙盒，不表示 QQ 登录或远端身份核验。
- LocalChatService 不处理 outbox 发送；合成会话照常写入 pending delivery，但此 CLI 不启动 worker 或 QQ sender，不把终端输出当作 QQ 回执。
- 已添加 PG 集成/child-process fixture：已覆盖回复持久化和 fresh-process 恢复、重复 event 不重复生成、忙碌并发在 acceptance 前失败、不同本地 profile 历史隔离、伪造与不匹配 evidence 的 provider 零调用、provider 失败后的锁释放、profile 重启/权限/篡改拒绝、等时间戳 200 条消息边界及 system prompt 限额。fixture 不代表真实模型 API 或 QQ 验收。
- 目标测试（`source /workspace/oh-bot-setup/env.sh && pnpm --dir packages/companion exec tsx --test --test-concurrency=1 test/chat-endpoint.test.ts test/chat-gateway.test.ts test/chat-cli.test.ts test/chat-session.integration.test.ts test/local-profile.test.ts test/local-chat.integration.test.ts test/local-chat-cli.integration.test.ts`）最终 31/31 通过、0 skipped；M1b2 integration child/profile/service 子集另 10/10 通过。`pnpm --dir packages/companion typecheck`、`pnpm --dir packages/companion build` 通过。
- `.github/codex/check.sh` 复跑通过，完整自动发现矩阵 78/78、0 skipped；Companion/compatibility 单测各 14/14，顺序 PG 集成 29/29，health 1/1，startup 4/4，根包 typecheck/build/admin build 通过，最终退出码 0。第一次矩阵运行中既有 lock-wait 测试暴露了预期拒绝在断言安装前短暂未处理；单测隔离重跑通过后，仅在测试 helper 上立即附加 rejection observer（仍保留原始 `assert.rejects`），再跑全矩阵通过。完整日志保存在 `/workspace/oh-bot-work/m1b2/full-check.log`。
- M1b2 复选框保持未勾选，等待控制器审查与最终验收。
