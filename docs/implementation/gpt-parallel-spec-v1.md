# GPT 编写的 oh-bot 并行开发 Spec v1.0

**冻结日期：2026-10-23** · 基线：`feat/companion-v3` · 目标：先交付可用聊天 MVP，三个隔离工作流并行编码，集成串行验收。本文是开发契约而非“已实现”证明。

## 1. 系统目标与已知基线

oh-bot 是**一个稳定人格的虚拟陪伴者**：对所有人保持同一个核心人格，但与每个人有独立的关系、记忆、互动历史；主伴侣是经可信绑定的特殊关系，其他人不能通过输入文本或自报 ID 冒充。

当前已有 `packages/companion/src/models/chat-gateway.ts` 的 OpenAI-compatible Chat Completions 网关及 `src/cli/chat.ts` 本地终端入口（M1a）；现有 PostgreSQL `companion` schema 包含 `characters/character_versions/primary_relationship_bindings/relationship_states/emotion_states/conversations/conversation_members/messages/turns`；已有 `IdentityService`、`InboundService.accept`、`TurnService`、worker 与内存 ACL。**M1b1 仍在开发中，不可当作完成。**

禁止在此阶段重写已有身份/事务/队列框架、重做管理后台或在未验证身份时对外暴露聊天 HTTP API。

## 2. 三条并行编码线（可独立开发）

| Lane | 任务与交付 | 文件所有权（独占写入） | 不可依赖的尚未完成能力 |
| --- | --- | --- | --- |
| **A / history** | 继续现有 M1b1：可信 evidence → 身份解析 → 私聊成员授权 → PG 历史与幂等；再由原流水线完成 M1b2 CLI 集成 | `src/chat/**`、`src/transactions/inbound-service.ts` 及其历史测试；`src/cli/chat.ts` 仅 M1b2 | B/C 不得修改这些文件 |
| **B / persona** | P1：在现有表上实现稳定版本人格读取、管理员更新、按人独立关系状态读取/事件更新；只提供可调用服务与测试 | `packages/companion/src/persona/**`、`packages/companion/test/persona-*.test.ts` | 不依赖 CLI、LangGraph、QQ、Mem0 |
| **C / onebot** | Q1：实现默认关闭的 OneBot v11/NapCat **协议适配器**：严格入站规范化、注入式可信通道验证、出站格式化/回执分类、幂等键生成；协议 fixture 测试 | `packages/companion/src/channels/onebot/**`、`packages/companion/test/onebot-*.test.ts` | 不依赖真实 QQ 登录、M1b1、模型、PG |

B/C **不得**编辑 `package.json`、`pnpm-lock.yaml`、`src/database/schema/**`、`src/identity/**`、`src/transactions/**`、`src/cli/**`、`src/models/**`、`docs/implementation/progress.md`、`.github/**`、`AGENTS.md`。如需共享接口，写在自己 lane 下的模块导出并在 PR 中说明；跨 lane 改动留给集成阶段。禁止更改/删除/弱化已有测试。单 lane 只允许新增/修改自身目录及自身测试。

### Lane B：具体契约

- `PersonaService` 构造函数接收既有 `Database`；只信任服务端已验证 `ActorContext` 或 `Principal`，不接受请求正文中的 `personId` 决定关系归属。
- `getPersona(characterId, principal)` 返回冻结的核心人格版本及当前用户**自己的**关系摘要；无人格版本则显式 `persona_not_configured`，不能偷偷生成默认伴侣关系。
- `updateCore(characterId, core, principal)` 仅允许 `Principal.kind==='admin'`，写入新的 `characterVersions`（revision 单调）并更新 `characters.currentVersionId`，审计修改。普通用户不允许写核心人格或主伴侣绑定。
- `recordInteraction(..., trustedActor, eventKey)` 按 `(characterId, canonical personId)` 更新已有 `relationshipStates`，同一 `eventKey` 重放不重复累计；不以迟回、拒绝、失败发送自动扣信任；范围限制 0–1。优先复用 `interactionEvents`，不要发明新表。
- 角色人格文本应是服务端**数据**，不能从聊天消息里直接提升为系统级指令。对角色和关系只读的普通用户不得得到他人的私有关系状态。
- 验收：隔离 PG 测试核心版本更新、普通用户拒绝、A/B 两人关系隔离、重启持久化、事件重放幂等、无主伴侣冒认；无 PG 时仅跑单元 fixture，不声称 PG 通过。

### Lane C：具体契约

- `normalizeOneBotEvent(raw)` 仅返回校验后的**未受信** `InboundEvent` 候选；不从 `raw.user_id`、`raw.group_id` 自动创建 `VerifiedChannelEvidence`。
- `verifyOneBotChannel(raw, trustedTransportContext)` 只有在可信传输层验证通过（例如受控 WS 连接、已验证 webhook secret / loopback 绑定）才可创建 channel evidence；该层必须显式注入、默认关闭；不接受消息内自称可信的字段。
- 保持 `eventId` 唯一性、`senderPlatformId`、`conversationPlatformId`、`conversationKind`、`timestamp` 及最大长度约束；消息类型不支持时拒绝，不把群消息误判私聊；机器人自己的回声事件不可作为新用户消息。
- `formatOneBotSend` 只支持受控文本发送，不允许消息中的字符串注入额外 OneBot action/target；超长消息拒绝或明确分段，不静默截断。
- `classifyOneBotReceipt` 将成功、明确未发送、发送结果未知区分；网络超时/断连/不明响应必须是 `receipt_unknown`，**不能自动重发**。
- 验收：协议 fixture 测试正常私聊/群聊、恶意/畸形 payload、身份伪造、回声、重复事件、回执未知、配置缺失默认不连接；不接真实 QQ，不写生产数据。

## 3. 集成依赖图

```text
GPT Spec (本文件)
   ├── A: M1b1 PG history ──> M1b2 CLI + ModelGateway ──┐
   ├── B: P1 persona core ──────────────────────────────┤──> 集成验收
   └── C: Q1 OneBot protocol ────────────────────────────┘
                                        └──> M2b memory / M3a QQ wiring / M3b release
```

三条线各自使用不同工作目录/runner、不同 Git 分支；同一时间不得对 `feat/companion-v3` 做并发直接推送。B/C 的 PR 必须经过源文件白名单、单元测试、全量隔离测试、模型独立审查；审查模型 HTTP 404/空响应是**基础设施未通过**，不能据此宣称代码缺陷或代码已审查通过。失败保留分支和具体失败阶段，下一次优先重试失败阶段，不重新生成已通过的代码。

## 4. 合并与发布门禁

1. A 按既有串行工作流推进；B/C 各自独立分支 `automation/parallel-persona-<base>`、`automation/parallel-onebot-<base>`，不得 force push、不得直接改 `main`。
2. B/C 的每个 PR 必须是**相对当前开发分支可干净合并**，而且对修改后的合并结果重新运行全量测试；不允许凭某一分支历史通过就跳过。
3. 按 **B → C** 或先通过者先集成的顺序**串行合并**；若基础分支移动或冲突，重新验证，不允许强推覆盖。
4. 集成完成后，M2a/M3a 中已由 B/C 实现的部分需逐项核验，剩余 CLI/渠道接线另开任务；不得重复生成同一模块。
5. 自动化开发的 `CODING_API_*`、`REVIEW_API_*`、`DEEPSEEK_API_KEY` 与业务聊天的 `COMPANION_CHAT_*` 严格隔离。密钥只放 GitHub Secrets；日志和 PR 不包含密钥、私聊、真实用户数据。
6. 最终验收分别标记：静态检查、单元测试、真实隔离 PostgreSQL、真实聊天 API、真实 QQ、生产部署。没有配置的阶段标为**未验证**。

## 5. 速度与成本

- 同时最多 **3 个编码 worker**（现有 A + 新增 B、C）；每 worker 独立 GitHub Actions job，单轮最多一个 bounded coding attempt；不共享 OpenCode session、数据库实例或写入分支。
- 不允许一个大 prompt 同时让三个 worker 修改 `src/index.ts` 或公共 schema；公共接线由后续集成任务处理。
- 先跑最小单元测试，**最终仍需跑完整固定测试**；只有测试与独立审查通过的代码才进入开发分支。
- 遇到 review API 的 404/401/429/空输出时，明确报模型配置或限流问题并保存代码；不要反复调用编码模型重写同一任务。
- 实际耗时与成功率以 Actions 运行记录为准；并行提高吞吐，但不能承诺线性三倍提速。

## 6. 验收命令（B/C 的合并前验证）

```bash
pnpm install --frozen-lockfile
pnpm --filter @oh-bot/companion typecheck
pnpm --filter @oh-bot/companion build
pnpm exec tsx --test packages/companion/test/persona-*.test.ts
pnpm exec tsx --test packages/companion/test/onebot-*.test.ts
# 隔离 PostgreSQL 和全量回归由受信 .github/codex/check.sh 负责
```

命令应仅在对应测试文件已生成时执行；未生成不得把“找不到文件”算通过。
