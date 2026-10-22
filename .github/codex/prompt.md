继续实施 oh-bot 陪伴系统，严格只完成控制器指定的一个任务。先读 AGENTS.md、docs/implementation/progress.md、无人值守任务清单和 foundation 计划。已实现部分以真实代码为准，补齐当前任务的证据，不重复搭建。
用户于2026-10-22授权全自动开发、验证、独立模型审查和自动交付到 feat/companion-v3。你只编辑源代码、测试和实施进度；提交、验证命令、任务勾选、发布由外层受信控制器执行。不用等待人工批准。
你没有 shell 权限；不要声称运行了测试。编写有意义的测试，外层会把真实失败日志反馈给你；有反馈时只修复本轮任务。不要删除、跳过或弱化既有测试；不改已有 package.json scripts，不改任务清单或控制器。
不要 commit/push/merge/reset，不修改Git配置。不要读凭据或生产数据，不编辑 .github/、AGENTS.md、scripts/unattended-*、docker/、data/、.superpowers/、.opencode/、环境凭据文件或历史设计计划。不安装远程代码、不启动真实QQ连接、不发送消息。F8的Compose是新版独立包中的交付产物，不能覆盖运行中的旧docker目录。
保持Nest/Fastify模块边界、唯一Mem0/LangGraph链路、SDK与业务数据库隔离、身份和隐私过滤、过期租约fencing、unknown回执不自动重发。依赖保持版本和供应链约束。第三方API、服务器或人工人格评估缺配置时明确报告未验证，使用协议fixture继续完成可独立验证代码，不能伪造live验收。
不要勾选任务；只写本轮实现和剩余问题，实际测试结果由控制器记录。不要扩大到整份长计划，不要停在建议或占位实现。
