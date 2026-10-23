# Compatibility persistence probes

This package checks Mem0 OSS and LangGraph's real PostgresSaver against an explicitly isolated PostgreSQL/pgvector database and a persistent SQLite memory history file. `test` and `test:cli` run without external services. `test:integration` requires explicit `COMPAT_DATABASE_URL` and `COMPAT_HISTORY_PATH`; it rejects database names that do not end in `_compat` and does not skip missing configuration.

The protocol fixture is a test-only local HTTP server implementing OpenAI-compatible chat completions and embeddings. It is not a model service or a production fallback. Chat and embedding endpoints, credentials, model names, and dimensions remain explicit configuration; this interface can point at OpenAI-compatible providers such as DeepSeek and Alibaba Bailian, but this probe does not claim those providers were tested. The fixture verifies that Mem0 sends the configured embedding `dimensions` and `encoding_format: float` and receives vectors with the requested length. No live provider is called unless `COMPAT_MODE=live-api` is explicitly selected with caller-supplied values for every config key.

Mem0's public API has no close/dispose method. Each operation therefore runs in a short-lived child process, prints one structured result after awaiting SDK calls, then exits so the operating system closes SDK-held connections. This is a test harness lifecycle strategy; production shutdown still needs a designed lifecycle.

Memory scope filters here test SDK metadata filtering only. They do not implement authorization or prove end-to-end privacy. DELETE keeps the SDK's SQLite history log; it does not erase all historical source text and is not a user-forget workflow.

Example fixture integration run:

```sh
COMPAT_DATABASE_URL='postgresql://compat:compat-test-only@127.0.0.1:55432/oh_bot_compat' \
COMPAT_HISTORY_PATH="$PWD/packages/compatibility/.state/memory-history.sqlite" \
pnpm --filter @oh-bot/compatibility test:integration
```

## Whole compatibility CLI

Set these keys explicitly in the shell (or copy `.env.example` to a private file and fill every blank). No default provider, model, or credential is supplied. `protocol-fixture` uses the test HTTP server; `live-api` sends real provider requests and must only be selected with configured endpoints, keys, model names, and embedding dimensions.

```sh
export COMPAT_MODE=protocol-fixture
export COMPAT_DATABASE_URL='postgresql://compat:compat-test-only@127.0.0.1:55432/oh_bot_compat'
export COMPAT_HISTORY_PATH="$PWD/packages/compatibility/.state/memory-history.sqlite"
export COMPAT_CHAT_BASE_URL='http://127.0.0.1:1/v1'
export COMPAT_CHAT_API_KEY='fixture-only'
export COMPAT_CHAT_MODEL='fixture-chat'
export COMPAT_EMBEDDING_BASE_URL='http://127.0.0.1:1/v1'
export COMPAT_EMBEDDING_API_KEY='fixture-only'
export COMPAT_EMBEDDING_MODEL='fixture-embedding'
export COMPAT_EMBEDDING_DIMENSIONS=8
pnpm --filter @oh-bot/compatibility exec tsx src/run.ts
```

The CLI runs memory and graph probes and writes `.state/compatibility-manifest.json` beside the configured state directory. Output includes only mode, check names/status, SDK versions, and the manifest path. It does not print database URLs, credentials, prompts, or provider error bodies. If a live config value is absent, it exits nonzero and names only the missing environment key.

After restarting PostgreSQL while retaining its volume, verify the pre-existing manifest without reseeding:

```sh
docker restart oh-bot-compat-db
pnpm --filter @oh-bot/compatibility exec tsx src/run.ts --verify "$PWD/packages/compatibility/.state/compatibility-manifest.json"
```

The optional `compose.yaml` pins pgvector/PostgreSQL 17 by digest, binds only `127.0.0.1:55432`, and uses the persistent `oh-bot-compat-pgdata` volume. The current workspace may already have `oh-bot-compat-db` running on that port; in that case use the existing container and do not start a second one. Never use `docker compose down -v` for this volume.

The integration test leaves sentinel state in the ignored `.state` directory. CLI verification reads the existing Mem0 3.3.1 pgvector row and SQLite `memory_history` through a versioned read-only adapter; it does not construct `Memory`, because that SDK constructor creates a missing collection. The adapter checks the installed SDK version and expected schema before querying, uses parameterized values, allows only `compat_memories_` identifiers, opens SQLite with `readonly` and `fileMustExist`, and uses PostgreSQL `default_transaction_read_only=on`. Graph verification uses the real PostgresSaver read path without calling `setup()`, and its pool is also forced read-only. A missing collection or checkpoint fails verification without creating tables, migrations, rows, or files. New-process recovery with the Mem0 SDK itself remains covered by the Task 2a integration test; this CLI read-only adapter is specifically for restart verification.

Graph validation checks that a node interrupted after node1 resumes under a new PostgresSaver, node1's unique execution counter remains exactly one, checkpoint values persist, and another thread stays empty. The combined CLI manifest is local state and uses permissions 0600.

Run probes serially when they share a state directory, or use a separate directory per concurrent run. The current memory manifest filename is shared within that directory; concurrent probes can overwrite each other’s recovery manifest.
