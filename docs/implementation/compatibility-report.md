# 兼容性验证记录

状态：本地协议与持久化组合验证通过；真实第三方API未配置，不可据此切换生产或删除旧源码。

## 环境与版本

- 代码基线：`dev` `3d849ad`；本地实施分支 `feat/companion-v3`。
- Node.js 24.19.0、pnpm 11.25.0、Docker 28.4.0。
- PostgreSQL 17 系列、pgvector 0.8.7；镜像 `pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`。
- Mem0 OSS `mem0ai/oss` 3.3.1；LangGraph 1.5.1；PostgreSQL checkpointer 1.1.0；LangChain OpenAI 1.6.3；node-postgres 8.23.1。

## 已核对的实际能力

以 npm 发布包的类型和实现为证据：

- Mem0 根导出是 Platform 客户端，OSS 使用 `mem0ai/oss`。
- PGVector 支持 `connectionString`，显式指定已有数据库可避开默认建库路径。向量维度和 collection 必须显式设置。
- PGVector 的 filters 约束 JSONB metadata，不能替代服务端的业务授权。每次调用需要服务端装配允许的身份和可见范围。
- Mem0 3.3.1 没有任意 PostgreSQL history provider。SQLite history 必须指定持久文件并与 PG 一起备份；Supabase history 是另一个provider，不能当作任意PG适配器。
- 当前 add 的自动提取路径使用 additive extraction 的 `memory` 数组，不是旧示例的 `facts`。显式 `update`/`delete` 能力与自动语义更正不能混为一谈，业务更正需后续来源/修订网关验证。
- Memory 没有公开 close/dispose。验证程序将使用有界测试子进程，在完成已await操作后退出并由OS释放SDK资源；不得访问private字段。生产worker生命周期仍需后续明确实现。
- 测试在导入Mem0前关闭遥测；不把对话测试内容发送到未配置的服务。

## 验证结果

| 项目 | 结果 | 范围 |
| --- | --- | --- |
| 旧后端类型检查和构建 | 通过 | 未启用新运行路径 |
| 旧管理端构建 | 通过 | Vue/Vite |
| 旧环境doctor | 缺配置 | NAPCAT_WS_URL、AI_BASE_URL、AI_MODEL；进程虽退出0，不代表可运行 |
| 新配置单测/类型检查 | 通过，路径修复已复审 | 配置9项加隔离库1项单测，涵盖缺字段、非法值、不泄露输入 |
| 真SDK + 真PG协议fixture集成 | 主控最终代码实跑6/6集成测试 | 含提取正文、scope、history、更正删除、secret错误、图恢复与只读缺表 |
| 真实第三方API | 未配置 | 不算通过 |
| 数据库重启与恢复 | 组合CLI最终严格只读复验通过 | 保留PG卷与SQLite文件，没有重新seed；不是备份归档恢复 |

## 运行与数据边界

本地测试数据库 `oh_bot_compat` 独立于旧JSON运行数据，只监听回环端口。测试密码是明确的本地演示值，不能用于部署。测试volume不是生产备份。

没有读取旧JSON中的API密钥，没有真实发QQ消息，没有部署或推送。旧源码和运行数据完整保留。完整首版的业务身份、来源校验、忘记全链路、备份恢复、管理端和50场景验收仍在后续阶段。

## 最终主控验证

提交 `9e7a39b`：typecheck通过，单测14/14、集成6/6，0 skipped。随后保留命名volume重启`oh-bot-compat-db`，新CLI进程`--verify`返回passed，existing sentinel、readonly connection、persisted final graph state三项均通过。旧`pnpm codex:check`构建通过，doctor的缺配置如上。

严格只读恢复路径不调用会初始化存储的Mem0构造器，也不执行PostgresSaver.setup。Mem0读取通过明确限定3.3.1布局的SELECT-only适配器，SQLite readonly/fileMustExist；图连接强制只读。公开SDK的新进程读取另由正常集成测试覆盖。升级SDK必须重验布局。

已知限制：真实DeepSeek/百炼API、完整用户忘记、备份归档恢复和完整首版业务均未由本阶段证明。Mem0公开delete保留历史原文，后续需要明确版本化历史适配器扩展；不能把其DELETE当成全链路擦除。
