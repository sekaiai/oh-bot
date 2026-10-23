# Companion startup and operations

Companion runs as a separate Nest/Fastify admin API and a supervised worker. The legacy bot's cookie API and settings remain independent. Runtime entrypoints are built from `packages/companion`.

## First-time setup

Use Node.js 24, the configured package dependencies, and PostgreSQL. Create an isolated database and set `COMPANION_DATABASE_URL`. For model-backed conversation set all three `COMPANION_CHAT_API_URL`, `COMPANION_CHAT_API_KEY`, and `COMPANION_CHAT_MODEL`; there is no fallback to legacy `AI_*` or coding credentials. `COMPANION_ADMIN_TOKEN` must be an existing random bearer secret of at least 32 bytes.

Every enabled profile model also needs a numeric price entry in `COMPANION_MODEL_PRICING_JSON`, keyed by its exact model name and containing `inputUsdPer1M` and `outputUsdPer1M` rates from the provider. Missing, malformed, or unknown-model rates fail before a provider call. Actual charges use provider-reported token counts; monthly reservations use the UTF-8 request byte bound plus per-message envelope overhead and the configured completion cap.

Build the package and initialize only the services explicitly configured in the environment:

```sh
pnpm --filter @oh-bot/companion build
node packages/companion/dist/cli/start.js --setup
```

`--setup` runs the Companion database migration, worker queue schema, and LangGraph checkpoint schema. If the full `COMPANION_MEMORY_*` configuration and `MEMORY_DELETION_JOURNAL_PATH` are present, it initializes the Mem0 SQLite history store. Keep that journal on an independent persistent volume. Setup is the only startup path that creates a Mem0 history store; normal API/worker startup requires an existing valid store and replays deletion tombstones before readiness.

Run API and worker together:

```sh
node packages/companion/dist/cli/start.js
```

Or run `node packages/companion/dist/main.js` and `node packages/companion/dist/worker.js` under a supervisor. The worker owns graph processing, durable outbox sends, and configured memory maintenance. Its shutdown stops queue work, joins maintenance, then closes the memory SDK and graph/database clients.

## Optional adapters

OneBot is off by default. Enable it only with `COMPANION_ONEBOT_ENABLED=1` and explicit `COMPANION_CHARACTER_ID`, `COMPANION_ONEBOT_WS_URL`, `COMPANION_ONEBOT_ACCESS_TOKEN`, and `COMPANION_ONEBOT_SELF_ID`. Group messages default to mention-only policy and require a complete roster fetched before the inbound turn is committed. Local CLI identities cannot be used for QQ. The worker sends only through its fenced delivery service; graph hooks stage durable work and never send directly.

Memory is off when no `COMPANION_MEMORY_*` variables are configured; a partial configuration fails startup. Configure `COMPANION_MEMORY_CHAT_API_URL`, `COMPANION_MEMORY_CHAT_API_KEY`, `COMPANION_MEMORY_CHAT_MODEL`, `COMPANION_MEMORY_EMBEDDING_API_URL`, `COMPANION_MEMORY_EMBEDDING_API_KEY`, `COMPANION_MEMORY_EMBEDDING_MODEL`, `COMPANION_MEMORY_EMBEDDING_DIMENSIONS`, `COMPANION_MEMORY_HISTORY_PATH`, `COMPANION_MEMORY_COLLECTION`, and independent `MEMORY_DELETION_JOURNAL_PATH`. Memory sync and deletion jobs run in the supervised worker. API startup also opens the configured stores and validates replay readiness before exposing admin deletion actions.

Search and weather tools are unavailable until their explicit `COMPANION_TOOL_*_API_URL` and `COMPANION_TOOL_*_CREDENTIAL_REF` variables are configured. A search model binding may plan up to three searches; the search endpoint returns strict structured sources. The character model remains the sole voice in the user response. Tool permissions are server-configured through `COMPANION_TOOL_PERMISSIONS`.

Proactive sends require `COMPANION_PROACTIVE_ENABLED=1`, explicit person/group permissions, quiet hours, quota, and a working outbound adapter. Unknown delivery receipts are never resent automatically. A local model smoke makes a real request only when explicitly invoked:

```sh
node packages/companion/dist/cli/model-smoke.js
```

It reads only `COMPANION_CHAT_*` and prints response length/model metadata, not provider output or credentials.

## Persistent local chat

```sh
pnpm exec tsx packages/companion/src/cli/chat.ts --persistent --session-file .local/companion-profile.json
```

The private session profile is a local synthetic identity scoped to the current OS account. Persistent CLI chat uses the configured character persona and authorized memory services when those are configured. It does not enable QQ or mark terminal output as a platform delivery receipt.

For isolated persona calibration without a database or production identity, run `pnpm exec tsx packages/companion/src/cli/chat.ts --sandbox --sandbox-file .local/companion-sandbox/persona.json`. Use `/persona` to inspect the trial persona and `/persona <text>` to revise it. The sandbox writes only that separate file with private permissions; it does not load persistent history, identity, relationship, or memory services.

## Acceptance

The exact test-to-scenario mapping is in [acceptance-map.md](acceptance-map.md). Fixture tests do not prove real model/QQ operation. Do not describe the 55 product scenarios as all passing: live provider, QQ, restore drills, model quality, and environment-specific storage checks remain explicit gates unless accompanied by a fresh evidence record.
