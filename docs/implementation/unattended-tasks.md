# 无人值守任务清单（MVP 优先）

2026-10-23 调整为**先交付能用的聊天机器人，再继续完整平台**。控制器仍按首个未完成任务执行，固定测试、独立审查通过后才勾选并快进提交到 `feat/companion-v3`。失败保存重试分支，不覆盖人工提交。

M 系列每项必须交付可验证入口、对应测试与进度说明；不做占位接口、不假装外部 API/QQ 已接通。必须保留身份隔离、记忆 ACL、更正/遗忘和消息幂等。详见 `docs/implementation/mvp-delivery.md`。

## 已完成的基础能力（保留原证据）
- [x] F3b：worker/dispatcher执行租约、恢复、fencing、崩溃窗口修复；进度文档记录最终be87380实库验证和复审完成。
- [x] F4a：记忆读取与提示前ACL；进度文档记录dd622d1验证及复审完成。

## MVP：最先交付可使用功能
- [x] M1a：在 packages/companion 增加最小真实聊天 ModelGateway 和仅限本地开发的终端聊天入口，显式配置业务聊天 API URL、Key、模型，支持 OpenAI-compatible Chat Completions；无凭据明确失败、不输出密钥、不使用自动编码密钥；添加 HTTP fixture 测试与本地运行说明，不能声称 live 已通过。

  M1a 实现不得修改任何既有 `package.json` scripts（即使只是新增本地聊天快捷命令），控制器会拒绝此类改动；终端入口可通过现有 `pnpm exec tsx <入口文件>` 直接运行，并在本地运行说明中写清命令。
- [ ] M1b1：在 packages/companion 实现本地聊天会话/历史服务，入口使用可信 channel evidence 并复用 IdentityService 与 InboundService.accept 的事务；从已解析 person 和 conversation member 关系读取历史，不接受调用方传入 userId/personId 授权。用隔离 PG 覆盖两条 verified identity 的历史隔离、伪造 ActorContext/证据拒绝、重复 event 幂等；只做服务与测试，不接 CLI、不新增网络服务或 package.json scripts。
- [ ] M1b2：把 M1a 本地终端聊天接入 M1b1 会话服务和 M1a ModelGateway；每轮从 PostgreSQL 恢复可信会话历史并在事务中持久化用户/assistant 消息，重启后继续对话；无任意 userId 历史读取。隔离 PG 端到端覆盖重启恢复、重复消息、越权拒绝与多轮网关请求。更新可复现运行说明；不新增网络服务或 package.json scripts。

  M1b 实现提示：本阶段只提供本地终端入口。先复用 `InboundService.accept(characterId, event, evidence)`、`IdentityService`、`TurnService` 和 `createVerifiedChannelEvidence`；按 M1b1 → M1b2 顺序实现，历史授权从可信证据解析 person，并核对 private conversation membership。M1b2 才将服务接入 CLI 和 Gateway。
- [ ] M2a：在现有身份/关系表基础上实现稳定版本人格和按用户独立持久化关系状态，主伴侣身份仅可由可信绑定/管理操作指定，普通用户不可更改；提供本地聊天中的人格上下文与重启/多用户隔离测试。
- [ ] M2b：在本地聊天链路接入现有来源/更正/遗忘账本、ACL 记忆读取和 Mem0 异步写入，未核实候选不得召回，跨用户/群不可泄漏；更正或忘记立即不再入提示，外部 Embedding/Mem0 不可用时安全降级，增加隔离 PG/fixture 测试。
- [ ] M3a：以默认关闭的 NapCat/OneBot QQ 适配器接入已验证的聊天/身份/发信链路，配置缺失明确不可用；覆盖重复事件、可信身份映射、未知回执不重发、失败恢复的协议 fixture 和隔离 PG 测试，不自动连接真实 QQ。
- [ ] M3b：提供本地 MVP 启动与体验说明、真实聊天模型 smoke 命令及一条多轮对话端到端验证路径；执行现有构建/隔离测试，逐项记录 live 模型/QQ 未配置项；不假装已部署或已完成全量场景。

## 第二阶段：保留原完整计划（MVP 完成后继续）

下面旧任务**没有被判定完成**。旧进度文档的“F4b 记忆账本”与此处“F4b SDK 删除适配器”不是同一验收项，禁止因同名直接勾选；M 系列若已实现某项，先以代码和真实测试核验再更新。
- [ ] F4b：锁定Mem0版本并补精确历史删除适配器契约；先核实兼容性包当前能力，只通过公开扩展/显式补丁完成，不读SDK私有字段，不用reset删除其他用户；加入真SDK和隔离PG的范围删除、重启后历史删除回归测试。
- [ ] F4c：实现唯一MemoryGateway的候选/来源/修订账本和Mem0异步协调；第三人、假设、assistant内容不成为本人证据，candidate不召回，显式纠错立刻使旧修订失效；补齐实库与注入协议fixture测试。
- [ ] F4d：实现忘记/删除保护日志与索引重建、重提取、旧备份重放不复活；补中文短姓名/别名词项检索及Embedding失败降级测试；不得把本地fixture当真实提供商验收。
- [ ] F5a：实现LangChain ModelGateway和独立模型profiles、env凭据引用、超时/预算/取消；无配置明确不可用，不内置fake生产模型；HTTP fixture断言授权外信息不出请求。
- [ ] F5b：实现统一LangGraph身份/context/memory/route/compose/deliver/finalize与真实PG checkpoint，复用现有事务/outbox；中断恢复不重发，unknown回执保持；记忆写入留在后台唯一Mem0链路。
- [ ] F5c：实现默认关闭的NapCat/OneBot入站规范化、可信身份构建、发送与回执适配；协议fixture+真实PG覆盖重复消息/租约/发送后崩溃，不启动真实QQ、不发真实消息。
- [ ] F6a：实现版本核心人格和按人的独立关系事件/状态，显式主伴侣绑定；普通用户不能修改核心人格与主伴侣，管理员身份独立；晚回复/拒绝不扣关系，失败事件无随机增量，补确定性回归。
- [ ] F6b：实现ToolRegistry/AgentRegistry受控子图、父预算与取消继承；工具/搜索内容视作外部数据，统一人格出口，未配搜索明确不可用；复用旧天气/媒体客户端时不改旧运行路径。
- [ ] F6c：实现持久化提醒/约定与默认关闭的主动事项；安静时段、禁追发、失败回执与幂等覆盖；未持久化不承诺已提醒，不发送真实外部消息。
- [ ] F7a：创建独立companion-admin Vue3/Vite/Pinia/Element Plus包与共享Zod API客户端；实现认证、概览、角色和身份页面，类型/构建/交互测试，沙盒与真实身份隔离。
- [ ] F7b：补齐记忆来源/冲突/更正/删除、情绪关系、Agent运行、模型工具、主动事项、数据运维管理页面；错误/空态/未配置可见、不返回明文密钥，补必要API与交互回归。
- [ ] F8a：提供旧JSON原字节备份/hash清单及幂等迁移命令；仅用合成fixture验证，不读取或修改生产data；legacy好感不冒充信任、不编造历史。
- [ ] F8b：实现pg_dump/restic备份恢复命令及删除日志独立重放门禁；真隔离库验证恢复后不复活，未配远端只报告本地副本；命令放新版包，不覆盖旧docker/运行数据。
- [ ] F8c：在packages/companion/deploy提供API/worker/PG/持久卷Compose、构建定义、升级前备份及健康检查脚本，验证配置和构建；只产出可部署文件，不假设已有服务器凭据或宣布上线。
- [ ] F8d：将55个固定场景映射到确定性测试和live/人工评估清单，执行完整验证矩阵、更新验收证据，逐项区分通过/未配置/未实现；缺真实模型/QQ/部署凭据明确列出，不伪造整体完成。

完成本清单后自动停止模型调用。不得擅自扩张产品范围。新的用户需求需要明确加入任务。
