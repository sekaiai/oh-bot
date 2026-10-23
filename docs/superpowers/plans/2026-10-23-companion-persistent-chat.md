# M1b2 Persistent Local Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the existing MVP specification; this is its next implementation slice.

**Goal:** Continue a trusted, private local conversation across CLI restarts using PostgreSQL and the existing real ModelGateway.

**Architecture:** Add a synchronous local chat orchestrator over LocalChatSessionService, IdentityService, InboundService and TurnService. Keep the existing in-memory CLI compatible and expose explicit opt-in persistent mode backed by a private local sandbox profile. The profile establishes a synthetic local identity, never impersonates an actual QQ user, and has no remote authentication claim.

**Tech Stack:** Node.js 24, pnpm 11.25.0, TypeScript, Drizzle, PostgreSQL, node:test, existing HTTP fixture.

**Spec:** docs/implementation/unattended-tasks.md (M1b1/M1b2), docs/implementation/mvp-delivery.md; existing M1b1 code is the baseline.

## Global Constraints

- Sol controls scope and verification; Luna implements. Execute only M1b2 this round.
- No new package scripts/dependencies/network service/migrations unless a concrete blocker is reported. No real QQ connection, provider calls, deployment, production data or secrets.
- Keep old QQ bot, existing APIs and model credential isolation unchanged. Existing CLI behavior remains available.
- Authorization must use trusted channel evidence plus resolved membership; never use supplied userId/personId/ActorContext for history access.
- Reuse existing fenced TurnService persistence and outbox semantics. Do not claim terminal output was delivered to QQ or mark unknown receipts sent.
- Source/test/docs changes are authorized. Work in the existing isolated cloud checkout on the feature branch; do not create a worktree. All commits use Chinese messages. Do not push or merge.

## Review Focus

- A forged or mismatched identity must fail before sending any history to a provider.
- Replayed events must not call the gateway again or create duplicate user/assistant records; conflicting payloads fail.
- Concurrent local processes must not generate on the same session simultaneously or leak a database lock/client on failure.
- Restart must recover correctly ordered persisted user/assistant messages, with bounded history respecting the 200-message gateway limit.
- A failed/empty provider reply or persistence failure must not be printed as a successful saved answer or leak credentials; resources close on EOF/error.

### Task 1: Persistent local chat service and CLI integration

**Files:**
- Create `packages/companion/src/conversations/local-chat-service.ts` and focused local CLI profile helper under `src/cli/`.
- Modify `packages/companion/src/cli/chat.ts`, `src/index.ts`; change existing session/transaction helpers only if required to preserve their contracts.
- Create `packages/companion/test/local-chat.integration.test.ts` and persistent CLI/profile tests; reuse `test/chat-fixture.ts` and existing database helpers.
- Update package README, local-dev-handoff, progress and M1b task checkboxes only where evidence supports completion. Add an ignore pattern for local profile files if needed.

**Interfaces:**
- Consumes `LocalChatSessionService.acceptMessage(characterId, event, evidence)` and `readHistory(characterId, evidence, {limit})`, `ModelGateway.complete(request)`, `TurnService.claim/persistGenerated/fail`.
- Produces exported `LocalChatService` (or equivalently named focused orchestrator) with one method accepting a character ID, InboundEvent and VerifiedChannelEvidence; optional generation options contain only system/temperature, never authorization claims. Return persisted reply IDs/text and duplicate status; no secret values.
- CLI opt-in `--persistent` uses `COMPANION_DATABASE_URL` and `--session-file <path>` (default an ignored local path). Preserve no-database in-memory mode for backward compatibility.
- A new local profile uses cryptographically random IDs. Profile user/channel identifiers must live in a strict reserved `local-cli:` namespace, with a dedicated generated character ID. Strictly validate stored profiles, reject symlinks/insecure file permissions, create exclusively with mode 0600, never overwrite malformed/existing user files. This is a single-user OS-account-owned development sandbox; not remote identity verification. Do not offer arbitrary person/user/character ID flags.
- Explicit migration before persistent CLI use remains documented; startup never silently migrates schema. Create the profile's dedicated character idempotently without changing unrelated characters. Avoid orphan profiles/characters on interrupted initialization where practical.
- Bound concurrent requests per trusted session using a database advisory lock or equivalent shared guard. Prefer a nonblocking try-lock with a stable busy error. Always release the lock and pool client in finally. Claim a fenced turn before generation; only print after persistGenerated commits. Replayed completed events recover saved content without another upstream request; incomplete/failed replays report a stable state instead of duplicating work.
- Terminal local persistence does not mean QQ delivery: retain pending outbox semantics and document no worker/QQ dispatch for these synthetic conversations. Never configure a real sender for local-cli identifiers.

- [ ] Write failing integration tests: restart with a fresh orchestrator/CLI and same profile replays the first user/assistant pair in the next HTTP fixture request; two profiles remain isolated; forged/cloned/mismatched evidence sends zero provider calls; duplicate event produces exactly one user and assistant, one turn/delivery, one gateway call; conflicting duplicate fails; concurrent request is busy without duplicate model calls; gateway failure creates no assistant and releases the lock; bounded and correctly ordered history (including equal timestamps) fits gateway limits.
- [ ] Add CLI/profile tests: explicit persistent opt-in, malformed/missing database fails safely, private profile restart identity, invalid/tampered namespace/symlink/permissions rejected, old CLI fixture tests still pass, no secrets or database URL in errors, EOF/error closes resources. Add a real child-process restart fixture test backed by isolated PG.
- [ ] Run the new targeted tests and record the expected red failure before implementation. Use `/workspace/oh-bot-setup/env.sh` for caches and test URLs. Database test names must end in `_compat`.
- [ ] Implement the minimal service/profile/CLI changes. Read the full relevant existing code before changing it. Use stable sanitized error codes. Do not hold a SQL transaction open across an HTTP model call. Avoid weakening existing assertions or modifying package scripts.
- [ ] Run targeted new tests, existing chat tests, package typecheck/build, then the existing `.github/codex/check.sh` serially. Inspect actual counts/skips and exit codes. Do not run schema-mutating suites concurrently.
- [ ] Update reproducible instructions and progress with exact commands, verified capabilities and limits (fixture is not live). Self-review the diff. Commit implementation/tests/docs with Chinese messages, report commit IDs, red/green evidence and any concerns; no push.
