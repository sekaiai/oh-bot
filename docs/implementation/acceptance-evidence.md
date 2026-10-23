# 验收证据与边界

截至业务基础F2（6917783），下列是可复现的局部证据，不是55个产品场景已经通过。完整要求见 [固定验收场景](acceptance-scenarios.md)。真实DeepSeek、百炼和QQ尚未接入验证。

| 场景 | 已有确定性证据 | 仍待验证 |
| --- | --- | --- |
| 03、04 | 仅admin可设置主伴侣；可信actor/evidence不能由普通JSON伪造 | 管理HTTP认证、真实通道及模型提示注入端到端 |
| 05、07 | 同昵称不同QQ、跨平台同ID不自动合并；并发同账号解析唯一 | 实际QQ消息接入与完整记忆流程 |
| 06 | 一次性过期挑战、双端身份验证、alias flatten和历史消息归属保留 | 后续平台adapter与允许事实延续 |
| 11—14 | DisclosurePolicy私密范围、主伴侣无权读朋友私事、群名单完整/未确认/外人拒绝和撤权复核 | 事实召回、模型实际HTTP请求和最终回复无泄漏 |
| 21、22 | 兼容性包中真实Mem0/PG/SQLite历史、新进程读取与SDK更新/删除 | 业务来源账本、完整纠错/忘记及正式runtime重启 |
| 24—27 | SDK公开delete保留历史的限制已查明 | 全链路忘记、迟到提取防复活、重建及旧备份恢复重放 |
| 32 | 独立兼容性图在真实PostgresSaver中断后新实例恢复，节点一次、thread隔离 | 业务完整图与工具/发送恢复 |
| 33 | 并发平台event只写一条message/turn/outbox；绑定后重投仍幂等，冲突包拒绝 | 关系事件、队列和实际发送端到端 |
| 34 | delivery未知回执、过期sending恢复为未知，禁止普通claim；admin核实后审计协调 | 实际NapCat断线/超时/回执协议 |
| 35 | 行锁真实等待跨过expiry后拒绝renew/fail/generate/receipt写入，claim使用获锁后时钟 | 真实模型长调用、heartbeat和取消 |
| 55 | 业务Drizzle迁移source/snapshot一致，真实隔离库重跑保留合成数据 | 三方schema升级、升级前备份及完整恢复 |

可运行入口：`packages/companion/package.json` 的 `typecheck`、`build`、`test`、`test:integration`；业务集成测试必须显式设置数据库名以`_compat`结尾的`CORE_TEST_DATABASE_URL`。兼容性独立入口与配置见 [README](../../packages/compatibility/README.md)。所有测试数据均为合成数据，未对真实用户或群聊执行验证。

最新已复验结果：companion单测7项、真实数据库集成9项，0 skipped；compatibility单测14项、集成6项，0 skipped。这些数量来自各阶段实际命令输出，不代表固定场景的计数或人格表达质量评分。
