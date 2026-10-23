# Companion fixed-scenario acceptance map

This map distinguishes deterministic fixture coverage from actual product acceptance. “Partial fixture” means the cited test exercises one property, not every required outcome. No live provider, QQ account, production storage, or clean-room disaster recovery acceptance is claimed here. See the [55 scenario definitions](acceptance-scenarios.md).

| ID | Evidence currently available | Acceptance status |
|---|---|---|
| 01 | `test/persona.test.ts`, `test/relationship.test.ts` | Partial fixture; relationship-sensitive model expression unscored |
| 02 | `test/identity.test.ts`, `test/admin-api.integration.test.ts` | Partial fixture; persona and primary-binding behavior only |
| 03 | `test/admin-api.test.ts`, `test/admin-extension.integration.test.ts` | Fixture auth coverage; full prompt-injection/live workflow unrun |
| 04 | `test/identity.test.ts`, `test/admin-api.integration.test.ts` | Partial fixture |
| 05 | `test/identity.test.ts` | Fixture |
| 06 | `test/identity.test.ts` | Fixture; cross-platform recall not proven |
| 07 | `test/identity.test.ts`, `test/disclosure-policy.test.ts` | Partial fixture |
| 08 | `test/relationship.test.ts` | Partial fixture; both relationship perspectives not live tested |
| 09 | `test/relationship.test.ts` | Partial fixture |
| 10 | `test/relationship.test.ts` | Partial fixture |
| 11 | `test/disclosure-policy.test.ts`, `test/memory-reads.integration.test.ts` | ACL fixtures; generated reply leakage assessment unrun |
| 12 | `test/disclosure-policy.test.ts`, `test/memory-reads.integration.test.ts` | ACL fixtures; generated reply leakage assessment unrun |
| 13 | `test/disclosure-policy.test.ts`, `test/memory-reads.integration.test.ts` | ACL fixtures; cross-group live flow unrun |
| 14 | `test/disclosure-policy.test.ts`, `test/memory-reads.integration.test.ts` | Partial ACL fixture; source citations/live answer unrun |
| 15 | `test/memory-reads.integration.test.ts`, `test/identity.test.ts` | Partial fixture; multi-speaker model output unrun |
| 16 | `test/memory-lifecycle.integration.test.ts` | Partial extraction/lifecycle fixture |
| 17 | `test/memory-lifecycle.integration.test.ts` | Partial claim-classification fixture |
| 18 | `test/memory-lifecycle.integration.test.ts` | Partial claim-classification fixture |
| 19 | `test/memory-gateway.integration.test.ts` | Source-ledger fixture; model-generated memory extraction unrun |
| 20 | `test/memory-index.integration.test.ts` | Fixture |
| 21 | `test/memory-gateway.integration.test.ts`, `test/memory-sdk.test.ts` | Partial persistence fixture; production restart/store restore unrun |
| 22 | `test/memory-lifecycle.integration.test.ts` | Fixture |
| 23 | `test/memory-gateway.integration.test.ts`, `test/worker-recovery.integration.test.ts` | Partial retry fixture |
| 24 | `test/memory-lifecycle.integration.test.ts`, `test/deletion-journal.test.ts`, `test/memory-gateway.integration.test.ts` | Partial fixture; provider-specific cleanup drill unrun |
| 25 | `test/memory-gateway.integration.test.ts` | Partial fixture |
| 26 | `test/memory-index.integration.test.ts`, `test/deletion-journal.test.ts` | Partial fixture |
| 27 | `test/operations.integration.test.ts`, `test/deletion-journal.test.ts` | Replay primitives covered; isolated restore-and-serve drill unrun |
| 28 | `test/model-profile-gateway.test.ts`, `test/schema.test.ts` | Partial fixture |
| 29 | No end-to-end reindex/switch test | Unrun |
| 30 | `test/memory-gateway.integration.test.ts`, `test/memory-index.integration.test.ts` | Partial degraded recall fixture |
| 31 | `test/memory-sdk.test.ts` | Corrupt/missing store checks; volume-loss environment drill unrun |
| 32 | `test/runtime-graph.integration.test.ts` | PostgreSQLSaver resume/thread fixture; deployed restart unrun |
| 33 | `test/transactions.test.ts`, `test/worker.integration.test.ts` | Fixture |
| 34 | `test/transactions.test.ts`, `test/worker-recovery.integration.test.ts` | Unknown-receipt fixture; real QQ transport behavior unrun |
| 35 | `test/transactions.test.ts`, `test/worker-lifecycle.test.ts` | Partial lease fixture; live long-call/cancel check unrun |
| 36 | `test/persona.test.ts`, `test/proactive.test.ts` | Partial policy/state fixture; model classification unrun |
| 37 | `test/relationship.test.ts` | Partial classification fixture |
| 38 | `test/relationship.test.ts` | Failure handling fixture |
| 39 | No longitudinal test | Unrun/manual relationship-quality gate |
| 40 | `test/admin-api.integration.test.ts`, `test/admin-extension.integration.test.ts` | Partial authorization fixture |
| 41 | `test/tool-http-adapters.test.ts`, `test/runtime-graph.integration.test.ts` | Local HTTP adapter fixtures; live weather provider unrun |
| 42 | `src/application/research-agent.ts` is wired; no dedicated research subgraph acceptance test yet | Unrun |
| 43 | `test/tool-http-adapters.test.ts` | Fixture; generated answer quality unrun |
| 44 | `test/tool-http-adapters.test.ts`, `test/tool-registry.test.ts` | Partial untrusted-output fixture |
| 45 | `test/tool-registry.test.ts`, `test/tool-run-store.integration.test.ts` | Partial budget/cancellation and durable run fixtures; deep subagent budget test unrun |
| 46 | `test/proactive.test.ts` | Partial authorization fixture; worker scheduler integration remains gated |
| 47 | `test/proactive.test.ts`, `test/reminder-grounding.test.ts` | Partial fixture; persistence requires the proposed ISO instant to occur in the current user message, full live conversation unrun |
| 48 | `test/operations.integration.test.ts` | Partial legacy migration/backup fixture |
| 49 | `test/sandbox-persona.test.ts` | Isolated local persona-file fixture; human calibration quality remains unrun |
| 50 | `test/operations.integration.test.ts`, `test/deletion-journal.test.ts` | Replay component tests only; full cross-store restore drill unrun |
| 51 | `test/memory-sdk.test.ts`, `test/operations.test.ts` | Partial filesystem/tooling failures; disk-full drill unrun |
| 52 | `test/operations.test.ts` | Partial config validation; independent destination exercise unrun |
| 53 | `test/proactive.test.ts`, `test/worker-recovery.integration.test.ts` | Partial lease recovery fixtures; scheduled sender lifecycle still gated |
| 54 | `test/persona.test.ts` | Partial prompt/persona contract; live truthfulness review unrun |
| 55 | `test/database.test.ts`, `test/schema.test.ts`, `test/operations.integration.test.ts` | Business schema fixture; third-party schema upgrade/restore unrun |

Before production enablement, record exact build/config revision, synthetic input, response/state transition, database evidence, and result for each remaining live/manual gate. The table does not imply full scenario completion.
