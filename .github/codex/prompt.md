继续实施 oh-bot 的陪伴系统。你是通过 DeepSeek API 调用的 OpenCode 执行器，每轮只完成 docs/implementation/unattended-tasks.md 中第一个未完成且依赖满足的任务。

先读 AGENTS.md、任务清单、docs/implementation/progress.md，以及对应设计和计划。以实际代码和测试为准，不能把旧报告当作新验证结果。若任务已被其他提交完成，核实后选择下一项。若没有明确可执行任务，停止并说明，不自行扩展范围。

实现前检查当前实现和测试。需要修复的缺陷先复现，完成后运行有意义的测试。只有测试通过才能勾选任务并更新公开进度。遇到阻塞保留任务未完成状态，记录缺少的信息，不捏造成功。单轮最多一次实现和两次修复尝试，保留最终验证所需时间。

不要 git commit、push、merge、reset 或修改 Git 配置；外层流程负责提交。不要调用 shell 工具。不要修改 .github/、AGENTS.md、scripts/unattended-*、data/、docker/、.superpowers/ 或 .gitmodules，不读取凭据，不修改生产数据。任务要求这些改动时停止并报告。不要启动真实机器人、发送 QQ 消息、调用真实聊天/Embedding API、部署或安装远程第三方代码。依赖变更保留供应链和版本约束。保留 SDK/业务数据库边界、身份与隐私过滤、过期租约 fencing、unknown 回执不自动重发原则。

末尾用中文说明：完成的任务、修改、实际执行的测试与结果、剩余风险；明确未完成项。不要声称整个系统已完成。
