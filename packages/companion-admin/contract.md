# Companion admin API contract

The UI uses `VITE_COMPANION_ADMIN_API_BASE_URL`, `Authorization: Bearer <token>`, JSON, and `credentials: omit`. The supplied login password is returned as the bearer by the companion service; the page keeps it only in memory and clears it on logout. It never uses local/session storage or cookies. The backend must independently authorize every protected request and omit secret values. UI errors and rendered row values are key-aware redacted.

The UI accepts the companion server's existing raw-array responses for characters, people, identities, model profiles, and job logs. Extension collections use `{ items, configured?, message? }`. Overview is an object, `{ health, configured, counts, queueReady }`. A `configured:false` response is shown as unavailable. Empty or malformed data is never replaced with sample rows.

## Authentication and overview

| Verb | Path | Body | Response |
|---|---|---|---|
| POST | `/admin/login` | `{ password: string }` | `{ token: string }` |
| POST | `/admin/logout` | none | `{ ok: true }` |
| GET | `/admin/overview` | none | `{ health, configured: Record<string,boolean>, counts: Record<string,number>, queueReady:boolean }` |
| GET | `/admin/operations/status` | none | `{ items: [{ capability, configured, ready }] }` |

## Characters, identities, persona, and relationships

| Verb | Path | Query/body | Response |
|---|---|---|---|
| GET | `/admin/characters` | `?limit=1..100&offset=0..1000000` | raw character array (`id`, `name`, `version`, timestamps) |
| POST | `/admin/characters` | `{ name: string(1..160) }` | created character |
| GET | `/admin/people` | `?limit=&offset=` | raw person array (`id`, `displayName`, `aliases`, `status`, `version`) |
| GET | `/admin/identities` | `?limit=&offset=` | raw verified identity array |
| GET | `/admin/characters/:id/primary-partner` | none | `{ personId: uuid | null }` |
| PUT | `/admin/characters/:id/primary-partner` | `{ personId: uuid }` | `{ ok: true }` |
| GET | `/admin/persona/:characterId` | `?version=positive integer` | `{ items: personaVersions[], configured }` |
| POST | `/admin/persona/:characterId` | `{ expectedVersion: nonnegative integer, content: string(1..16000), auditReason: string(8..1000) }` | published persona version |
| GET | `/admin/relationships` | `?personId=&characterId=&limit=&offset=` | `{ items: interactionEvents[] }` |
| POST | `/admin/relationships` | `{ personId: uuid, characterId: uuid, event: 'conversation'|'appreciation'|'shared_experience'|'boundary_respected'|'distress'|'direct_attack'|'quoted_attack'|'refusal'|'late_reply'|'delay', sourceIds: uuid[], auditReason: string(8..1000) }` | source-grounded event or explicit error |

## Memory review and deletion

| Verb | Path | Query/body | Response |
|---|---|---|---|
| GET | `/admin/memory-sources` | `?personId=&characterId=&status=&limit=&offset=` | `{ items: [{...source, sourceText}] }` |
| GET | `/admin/memory-revisions` | `?sourceId=&characterId=&status=&limit=&offset=` | `{ items: memoryRevisions[] }` |
| POST | `/admin/memory-revisions/:revisionId/approve` | `{ expectedVersion: positive integer, claimKind: 'direct', evidenceQuote: string(1..4000) }` | approved revision; strict body has no audit field |
| POST | `/admin/memory-revisions/:revisionId/correct` | `{ expectedVersion: positive integer, evidenceQuote: string(1..4000), factText: string(1..4000), auditReason: string(8..1000), confirm: true }` | corrected revision or explicit `capability_unavailable` |
| POST | `/admin/memory-revisions/:revisionId/forget` | `{ expectedVersion: positive integer, auditReason: string(8..1000), confirm: true }` | tombstone or explicit `capability_unavailable` |
| GET | `/admin/deletions` | `?status=&limit=&offset=` | `{ items: deletionRecords[] }` |
| POST | `/admin/deletions` | `{ sourceIds?: uuid[], memoryIds?: string[], scope: string, expectedVersion?: positive integer, auditReason: string(8..1000), confirm: true }` | tombstone or explicit `capability_unavailable` |

The UI obtains approval evidence from a source-grounded quote and submits exactly the approval body above. A source deletion is only posted after an audit-reason prompt and explicit confirmation; cancellation sends no mutation. The server currently reports unavailable for admin memory erasure rather than bypassing trusted-user ownership.

## Runs, models, tools, agents, and proactive actions

| Verb | Path | Query/body | Response |
|---|---|---|---|
| GET | `/admin/job-logs` | `?limit=&offset=&status=` | raw job-log array |
| GET | `/admin/turns` | `?limit=&offset=` | raw conversation-turn array |
| GET | `/admin/deliveries` | `?limit=&offset=` | raw delivery/receipt array, including explicit receipt-unknown states |
| GET | `/admin/agent-runs` | `?personId=&characterId=&status=&limit=&offset=` | `{ items: sanitizedAgentRuns[] }` |
| GET | `/admin/tool-runs` | `?toolId=&status=&limit=&offset=` | `{ items: sanitizedToolRuns[] }` |
| GET | `/admin/model-profiles` | `?limit=&offset=` | raw profiles with environment credential reference and configured flag |
| POST | `/admin/model-profiles` | `{ name, purpose, provider, baseUrl, model, credentialRef, dimensions?, maxTokens?, timeoutMs?, monthlyBudgetUsd? }` | created profile, disabled by default |
| PUT | `/admin/model-profiles/:id` | `{ version: positive integer, name, provider, baseUrl, model, credentialRef, dimensions: integer|null, maxTokens, timeoutMs, monthlyBudgetUsd: string|null }` | updated profile; server resets enabled state |
| GET | `/admin/tools` | `?limit=&offset=` | `{ items, configured, message? }` |
| PUT | `/admin/tools/:toolId` | `{ expectedVersion: positive integer, enabled, settings: { apiUrl: credential-free HTTP(S) URL, credentialRef: environment variable name }, auditReason }` | update or explicit error; secret values remain server-side |
| GET | `/admin/agents` | `?limit=&offset=` | `{ items: agentDefinitions[], configured }` |
| PUT | `/admin/agents/:agentId` | `{ expectedVersion: positive integer, enabled, settings?: {}, auditReason: string(8..1000) }` | updated agent or `version_conflict` |
| GET | `/admin/commitments` | `?personId=&characterId=&status=&limit=&offset=` | `{ items: commitments[] }` |
| POST | `/admin/commitments` | `{ personId: uuid, characterId: uuid, sourceMessageId: uuid, text: string(1..1000), dueAt: ISO datetime, scope: string(1..128), auditReason: string(8..1000) }` | source-grounded commitment or explicit error |
| GET | `/admin/proactive-permissions` | `?personId=&characterId=&limit=&offset=` | `{ items: permission policies[] }` |
| PUT | `/admin/proactive-permissions` | `{ characterId: uuid, personId?: uuid, conversationId?: uuid, scope:'person'|'group', enabled, quietStart?, quietEnd?, timeZone?, maxPerDay?, expectedVersion: positive integer, auditReason }` | saved versioned policy |

The UI keeps model profile `version` separate from agent/tool `expectedVersion`, validates each operation independently, and posts only the validated schema output. Agent settings are restricted to the currently supported empty object. Tool settings remain subject to server capability checks.

## Backup, migration, and health

| Verb | Path | Query/body | Response |
|---|---|---|---|
| GET | `/admin/backups` | `?limit=&offset=` | `{ items: [{ backupId, version: manifest SHA-256, status, ... }], configured, message? }` |
| POST | `/admin/backups` | `{ action:'create'|'verify'|'restore', backupId?: string, expectedVersion?: SHA-256 string, auditReason: string(8..1000), confirm:true }` | runner result or explicit error |
| GET | `/admin/migrations` | `?limit=&offset=` | `{ items: [{ sourceId, version: source SHA-256, status?, ... }], configured, message? }` |
| POST | `/admin/migrations` | `{ action:'inspect'|'backup'|'apply', sourceId: string, expectedVersion?: SHA-256 string, auditReason: string(8..1000), confirm:true }` | runner result or explicit error |

Every backup and migration action requests `confirm:true` after an explicit confirmation dialog. Verify/restore and migration backup/apply require the selected server record's SHA-256 version for compare-and-set; the UI does not accept manually typed backup IDs or source hashes. The list's configured and readiness state comes from the server, and actions remain available when the runner reports configured. The interface displays backend errors and never treats an unavailable operation as success.
