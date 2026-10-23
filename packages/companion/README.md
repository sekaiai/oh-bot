# @oh-bot/companion

Foundation package: strict Zod input contracts, identity and conversation business tables under the isolated PostgreSQL `companion` schema, explicit Drizzle migration support, an authenticated admin API, and an independent pg-boss worker. No LangGraph processor or QQ sender is configured yet.

F2b adds transactional inbound acceptance, fenced turn leases, generated-response persistence, and delivery receipt reconciliation. `InboundService.accept(characterId, event, evidence)` authenticates the sender, detects event replay by payload fingerprint, then commits the conversation member, inbound message, received turn, and processing outbox row together. Reusing a platform event ID with changed content or another character returns `replay_conflict`.

Inbound group payloads never establish roster completeness. `createTrustedRosterEvidence` is an internal adapter helper for a roster fetched through an authenticated platform roster RPC; `InboundService.updateVerifiedRoster(platform, channelId, evidence)` replaces members only when its observation time is newer than both the last roster and the `rosterInvalidatedAt` barrier set from server receipt time. Keep that helper inside trusted gateway code. Incomplete inbound events clear the complete flag, and duplicate events do not change roster state.

`TurnService.claim/renew/fail/persistGenerated` use owner, version, and expiry fences. Generated content is stored once with one delivery row; an identical later persist returns the saved IDs, while changed content returns `generated_conflict`. `DeliveryService.claimPending/finish` moves pending sends into sending and then sent, failed, or receipt_unknown. Expired sending leases recover to receipt_unknown. Only an administrator may explicitly reconcile that state as sent or confirmed retry, with an audit row; no service claims exactly-once delivery at the platform boundary.

Service errors expose stable `code` values, including `invalid_input`, `invalid_evidence`, `replay_conflict`, `lease_lost`, `generated_conflict`, `receipt_unknown`, `invalid_state`, and `admin_required`. Callers should log the code only and must not log event text, generated content, or platform credentials.

`ActorContext` is a readonly server-created context. It is not an inbound DTO and must never be accepted as caller-authenticated identity. `Principal.kind` determines administrator capability; `actor.isPartner` records relationship state separately. Legacy messages may have an unknown `occurredAt`; `receivedAt` records their real import/receipt time. Normal inbound event timestamps remain required and validated.

## Exports

- `visibilityScopeSchema`, `inboundEventSchema`; types `VisibilityScope`, `InboundEvent`, `ActorContext`, `Principal`, `Platform`, `ConversationKind`, `SourceKind`, `MemoryStatus`, `TurnStatus`, and `DeliveryStatus`.
- `createDatabase(databaseUrl): Database`; `Database` exposes readonly `pool: pg.Pool`, `db: NodePgDatabase<typeof schema>`, and `close(): Promise<void>`.
- `loadDatabaseConfig(env)` reads only `COMPANION_DATABASE_URL` and never includes the URL in errors.
- `migrateDatabase(database)` uses Drizzle's migrator with the migration directory found from the module location and `companion_migrations` as the migration journal schema.
- `schema/index.ts` exports all business tables, enums, and `companionSchema`.

Call `db:migrate` explicitly before serving traffic. Migration files and Drizzle's journal live in `drizzle/`; production startup does not migrate automatically. Database deletion uses restrictive foreign keys, and mutable entity tables enforce `version >= 1`.

## Worker

Build with `pnpm --filter @oh-bot/companion build`; this emits the independent `dist/worker.js` entry. Set `COMPANION_DATABASE_URL` and run `pnpm --filter @oh-bot/companion start:worker` to start dispatch and consume the `companion.process` and `companion.deliver` queues. Optional `COMPANION_WORKER_QUEUE_PREFIX` selects a validated queue prefix for setup and startup; its default is `companion`. Normal startup requires an existing `companion_jobs` pg-boss schema and fails with a stable error when it is absent. For an explicit first install or upgrade, set `COMPANION_WORKER_QUEUE_SETUP=1` for one invocation; it runs pg-boss migrations in the `companion_jobs` schema and exits without starting consumers.

The worker factory accepts injected processor and sender functions for tests or a future trusted runtime adapter. The standalone entry currently has neither: it keeps turn and delivery jobs retryable and reports processor/sender failures in `job_logs`; it never pretends a generation or send succeeded. Delivery rows created with a turn are scheduled through a second outbox operation, so a generated turn remains recoverable after process restart. `receipt_unknown` is never resent automatically. Admin retry is audited and accepts safely failed or expired process/delivery attempts, including exhausted processor/sender-unavailable jobs when the business row is still received/pending. Active leases, sent deliveries, and unknown receipts are rejected; unknown receipts use explicit delivery reconciliation.

## Scripts

`pnpm --filter @oh-bot/companion typecheck`, `build`, `test`, `test:integration`, `test:health`, `test:startup`, and `db:migrate`.

Unit tests run without a database. Integration tests require explicit `CORE_TEST_DATABASE_URL`; test helpers reject a database name without `_compat`. They use synthetic random UUID data and rollback test rows. The migration preservation check deletes only its own fixture row.

Run `test` after `build` when the startup tests are included. The M1a model gateway tests need no database; run them from `packages/companion` after `pnpm install`:

```bash
pnpm exec tsx --test test/chat-endpoint.test.ts test/chat-gateway.test.ts test/chat-cli.test.ts
```

## Chat Model Gateway (M1a)

`src/models/chat-gateway.ts` is the minimal real-chat `ModelGateway`. It targets an OpenAI-compatible Chat Completions endpoint and is configured **only** from explicitly named business chat variables:

| Variable | Meaning |
| --- | --- |
| `COMPANION_CHAT_API_URL` | Base URL (with or without `/v1`) or a full `/chat/completions` endpoint |
| `COMPANION_CHAT_API_KEY` | Business chat provider key; never printed or returned |
| `COMPANION_CHAT_MODEL` | Provider model name |

Placeholder values (`<...>`, `${...}`, `change-me`, `your...`, `replace...`) are rejected so an unset secret cannot silently start a chat session. Missing, blank, placeholder, or non-HTTP(S)/credential-bearing URLs fail with the stable code `model_not_configured` or `model_invalid_config`. There is **no** fallback to coding/model-automation secrets such as `DEEPSEEK_API_KEY`, `AI_BASE_URL`, or `AI_MODEL`; those are never used for business chat. Only the explicit `messages` (plus optional `temperature`/`max_tokens`) are sent upstream — no actor, memory, or credential data is added implicitly.

`OpenAiCompatibleChatGateway.complete(request)` returns `{ text, model, finishReason, usage }` or throws `ModelGatewayError` with one of `model_not_configured`, `model_invalid_config`, `model_unauthorized`, `model_rate_limited`, `model_timeout`, `model_unreachable`, `model_invalid_response`, `model_upstream_error`. Provider error bodies are drained but never surfaced, so keys cannot leak through messages. `loadChatProviderConfig(env)` and `createChatGatewayFromEnv(env)` are exported for wiring.

### Local terminal chat (development only)

The entry point is `src/cli/chat.ts`. It is local-only, keeps conversation history in memory, and is **not** an authenticated server endpoint. Use the existing `tsx` dev dependency; no package script is added.

```bash
# 1. Export explicit business chat configuration (do not commit real keys)
export COMPANION_CHAT_API_URL="https://your-provider.example.com/v1"
export COMPANION_CHAT_API_KEY="REPLACE_WITH_REAL_BUSINESS_KEY"
export COMPANION_CHAT_MODEL="REPLACE_WITH_REAL_MODEL_ID"

# 2. Run from the repository root
pnpm exec tsx packages/companion/src/cli/chat.ts

# Optional flags
pnpm exec tsx packages/companion/src/cli/chat.ts --system "你是一个稳定的陪伴角色" \
  --temperature 0.7 --max-turns 10 --verbose
```

Type a message and press enter; `/exit` or `/quit` ends the session. Without the three variables the CLI exits with `error: model_not_configured` and does not contact any provider. Provider failures print a stable code (for example `error: model_unauthorized`) and exit non-zero.

**Verification status:** the gateway and CLI are covered by HTTP fixture tests (`test/chat-endpoint.test.ts`, `test/chat-gateway.test.ts`, `test/chat-cli.test.ts`) that use a local `node:http` server. No live provider credentials are configured in this environment, so a real third-party chat completion is **not** verified. Passing fixture tests must not be reported as live API acceptance.

### M1a limits

- History is per-process memory only; persistent, identity-scoped history is M1b.
- No persona persistence, relationship state, memory recall, tool calls, streaming, or retries belong to this task.
- The gateway does not implement LangChain/LangGraph integration; that remains F5.

## Local Chat Session and History (M1b1)

`src/conversations/chat-session-service.ts` provides `LocalChatSessionService`:

- `acceptMessage(characterId, event, evidence)` reuses `InboundService.accept` for replay protection, membership, message/turn/outbox persistence, then resolves the current `ActorContext`.
- `readHistory(characterId, evidence, { limit? })` reads only the private conversation identified by the trusted channel evidence. It resolves the person through `IdentityService.resolveActorContext` and requires a confirmed conversation membership; messages from other people are filtered out.
- Both methods accept **only** trusted in-process channel evidence created by the gateway via `createVerifiedChannelEvidence` after authenticating a platform callback. They do not accept caller-supplied `userId`, `personId`, or `ActorContext` as authorization.
- Only trusted private conversations are supported in this local MVP stage; group evidence returns `unsupported_conversation_kind`.

Example wiring (gateway code owns evidence creation):

```ts
const evidence = createVerifiedChannelEvidence('qq', channelId, platformUserId, 'private');
const accepted = await sessions.acceptMessage(characterId, inboundEvent, evidence);
const history = await sessions.readHistory(characterId, evidence, { limit: 20 });
```

Run the isolated PostgreSQL test from `packages/companion` after setting a test database whose name ends with `_compat`:

```bash
CORE_TEST_DATABASE_URL=postgres://localhost/oh_bot_core_v2_compat \
  pnpm exec tsx --test --test-concurrency=1 test/chat-session.integration.test.ts
```

The test covers two verified identities with isolated multi-turn histories, forged/cloned evidence, forged `ActorContext`, caller-supplied person/user claims, foreign-person message filtering, duplicate-event idempotency, and replay conflicts. It requires a real PostgreSQL database; no live model or QQ connection is used. M1b1 does not add a CLI, network service, or package script.

