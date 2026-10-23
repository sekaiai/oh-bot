# Companion Remaining Implementation Plan

> For agentic workers: Sol controls contracts, integration and acceptance; Luna implements. User explicitly authorized autonomous completion of all existing planned code without approval checkpoints.

**Goal:** Implement the remaining M2a–M3b and F4b–F8d code in `docs/implementation/unattended-tasks.md`, preserving the 55 acceptance requirements. External live acceptance stays separately identified when credentials or services are absent.

**Spec:** `docs/superpowers/specs/2026-10-22-companion-execution-brief.md`, `docs/implementation/mvp-delivery.md`, `docs/implementation/acceptance-scenarios.md`.

**Architecture:** Reuse the existing PostgreSQL business ledger, trusted identity/ACL, fenced turns/delivery, outbox and pg-boss. Add immutable persona versions, relationship events, one MemoryGateway/Mem0 adapter, LangGraph with PostgreSQL checkpoints, explicit model profiles, guarded tools, and an opt-in authenticated OneBot channel. Keep the local sandbox and real platform identities separate. Add an independent Vue admin and recoverable operations/deployment tools. No production migration, actual deployment or real QQ send is part of code completion.

## Global constraints

- Node 24, pnpm 11.25.0. Reuse pinned Mem0 3.3.1, LangGraph 1.5.1, PG checkpoint 1.1.0 and LangChain OpenAI 1.6.3 already exercised by compatibility probes.
- No speculative fake production model, replacement memory extractor, Redis, vector server or graph database. SDK-owned tables are migrated by SDKs only; use public SDK extension points for exact history deletion.
- Source/manifest/dependency additions needed by the approved architecture are authorized; existing package scripts, old QQ flow and data remain intact. New package scripts may be added to a new admin package.
- Secrets never appear in source, records, errors or saved instructions. Remote calls require explicit business credentials. Provider tests use the existing local protocol fixture unless live credentials are explicitly configured and authorized.
- Trusted identities, ACL before retrieval/prompt, audit/versions, source-grounded revisions, irreversible deletion protection, receipt_unknown and external-action idempotence are binding requirements, not optional optimizations.
- Distinct ownership permits parallel implementation of independent directories. Agents never change shared index/manifest/schema/CLI/worker/admin files, dependency lockfile, task checkboxes or other owners' files. Sol serializes dependency installation, commits and integration. Use a dedicated *_compat database per lane, never schema-mutating tests against another lane's DB.
- No subagents of implementers; no shared-index commits in parallel. Each lane reports interfaces, test evidence and owned paths. Root commits each lane serially, then a Luna integrator wires services.
- Every lane writes meaningful red tests first, implements, runs its targeted tests, and reports exact outcomes. Shared build and full suites run at integration gates. Do not replace missing behavior with a placeholder or mark an unimplemented task complete.

## Workstreams

- [x] A — Persona/relationships and proactive commitments: M2a, F6a, F6c. Own `src/persona/`, `src/relationships/`, `src/proactive/` and named tests. Existing schema suffices. Trusted actor read context; only authenticated admin publishes persona/partner changes. Source-backed idempotent deterministic relationship events; no punishment for delay/refusal. Persist explicit reminder times, private/group authorization, quiet windows and receipt-safe delivery.
- [x] B — Memory: M2b, F4b/c/d. Own new gateway/adapter/index/deletion modules under `src/memory/` and tests. Reuse existing read/lifecycle services. Pin SDK/history contract; background extraction only through Mem0; candidates need grounded review; correction/forget immediately invalidate prompt visibility. Durable sync/delete jobs, scoped history cleanup, tombstone journal/replay and index rebuild gates, Chinese term fallback and embedding degradation. Test with real PG, SQLite and SDK + HTTP fixture.
- [x] C — Models/graph/tools: F5a/b, F6b. Own `src/runtime/`, new model profile adapter files, `src/tools/` and tests. LangChain profile isolation, bounded timeout/budget/cancel; one LangGraph identity→context→memory→route→tool/agent→compose→deliver→finalize interface with real PG checkpoint and safe resume. Tools/agents inherit permissions and budget; sources remain untrusted structured data; missing search is explicit. Consume injected persona/memory/transport hooks rather than modifying their files.
- [x] D — OneBot channel: M3a, F5c. Own `src/adapters/onebot/` and tests. Explicit enable flag, authenticated WS, strict event normalization, trusted identities, roster evidence, no automatic real connection. Use existing inbound and delivery fencing; echo correlation, unknown receipt never resent, reconnect/cancel/resource cleanup. Isolate local-cli channels from real senders; fixture + PG crash/replay tests.
- [x] E — Admin: F7a/b. Own `packages/companion-admin/` only. Vue3/Vite/Pinia/Element Plus, shared Zod client, memory-only bearer token, independent API base, explicit errors/loading/empty/missing config. Auth, overview, identities/characters, persona/relationships, source/revision/deletion, jobs/agents, tools/models, proactive and operations panels; actual API interactions and safe secret handling. No simulated rows presented as production data.
- [x] F — Operations/deploy: F8a/b/c. Own `src/operations/`, `src/cli/operations.ts`, `deploy/` and tests. Explicit-input byte-preserving legacy backup/hash/idempotent migration, legacy affection tagging. pg_dump + SQLite/SDK/checkpoint/media assets, restic optional remote, retention and independent deletion-journal replay gates on restore. Compose/build/health/upgrade-backup scripts with correct proxy CA trust. Test only owned fixture paths/databases; no production data or actual deployment.
- [x] G — Integration and acceptance: M3b, F8d. Serialize all dependency/schema/entrypoint/API/index updates; wire persona/memory into persistent chat, graph into worker, OneBot opt-in bootstrap, admin routes and operations. Add runnable local startup/model smoke commands. Map all 55 scenarios to real tests or explicit live/manual gates. Run complete builds/tests and representative API/UI/runtime functional checks, fix all load-bearing review findings, then update progress and checkboxes only from evidence. Never claim live/production acceptance from fixture results.

## Review focus

Cross-person/group memory disclosure, forged admin principal, stale authorization during async work, deleted material after backup replay, duplicated external sends/relationship events, checkpoint reauthorization, unbounded loops/budgets, model/profile credential crossing, UI token persistence/leakage, destructive operations targeting the wrong paths/databases, and SDK history loss are mandatory review targets.

## Execution and evidence

Work in the existing isolated cloud checkout on `feat/companion-complete`; do not create worktrees. Each lane uses `/workspace/oh-bot-work/complete/<lane>-report.md`. Retain exact base commits and test logs in the ledger. Source `/workspace/oh-bot-setup/env.sh` for writable caches, then override CORE_TEST_DATABASE_URL for that lane. Node processes and Docker containers need explicit restart; snapshots do not preserve running services. User permits proceeding without approval; do not stop between workstreams. Production external side effects remain disabled by the spec.

Final code/fixture evidence: docs/implementation/completion.md. Live/provider/QQ/production/manual acceptance remains separately gated by acceptance-map.md. User requested lower usage: Sol light control, one Luna executor, no further parallel deep review loops.
