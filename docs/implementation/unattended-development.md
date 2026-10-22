# 无人值守开发

流程：GitHub Actions 启动临时 Ubuntu + pgvector → Codex 完成一个明确任务 → 固定验证 → 推送草稿 PR。默认目标是 `feat/companion-v3`，不会自动合并、部署或发送 QQ 消息。工作流代码已建立不等于自动执行已启用。

## 首次启用

1. 将本工作流文件合并到仓库默认分支 `main`。GitHub 的 schedule 和首次 workflow_dispatch 发现依赖默认分支；同时确保目标 `feat/companion-v3` 也包含 prompt、脚本和任务清单。
2. 在仓库 Settings → Secrets and variables → Actions 添加 Secret `OPENAI_API_KEY`，以及 Variable `CODEX_MODEL`（填写你的 API 项目实际可用的编码模型）。机器人运行用 DeepSeek/百炼密钥不用于这个执行器，也不要放生产凭据。
3. 在 API 项目单独设置费用控制和用量告警。该工作流只能限制次数和时长，不能保证美元硬上限；预算通知是否阻止消费以服务商设置为准。
4. Settings → Actions → General 允许 GitHub Actions 创建 PR。确认仓库允许使用工作流中固定 SHA 的 Actions。
5. 确认当前人工 worker 修复已提交，核对任务清单，然后添加 Variable `UNATTENDED_ENABLED=true`，在 Actions → Unattended Codex → Run workflow 首次手动运行。

本地连接如果没有 Secrets/Actions 管理权限，需要仓库管理员在网页完成第2、4、5项；不要把 API key 发到聊天中。

## 运行和暂停

自动计划为每天北京时间 09:00 和 21:00（UTC 01:00/13:00），GitHub schedule 可能延迟。整个任务最多45分钟，其中编码25分钟、最终验证12分钟；同工作流串行，Codex 单轮最多两次修复尝试。限额不是精确费用上限。

Actions 显示 queued/in progress/completed/failure；每轮摘要区分编码与验证结果。失败的验证会产生失败状态；安全路径检查通过时可保留草稿 PR，草稿不代表通过验收。无人值守不会自动合并，待人工审查后进入下一任务。

暂停：将 `UNATTENDED_ENABLED` 改为 `false`；已经运行的任务需要在 Actions 点击 Cancel workflow。没有未完成明确任务时，编码器停止改动。

每轮从目标分支重新开始，PR 分支是可替换的草稿，不要在该分支手工开发。修复未合并草稿时可能重新实施同一任务；若需保留草稿人工修改，请先暂停自动执行。

## 权限和限制

GITHUB_TOKEN 仅用于创建分支与草稿 PR，不需要整个账号凭据；checkout 不持久保存 token，编码步骤不传入 GitHub 写 token。工作流没有 PR/issue 评论触发入口，避免外部用户提交的指令触发编码。自动改动禁止工作流、运行数据和自身验证脚本等路径。

运行由临时 GitHub 托管机器执行，使用官方 Codex Action 的 workspace-write 与 drop-sudo。任务本身需要执行代码和依赖安装；不要给它生产 Secret。编码质量、隐私行为与产品人格仍需独立审查与完整验收。当前仅列出 F3b 收尾任务，后续阶段需要更新清单。
