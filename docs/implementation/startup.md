# Companion startup and operations

Companion runs as a separate Nest/Fastify admin API and a supervised worker. The legacy bot's cookie API and settings remain independent. Runtime entrypoints are built from `packages/companion`.

## First-time setup

Use Node.js 24, the configured package dependencies, and PostgreSQL. Create an isolated database and set `COMPANION_DATABASE_URL`. For transient terminal chat and the explicit smoke command set all three `COMPANION_CHAT_API_URL`, `COMPANION_CHAT_API_KEY`, and `COMPANION_CHAT_MODEL`; there is no fallback to legacy `AI_*` or coding credentials. `COMPANION_ADMIN_TOKEN` must be an existing random bearer secret of at least 32 bytes.

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

Persistent chat uses database model bindings, not `COMPANION_CHAT_*`. Export variables in the shell running the API/worker/CLI; these entrypoints do not automatically load the root `.env`. Keep the legacy `pnpm start`/`pnpm dev` bot separate from Companion to avoid duplicate QQ replies.

After `--setup`, create the private local profile and its character without sending a model request (run from the repository root):

```sh
node --import tsx --input-type=module <<'JS'
import { resolve } from 'node:path';
import { loadOrCreateLocalProfile, ensureLocalCharacter } from './packages/companion/src/cli/local-profile.ts';
import { createDatabase, loadDatabaseConfig } from './packages/companion/src/database/database.ts';
const profile = await loadOrCreateLocalProfile(resolve('.local/companion-profile.json'));
const database = createDatabase(loadDatabaseConfig(process.env).databaseUrl);
try {
  await ensureLocalCharacter(database, profile);
  console.log('characterId:', profile.characterId);
} finally { await database.close(); }
JS
```

Use the bearer-protected API (or the model administration panel) to complete this sequence:

1. Export a business credential variable, for example `COMPANION_LOCAL_MODEL_KEY`, in the API and chat processes. Never put the key itself in a profile request.
2. `POST /admin/model-profiles` with `name`, `purpose: "chat"`, `provider: "openai"`, provider `baseUrl`, exact `model`, and `credentialRef: "COMPANION_LOCAL_MODEL_KEY"`. The profile starts disabled.
3. Set `COMPANION_MODEL_PRICING_JSON` in both processes using the provider's actual positive `inputUsdPer1M` and `outputUsdPer1M` prices, keyed by that exact model name. Restart the API if its environment changed.
4. Explicitly `POST /admin/model-profiles/:id/test` with `{ "version": <current version> }`. This makes a paid provider request. Only `chat`, `memory`, and `search` text profiles are supported by this test; unsupported purposes are rejected. A failed test disables the profile, including an already-enabled one. Testing claims the requested version before contacting the provider; refresh after a conflict instead of automatically retrying.
5. Read the returned/current version, then `PUT /admin/model-profiles/:id/enabled` with `{ "version": <current version>, "enabled": true, "auditReason": "enable tested local chat" }`. Enablement requires a successful test, credential and price configuration. Editing profile configuration disables it and invalidates the previous test. Refresh after any 409 version conflict.
6. `PUT /admin/characters/:id/model-bindings` with `{ "purpose": "chat", "profileId": "<profile UUID>" }`, using the printed character ID.
7. Read the character's current version via `GET /admin/characters`, then publish persona with `POST /admin/persona/:characterId`: `{ "expectedVersion": <character version>, "content": "{\"traits\":[\"温柔\",\"有主见\"]}", "auditReason": "publish local trial persona" }`.

Then start persistent chat using that same session file:

```sh
pnpm exec tsx packages/companion/src/cli/chat.ts --persistent --session-file .local/companion-profile.json
```

The private session profile is a local synthetic identity scoped to the current OS account. Persistent CLI chat uses the configured character persona and authorized memory services when those are configured. It does not enable QQ or mark terminal output as a platform delivery receipt.

For isolated persona calibration without a database or production identity, run `pnpm exec tsx packages/companion/src/cli/chat.ts --sandbox --sandbox-file .local/companion-sandbox/persona.json`. Use `/persona` to inspect the trial persona and `/persona <text>` to revise it. The sandbox writes only that separate file with private permissions; it does not load persistent history, identity, relationship, or memory services.

## Acceptance

Full offline checks require PostgreSQL 17 client tools (`pg_dump`, `pg_restore`, and `psql`) on `PATH`, a test role with permission to create/drop compatibility databases, and three isolated databases: `oh_bot_core_v2_compat`, `oh_bot_worker_compat`, and `oh_bot_integration_compat`. Set `CORE_TEST_DATABASE_URL` and `WORKER_TEST_DATABASE_URL` to the first two; the operations fixture uses the core URL's host, port, credentials and TLS settings with the third database name, and creates/removes its own temporary restore database. No named Docker container is required. Run `bash .github/codex/check.sh`; `pnpm check` alone does not run the full Companion suite.

`/health` database readiness does not prove provider connectivity or QQ delivery. `/admin/worker/status` reports queue state from PostgreSQL; its `processorConfigured` and `senderConfigured` are `null` and `workerProcessStatus` is `unobservable_from_admin_process`, because the API cannot inspect a separate worker process. Check worker logs and the actual delivery loop for runtime evidence.

The exact test-to-scenario mapping is in [acceptance-map.md](acceptance-map.md). Fixture tests do not prove real model/QQ operation. Do not describe the 55 product scenarios as all passing: live provider, QQ, restore drills, model quality, and environment-specific storage checks remain explicit gates unless accompanied by a fresh evidence record.
