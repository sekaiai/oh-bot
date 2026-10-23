import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, integer, jsonb, numeric, primaryKey, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agentKindEnum, agentRunStatusEnum, backupKindEnum, backupStatusEnum, commitmentStatusEnum, companionSchema, createdAt, episodeStatusEnum, id, jobStatusEnum, migrationRecordStatusEnum, modelPurposeEnum, modelTestStatusEnum, operationKeyStatusEnum, preferenceScopeEnum, relationshipStageEnum, topicStatusEnum, toolPermissionEnum, toolRunStatusEnum, triggerModeEnum, updatedAt, version, versionCheck, visibilityScopeColumn } from './common.js';
import { characters, people } from './identity.js';
import { conversations, messages, turns } from './timeline.js';
import { memorySources } from './memory.js';

export const emotionStates = companionSchema.table('emotion_states', {
  characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').notNull().references(() => people.id), pleasantness: real('pleasantness').notNull().default(0), activity: real('activity').notNull().default(0.5), tension: real('tension').notNull().default(0), care: real('care').notNull().default(0.5), lastEventAt: timestamp('last_event_at',{withTimezone:true}), updatedAt: updatedAt(), version: version(),
}, (t) => [primaryKey({columns:[t.characterId,t.personId]}), check('emotion_pleasantness_range',sql`${t.pleasantness} between -1 and 1`), check('emotion_activity_range',sql`${t.activity} between 0 and 1`), check('emotion_tension_range',sql`${t.tension} between 0 and 1`), check('emotion_care_range',sql`${t.care} between 0 and 1`), versionCheck('emotion_states_version_positive')]);

export const relationshipStates = companionSchema.table('relationship_states', {
  characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').notNull().references(() => people.id), familiarity: real('familiarity').notNull().default(0), trust: real('trust').notNull().default(0), stage: relationshipStageEnum('stage').notNull().default('new'), boundaries: jsonb('boundaries').notNull().default(sql`'[]'::jsonb`), tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`), lastEventAt: timestamp('last_event_at',{withTimezone:true}), updatedAt: updatedAt(), version: version(),
}, (t) => [primaryKey({columns:[t.characterId,t.personId]}), check('relationship_familiarity_range',sql`${t.familiarity} between 0 and 1`), check('relationship_trust_range',sql`${t.trust} between 0 and 1`), versionCheck('relationship_states_version_positive')]);

export const interactionEvents = companionSchema.table('interaction_events', {
  id: id(), eventKey: text('event_key').notNull().unique(), characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').notNull().references(() => people.id), sourceMessageId: uuid('source_message_id').references(() => messages.id), kind: text('kind').notNull(), payload: jsonb('payload').notNull(), appliedAt: timestamp('applied_at',{withTimezone:true}), createdAt: createdAt(),
});

export const interactionPreferences = companionSchema.table('interaction_preferences', {
  characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').notNull().references(() => people.id), preferences: jsonb('preferences').notNull(), scope: preferenceScopeEnum('scope').notNull(), expiresAt: timestamp('expires_at',{withTimezone:true}), sourceMessageId: uuid('source_message_id').notNull().references(() => messages.id), updatedAt: updatedAt(), version: version(),
}, (t) => [primaryKey({columns:[t.characterId,t.personId]}), versionCheck('interaction_preferences_version_positive')]);

export const topics = companionSchema.table('topics', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), name: text('name').notNull(), aliases: text('aliases').array().notNull().default(sql`ARRAY[]::text[]`), scope: visibilityScopeColumn(), sourceIds: uuid('source_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), status: topicStatusEnum('status').notNull().default('active'), createdAt: createdAt(), version: version(),
}, (t) => [versionCheck('topics_version_positive')]);

export const episodes = companionSchema.table('episodes', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), topicId: uuid('topic_id').references(() => topics.id), summary: text('summary'), sourceIds: uuid('source_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), scope: visibilityScopeColumn(), startedAt: timestamp('started_at',{withTimezone:true}).notNull(), endedAt: timestamp('ended_at',{withTimezone:true}), status: episodeStatusEnum('status').notNull().default('active'), createdAt: createdAt(), version: version(),
}, (t) => [versionCheck('episodes_version_positive')]);

export const commitments = companionSchema.table('commitments', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').notNull().references(() => people.id), conversationId: uuid('conversation_id').notNull().references(() => conversations.id), description: text('description'), sourceMessageId: uuid('source_message_id').notNull().references(() => messages.id), dueAt: timestamp('due_at',{withTimezone:true}), status: commitmentStatusEnum('status').notNull().default('proposed'), jobId: text('job_id'), operationKey: text('operation_key').notNull().unique(), createdAt: createdAt(), updatedAt: updatedAt(), version: version(),
}, (t) => [versionCheck('commitments_version_positive')]);

export const proactivePermissions = companionSchema.table('proactive_permissions', {
  characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').notNull().references(() => people.id), enabled: boolean('enabled').notNull().default(false), quietStart: text('quiet_start').notNull().default('22:00'), quietEnd: text('quiet_end').notNull().default('08:00'), timeZone: text('time_zone').notNull().default('Asia/Shanghai'), maxPerDay: integer('max_per_day').notNull().default(1), updatedAt: updatedAt(), version: version(),
}, (t) => [primaryKey({columns:[t.characterId,t.personId]}), check('proactive_permissions_max_per_day_nonnegative',sql`${t.maxPerDay} >= 0`), versionCheck('proactive_permissions_version_positive')]);

export const conversationPolicies = companionSchema.table('conversation_policies', {
  conversationId: uuid('conversation_id').primaryKey().references(() => conversations.id), triggerMode: triggerModeEnum('trigger_mode').notNull().default('mentioned'), circleDisclosureVerified: boolean('circle_disclosure_verified').notNull().default(false), proactiveEnabled: boolean('proactive_enabled').notNull().default(false), quietStart: text('quiet_start').notNull().default('22:00'), quietEnd: text('quiet_end').notNull().default('08:00'), timeZone: text('time_zone').notNull().default('Asia/Shanghai'), maxPerDay: integer('max_per_day').notNull().default(1), updatedAt: updatedAt(), version: version(),
}, (t) => [check('conversation_policies_max_per_day_nonnegative',sql`${t.maxPerDay} >= 0`), versionCheck('conversation_policies_version_positive')]);

export const modelProfiles = companionSchema.table('model_profiles', {
  id: id(), name: text('name').notNull().unique(), purpose: modelPurposeEnum('purpose').notNull(), provider: text('provider').notNull(), baseUrl: text('base_url').notNull(), model: text('model').notNull(), credentialRef: text('credential_ref').notNull(), dimensions: integer('dimensions'), enabled: boolean('enabled').notNull().default(false), maxTokens: integer('max_tokens').notNull().default(1024), timeoutMs: integer('timeout_ms').notNull().default(30000), monthlyBudgetUsd: numeric('monthly_budget_usd'), lastTestAt: timestamp('last_test_at',{withTimezone:true}), lastTestStatus: modelTestStatusEnum('last_test_status').notNull().default('never'), createdAt: createdAt(), updatedAt: updatedAt(), version: version(),
}, (t) => [unique('model_profiles_id_purpose_unique').on(t.id,t.purpose), check('model_profiles_dimensions_positive',sql`${t.dimensions} is null or ${t.dimensions} > 0`), check('model_profiles_max_tokens_positive',sql`${t.maxTokens} > 0`), check('model_profiles_timeout_positive',sql`${t.timeoutMs} > 0`), versionCheck('model_profiles_version_positive')]);

export const modelRoleBindings = companionSchema.table('model_role_bindings', {
  characterId: uuid('character_id').notNull().references(() => characters.id), purpose: modelPurposeEnum('purpose').notNull(), profileId: uuid('profile_id').notNull(),
}, (t) => [primaryKey({columns:[t.characterId,t.purpose]}), foreignKey({name:'model_role_bindings_profile_purpose_fk',columns:[t.profileId,t.purpose],foreignColumns:[modelProfiles.id,modelProfiles.purpose]})]);

export const agentDefinitions = companionSchema.table('agent_definitions', {
  id: id(), name: text('name').notNull().unique(), kind: agentKindEnum('kind').notNull(), enabled: boolean('enabled').notNull().default(false), description: text('description').notNull(), inputSchema: jsonb('input_schema').notNull(), outputSchema: jsonb('output_schema').notNull(), toolNames: text('tool_names').array().notNull().default(sql`ARRAY[]::text[]`), modelProfileId: uuid('model_profile_id').references(() => modelProfiles.id), permissions: text('permissions').array().notNull().default(sql`ARRAY[]::text[]`), budget: jsonb('budget').notNull(), createdAt: createdAt(), version: version(),
}, (t) => [versionCheck('agent_definitions_version_positive')]);

export const agentRuns = companionSchema.table('agent_runs', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), personId: uuid('person_id').references(() => people.id), conversationId: uuid('conversation_id').references(() => conversations.id), definitionId: uuid('definition_id').references(() => agentDefinitions.id), parentRunId: uuid('parent_run_id'), turnId: uuid('turn_id').references(() => turns.id), graphVersion: text('graph_version').notNull(), threadId: text('thread_id').notNull(), status: agentRunStatusEnum('status').notNull().default('queued'), task: jsonb('task').notNull(), budget: jsonb('budget').notNull(), usage: jsonb('usage').notNull().default(sql`'{}'::jsonb`), result: jsonb('result'), cancelRequested: boolean('cancel_requested').notNull().default(false), errorCode: text('error_code'), leaseExpiresAt: timestamp('lease_expires_at',{withTimezone:true}), createdAt: createdAt(), updatedAt: updatedAt(), version: version(),
}, (t) => [foreignKey({name:'agent_runs_parent_fk',columns:[t.parentRunId],foreignColumns:[t.id]}), versionCheck('agent_runs_version_positive')]);

export const toolRuns = companionSchema.table('tool_runs', {
  id: id(), agentRunId: uuid('agent_run_id').references(() => agentRuns.id), turnId: uuid('turn_id').notNull().references(() => turns.id), name: text('name').notNull(), operationKey: text('operation_key').notNull().unique(), permission: toolPermissionEnum('permission').notNull(), status: toolRunStatusEnum('status').notNull().default('pending'), inputHash: text('input_hash').notNull(), result: jsonb('result'), sources: jsonb('sources').notNull().default(sql`'[]'::jsonb`), usage: jsonb('usage').notNull().default(sql`'{}'::jsonb`), errorCode: text('error_code'), createdAt: createdAt(), updatedAt: updatedAt(), version: version(),
}, (t) => [versionCheck('tool_runs_version_positive')]);

export const operationKeys = companionSchema.table('operation_keys', {
  key: text('key').primaryKey(), kind: text('kind').notNull(), status: operationKeyStatusEnum('status').notNull(), leaseOwner: text('lease_owner'), leaseExpiresAt: timestamp('lease_expires_at',{withTimezone:true}), resultRef: text('result_ref'), createdAt: createdAt(), updatedAt: updatedAt(), version: version(),
}, (t) => [versionCheck('operation_keys_version_positive')]);

export const jobLogs = companionSchema.table('job_logs', {
  id: id(), operationKey: text('operation_key').notNull().unique(), queueName: text('queue_name').notNull(), pgBossId: text('pg_boss_id'), status: jobStatusEnum('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0), errorCode: text('error_code'), nextRunAt: timestamp('next_run_at',{withTimezone:true}), leaseOwner: text('lease_owner'), leaseExpiresAt: timestamp('lease_expires_at',{withTimezone:true}), version: version(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [versionCheck('job_logs_version_positive')]);

export const migrationRecords = companionSchema.table('migration_records', {
  id: id(), sourceHash: text('source_hash').notNull().unique(), sourcePath: text('source_path').notNull(), backupManifestPath: text('backup_manifest_path').notNull(), status: migrationRecordStatusEnum('status').notNull(), counts: jsonb('counts').notNull(), errorCode: text('error_code'), createdAt: createdAt(), completedAt: timestamp('completed_at',{withTimezone:true}),
});

export const backupRecords = companionSchema.table('backup_records', {
  id: id(), kind: backupKindEnum('kind').notNull(), status: backupStatusEnum('status').notNull(), manifestPath: text('manifest_path'), counts: jsonb('counts').notNull().default(sql`'{}'::jsonb`), deletionJournalSequence: bigint('deletion_journal_sequence',{mode:'bigint'}), errorCode: text('error_code'), createdAt: createdAt(), completedAt: timestamp('completed_at',{withTimezone:true}),
});

export const mediaObjects = companionSchema.table('media_objects', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), sha256: text('sha256').notNull().unique(), relativePath: text('relative_path').notNull(), mimeType: text('mime_type').notNull(), sizeBytes: bigint('size_bytes',{mode:'bigint'}).notNull(), scope: visibilityScopeColumn(), sourceMessageId: uuid('source_message_id').references(() => messages.id), deletedAt: timestamp('deleted_at',{withTimezone:true}), createdAt: createdAt(),
});
