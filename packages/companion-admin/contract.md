# Companion admin API contract

The frontend uses an independent API origin (`VITE_COMPANION_ADMIN_API_BASE_URL`), JSON requests, and `Authorization: Bearer <token>`. It sends `credentials: omit`; the bearer exists only in page memory. All protected responses must be JSON and must omit credentials, raw provider secrets, and unredacted secret-bearing errors. Lists use `{ items: object[], configured?: boolean, message?: string }`. Empty arrays are real empty results. `configured:false` means the capability is unavailable and should be explained, never represented as data.

## Authentication and overview

| Verb | Path | Body / query | Response |
|---|---|---|---|
| POST | `/admin/login` | `{ password: string }` | `{ token: string, expiresAt?: string }` |
| POST | `/admin/logout` | none | `{ ok: true }` |
| GET | `/admin/overview` | none | `{ health: string, configured: Record<string, boolean>, counts: Record<string, number>, updatedAt?: string }` |
| GET | `/admin/operations/status` | none | list envelope; health and readiness checks |

## Identity, persona, and relationship

| Verb | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/identities` | `?personId=&platform=&limit=&cursor=` | list envelope; verified platform bindings and character directory |
| GET | `/admin/persona/:characterId` | `?version=` | list envelope of persona versions, plus `configured` when unavailable |
| POST | `/admin/persona/:characterId` | `{ expectedVersion, content, auditReason }` | new immutable version |
| GET | `/admin/relationships` | `?personId=&characterId=&scope=&limit=&cursor=` | list envelope of evidence-backed events |
| POST | `/admin/relationships` | `{ personId, characterId, event, sourceIds, expectedVersion, auditReason }` | versioned event or conflict |

## Memory review and deletion

| Verb | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/memory-sources` | `?status=&scope=&personId=&limit=&cursor=` | list envelope; source text and authorization scope |
| GET | `/admin/memory-revisions` | `?status=&sourceId=&limit=&cursor=` | list envelope; candidates and revision history |
| POST | `/admin/memory-revisions` | `{ sourceId, action: 'approve'|'correct'|'reject', correction?, expectedVersion, auditReason }` | revision and durable job state |
| POST | `/admin/memory-revisions/:revisionId/approve` | `{ expectedVersion, auditReason }` | approval/job status |
| POST | `/admin/memory-revisions/:revisionId/reject` | `{ expectedVersion, auditReason }` | rejected revision |
| POST | `/admin/memory-revisions/:revisionId/forget` | `{ expectedVersion, auditReason }` | tombstone and deletion job status |
| GET | `/admin/deletions` | `?status=&limit=&cursor=` | list envelope of deletion journal and replay status |
| POST | `/admin/deletions` | `{ sourceIds?, memoryIds?, scope, expectedVersion?, auditReason, confirm: true }` | tombstone and cleanup job status |

## Jobs, models, tools, and proactive settings

| Verb | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/agent-runs` | `?status=&personId=&limit=&cursor=` | list envelope; sanitized graph runs |
| GET | `/admin/tool-runs` | `?status=&toolId=&limit=&cursor=` | list envelope; arguments/results follow server redaction policy |
| GET | `/admin/jobs` | `?status=&kind=&limit=&cursor=` | list envelope; durable job state |
| GET | `/admin/model-profiles` | none | list envelope; secret references are names/availability only |
| PUT | `/admin/model-profiles/:profileId` | `{ expectedVersion, label, provider, model, endpoint?, secretRef, enabled, auditReason }` | saved profile, with no secret value |
| GET | `/admin/tools` | none | list envelope of tool registry and readiness |
| GET | `/admin/tools/:toolId` | none | `{ id, version, enabled, settings }` |
| PUT | `/admin/tools/:toolId` | `{ expectedVersion, enabled, settings, auditReason }` | tool configuration |
| GET | `/admin/agents` | none | list envelope of agent registry and readiness |
| GET | `/admin/agents/:agentId` | none | `{ id, version, enabled, settings }` |
| PUT | `/admin/agents/:agentId` | `{ expectedVersion, enabled, settings, auditReason }` | agent configuration |
| GET | `/admin/commitments` | `?status=&personId=&limit=&cursor=` | list envelope of persisted reminders and receipts |
| POST | `/admin/commitments` | `{ personId, characterId, text, dueAt, scope, expectedVersion?, auditReason }` | persisted commitment |
| GET | `/admin/proactive-permissions` | `?personId=&scope=` | list envelope of separate person/group permissions and quiet hours |
| PUT | `/admin/proactive-permissions` | `{ personId, scope, enabled, quietHours?, expectedVersion, auditReason }` | saved authorization state |

## Backup, migration, health

| Verb | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/backups` | `?limit=&cursor=` | list envelope; backup presence, coverage and verification |
| POST | `/admin/backups` | `{ action:'create'|'verify'|'restore', backupId?, expectedVersion?, auditReason, confirm? }` | job status; create/restore only when server config permits |
| GET | `/admin/migrations` | `?limit=&cursor=` | list envelope of migration plans and outcomes |
| POST | `/admin/migrations` | `{ action:'inspect'|'backup'|'apply', sourceId?, expectedVersion?, auditReason, confirm? }` | plan/job; apply only when server config permits |

All writes require authentication, server-side authorization, input validation, an audit reason, and compare-and-set version checks when a versioned record is changed. Destructive and external operations require server configuration and explicit confirmation fields, then remain disabled or return a clear unavailable response when the environment has not enabled them. The UI confirmation dialog is an additional safeguard, not an authorization boundary.
