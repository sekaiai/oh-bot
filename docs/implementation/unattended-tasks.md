# 无人值守任务清单

执行分支：`feat/companion-v3`。产出：`automation/companion-next` 草稿 PR，人工合并后下一轮继续。不得把未合并 PR 当成已交付；同一任务可在草稿上继续修复。当前人工开发优先，启用前核对最新代码并调整本清单。

- [ ] F3b：检查 job execution attempt 租约是否已完整接入 worker 与 dispatcher；补齐重复执行、过期接管、迟到结果 fencing 的 PostgreSQL 证据。已有 `JobAttemptService`，先确认是否已有后续提交，不重复实现。
- [ ] F3b：修复管理端 unavailable/过期任务安全恢复、合法 status 过滤、统一只读队列 readiness；sent/receipt_unknown 不走普通重试。
- [ ] F3b：补齐发送后 finalize 前崩溃、生成后 worker 重启、过期 sending 转 unknown、unavailable 耗尽后恢复的实库测试；隔离启动测试队列并消除瞬时计数断言。
- [ ] F3b：根据上述最终实现复核既有审查发现，运行完整验证矩阵，更新进度与验收证据；缺少独立审查时明确标记待审，不自行宣布验收通过。

后续 F4–F8 仍按 `docs/superpowers/plans/2026-10-22-companion-foundation.md` 的依赖推进。此清单完成后停止，待把下一阶段拆成明确任务后再继续；不要直接实现整份长计划。
