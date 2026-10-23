# 长期陪伴系统业务基础 Implementation Plan

**Goal:** 在保留旧运行路径的前提下实现新版模块化服务、来源和身份边界，再接入对话、记忆和管理端。
**Spec:** 用户v3.1完整设计（约束摘要 `../specs/2026-10-22-companion-execution-brief.md`）。
**Architecture:** `packages/companion` 为 NestJS/Fastify 模块化单体，API与worker两个入口；Drizzle业务schema `companion`、独立第三方schema/表、统一LangGraph。`packages/companion-admin` 为Vue3管理端。旧 `src/admin/data/docker` 在验收前原样保留。

## 全局约束

- Node24、TypeScript strict、pnpm；不得新增第二套自动提取、第二套编排、Redis、向量服务或AstrBot。
- 真实模型API缺配置时明确不可用；本地模型fixture只能存在test目录，通过依赖注入用于测试。
- 所有入站由经过验证的通道构建身份，不采信消息中的personId/权限/主伴侣声明；先过滤允许范围再向模型发送。
- business SQL使用Drizzle管理；不写第三方私有表。确需扩展SDK时显式锁定版本、补丁、适配器契约和回归。
- 默认不启动QQ连接、不主动发消息、不修改旧运行数据、不部署。仅在合成测试库中运行迁移/恢复。用户于2026-10-22明确要求所有修改推送GitHub，主控持续同步`feat/companion-v3`；不强推、不自动合并dev，子代理只本地提交。
- 中文commit，保持原根依赖锁定。测试不能把fixture成功当live质量验收。
- 实施可独立验证部分不依赖用户交出密钥；实际API和生产切换持续保持门禁。

## 文件与接口边界

- `src/domain/contracts.ts`：Zod共享可见范围、通道事件、可信服务端上下文、工具结果、模型角色接口；不依赖Nest或数据库。
- `src/database/schema/{identity,timeline,memory,operations}.ts`：业务数据，FK/unique/version/timestamptz；Drizzle迁移在`drizzle/`。
- `src/database/database.ts`：有界Pool和Drizzle；`migrate.ts`独立入口；启动服务不静默重建损坏数据。
- `src/identity/*`：经验证的平台身份、一次性绑定挑战、显式主伴侣、圈子关系；权限与关系独立。
- `src/conversations/*`：入站去重+原文+turn+outbox同事务，租约和版本；不持事务等待模型。
- `src/memory/*`：唯一Mem0入口，候选/来源/范围/修订/删除、可重建索引；不是另一套自主提取引擎。
- `src/models/*`：LangChain model adapters、独立profiles/env凭据引用、预算超时；无默认fake模型。
- `src/graph/*`：identity/context/memory/route/tool/compose/deliver/finalize统一图和PGcheckpoint。
- `src/channels/napcat/*`：OneBot规范化、验证连接、回执状态；共享通道接口预留微信钉钉，不冒充已接入。
- `src/tools/*`, `src/agents/*`：结构化工具/子图与预算取消；唯一角色出口，外部动作单独回执。
- `src/relationships/*`, `src/persona/*`：可解释事件、版本核心人格、多用户局部状态、明确伴侣绑定。
- `src/jobs/*`：pg-boss+业务outbox分发，至少一次+业务幂等、失败/回执未知；无第二推理循环。
- `src/admin/*`, `src/app.module.ts`, `src/main.ts`, `src/worker.ts`：认证管理API、健康、两个进程入口。
- `src/operations/*`, `scripts/*`：备份/删除日志重放/旧数据迁移/导出，默认不触碰真实源目录。

## 执行任务

### F1 数据契约、Drizzle schema与真实迁移
- [x] 创建独立包，固定满足发布时间策略的依赖；旧根importer版本保持。
- [x] 先写真实PG测试：迁移可重复；身份唯一/关系和消息外键；一角色仅一个显式主伴侣；原始消息event唯一；版本字段和UTC时间；删除记录不随来源级联消失。
- [x] 实现领域契约、四类schema与迁移入口。所有表业务schema `companion`，SDK私有表不进ORM。
- [x] 完成真实隔离库迁移/typecheck/tests/review，中文commit。

### F2 身份、范围、入站事务与租约
- [x] 先写：同昵称不合并；挑战绑定一次性/过期/跨人拒绝；主要关系仅管理员可设；私聊/伴侣/群/圈子范围；消息重投恰好一条turn/outbox；失败回滚；租约过期恢复/版本冲突。
- [x] 实现服务端ActorContext、IdentityService、DisclosurePolicy、ConversationService。范围需结合场合/在场者，不是仅过滤当前发言人userId。
- [x] 通过真实PG事务和并发断言后review/commit。

### F3 Nest/Fastify、配置、认证管理API与可靠worker
- [x] 先写：缺DB明确失败；无admin token拒绝；公开health不露秘密；管理权限不等于主伴侣关系；outbox重复投递幂等；pg-boss重启恢复；失败job可查看/重试。
- [x] 实现API/worker两个入口、env引用profiles与队列dispatcher、管理基础CRUD。未配模型/通道显示不可用，服务不启动第二套回复路径。
- [x] Fastify inject+真PG/pg-boss验证；不连接真实QQ；review/commit。

### F4 Mem0历史扩展、MemoryGateway与完整来源/纠正/忘记
- [ ] 公开SDK不支持精确历史删除的问题必须先通过锁版本适配器契约解决；不能访问private字段或用reset清除其他用户。
- [ ] 先写：所有提示装配前ACL；第三人/假设/assistant内容不是本人证据；候选不召回；显式纠错立即失效旧版本；删除后重提取/重建/旧备份重放不复活；Embedding失败词项降级。
- [ ] 实现唯一Mem0接入、业务事实修订与来源账本、异步至少一次协调、保护删除日志。Chinese短姓名/别名/缩写使用实体与词项补足。
- [ ] 真Mem0/PG或版本扩展的真实集成，未配live仍不假绿；review/commit。

### F5 模型、QQ与LangGraph统一对话
- [ ] 先写：一角色多对象相同核心prompt；身份来自通道验证；重复消息/回复重试；checkpoint恢复不重发；回执未知保留；模型错误不伪造回复；未授权数据不出现在HTTP fixture请求。
- [ ] 接入ModelGateway与LangChain、实际PG checkpoint、NapCat规范化/发送回执；默认QQ禁用。记忆写入后台，不在图内另建提取器。
- [ ] 协议fixture+真DB端到端验证；review/commit。

### F6 人格、关系、工具、Agent与主动事项
- [ ] 先写：普通用户不改核心/主伴侣；晚回复拒绝不扣关系；事件失败无随机增量；Agent父预算/取消继承；来源注入不改权限；工具输出只经统一角色；未配搜索不编来源；提醒未持久化不承诺；主动默认关闭/安静时段/不追发。
- [ ] 角色版本和证据事件、ToolRegistry/AgentRegistry及受控子图、旧天气/媒体客户端按质量复用、提醒与约定持久化；搜索真实能力未配则禁用。
- [ ] 测试/review/commit。

### F7 Vue统一管理端
- [ ] 在独立companion-admin包使用Vue3/Vite/Pinia/Element Plus，通过共享Zod契约消费新API。
- [ ] 页面覆盖概览、角色、身份、记忆来源/冲突/更正/删除、情绪关系、Agent运行、模型工具、主动事项、数据运维；沙盒与真实身份隔离。
- [ ] API认证/无密钥明文/错误空态/缺配置可见、类型构建与必要交互测试；review/commit。

### F8 迁移、备份恢复、部署文件与验收
- [ ] 旧JSON先按原字节备份并出hash清单；幂等导入，legacy好感不冒充信任，不恢复不存在的历史。只操作合成fixture，真实迁移另有明确命令。
- [ ] pg_dump+restic策略按设计保存；完整数据库/媒体/SDK状态，保护删除日志独立；隔离恢复先重放删除日志再开放服务。目标未配显示本机副本，未演练不报成功。
- [ ] 提供API/worker/PG/持久卷的Compose和升级前备份命令，不启动实际部署。
- [ ] 将55个固定场景映射到可执行确定性测试和需要live/人工的对话评估；逐项报告通过/未配置/未实现，不能用fixture话术代替人格质量。
- [ ] 全新目录迁移/恢复、全部build/typecheck/tests，最终独立review后保留本地分支，实际外部API/部署由真实条件门禁。

## 自查结论
所有原设计模块均有任务承接；Mem0全忘记为显式版本扩展前置风险，不用假定公开API支持。无实际部署或源删除。任务间以领域契约、schema和服务签名交接；下游brief必须读上游报告固定接口，遇到真实SDK差异及时记录，不能写占位成功。
