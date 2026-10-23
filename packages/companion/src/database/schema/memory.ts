import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { claimKindEnum, claimStatusEnum, companionSchema, createdAt, eventStatusEnum, id, memoryIndexStatusEnum, memorySourceStatusEnum, memoryStatusEnum, participationEnum, sourceKindEnum, validationStatusEnum, version, versionCheck, visibilityScopeColumn } from './common.js';
import { characters, people, personEntities, bindingChallenges } from './identity.js';
import { conversations, messages } from './timeline.js';
import { modelProfiles } from './operations.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const memorySources = companionSchema.table('memory_sources', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id),
  personId: uuid('person_id').references(() => people.id), conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  messageId: uuid('message_id').notNull().references(() => messages.id), sourceKind: sourceKindEnum('source_kind').notNull(),
  batchKey: text('batch_key').notNull().unique(), scope: visibilityScopeColumn(), subjectPersonIds: uuid('subject_person_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
  speakerPersonId: uuid('speaker_person_id').references(() => people.id), participantPersonIds: uuid('participant_person_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
  claimKind: claimKindEnum('claim_kind').notNull(), allowedForExtraction: boolean('allowed_for_extraction').notNull().default(false),
  status: memorySourceStatusEnum('status').notNull().default('active'), createdAt: createdAt(), deletedAt: timestamp('deleted_at',{withTimezone:true}),
}, (t) => [index('memory_sources_character_created_idx').on(t.characterId,t.createdAt)]);

export const memoryValidationRecords = companionSchema.table('memory_validation_records', {
  id: id(), sourceId: uuid('source_id').notNull().references(() => memorySources.id), engineMemoryId: text('engine_memory_id'),
  status: validationStatusEnum('status').notNull(),
  subjectPersonIds: uuid('subject_person_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), evidenceMessageIds: uuid('evidence_message_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
  reasonCode: text('reason_code'), evidenceQuote: text('evidence_quote'), createdAt: createdAt(),
});

export const memoryRevisions = companionSchema.table('memory_revisions', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), canonicalKey: text('canonical_key').notNull(), revision: integer('revision').notNull(),
  sourceId: uuid('source_id').notNull().references(() => memorySources.id), engineMemoryId: text('engine_memory_id'), factText: text('fact_text'),
  scope: visibilityScopeColumn(), subjectPersonIds: uuid('subject_person_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), status: memoryStatusEnum('status').notNull(),
  validFrom: timestamp('valid_from',{withTimezone:true}).notNull(), validTo: timestamp('valid_to',{withTimezone:true}), supersedesId: uuid('supersedes_id'), createdAt: createdAt(), version: version(),
}, (t) => [unique('memory_revision_number_unique').on(t.characterId,t.canonicalKey,t.revision), uniqueIndex('memory_revision_current_validated_unique').on(t.characterId,t.canonicalKey).where(sql`"status" = 'validated' AND "valid_to" IS NULL`), check('memory_revisions_revision_positive',sql`${t.revision} >= 1`), versionCheck('memory_revisions_version_positive'), foreignKey({name:'memory_revisions_supersedes_fk',columns:[t.supersedesId],foreignColumns:[t.id]} )]);

export const memoryIndexes = companionSchema.table('memory_indexes', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), modelProfileId: uuid('model_profile_id').notNull().references(() => modelProfiles.id), provider: text('provider').notNull(), model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(), preprocessingVersion: text('preprocessing_version').notNull(), collectionName: text('collection_name').notNull().unique(), status: memoryIndexStatusEnum('status').notNull().default('building'),
  createdAt: createdAt(), activatedAt: timestamp('activated_at',{withTimezone:true}),
}, (t) => [check('memory_indexes_dimensions_range',sql`${t.dimensions} between 1 and 16000`), uniqueIndex('memory_indexes_one_active_per_character').on(t.characterId).where(sql`"status" = 'active'`)]);

export const memoryMappings = companionSchema.table('memory_mappings', {
  id: id(), operationKey: text('operation_key').notNull(), engineMemoryId: text('engine_memory_id').notNull(), revisionId: uuid('revision_id').notNull().references(() => memoryRevisions.id), indexId: uuid('index_id').notNull().references(() => memoryIndexes.id), createdAt: createdAt(),
}, (t) => [unique('memory_mappings_engine_id_unique').on(t.engineMemoryId), unique('memory_mappings_operation_engine_unique').on(t.operationKey,t.engineMemoryId)]);

export const personIdentityLinks = companionSchema.table('person_identity_links', {
  aliasPersonId: uuid('alias_person_id').primaryKey().references(() => people.id), canonicalPersonId: uuid('canonical_person_id').notNull().references(() => people.id), proofChallengeId: uuid('proof_challenge_id').references(() => bindingChallenges.id), createdAt: createdAt(),
}, (t) => [check('person_identity_links_distinct_people',sql`${t.aliasPersonId} <> ${t.canonicalPersonId}`)]);

export const sharedEvents = companionSchema.table('shared_events', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), title: text('title').notNull(), summary: text('summary'), status: eventStatusEnum('status').notNull().default('candidate'),
  sourceMessageIds: uuid('source_message_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), scope: visibilityScopeColumn(), occurredAt: timestamp('occurred_at',{withTimezone:true}).notNull(), createdAt: createdAt(), version: version(),
}, (t) => [versionCheck('shared_events_version_positive')]);

export const eventParticipants = companionSchema.table('event_participants', {
  eventId: uuid('event_id').notNull().references(() => sharedEvents.id), personId: uuid('person_id').notNull().references(() => people.id), participation: participationEnum('participation').notNull(), createdAt: createdAt(),
}, (t) => [primaryKey({columns:[t.eventId,t.personId]})]);

export const knowledgeClaims = companionSchema.table('knowledge_claims', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), subjectEntityId: uuid('subject_entity_id').references(() => personEntities.id), speakerPersonId: uuid('speaker_person_id').references(() => people.id), sourceId: uuid('source_id').notNull().references(() => memorySources.id),
  claimText: text('claim_text'), status: claimStatusEnum('status').notNull().default('candidate'), scope: visibilityScopeColumn(), validFrom: timestamp('valid_from',{withTimezone:true}).notNull(), validTo: timestamp('valid_to',{withTimezone:true}), createdAt: createdAt(), version: version(),
}, (t) => [versionCheck('knowledge_claims_version_positive')]);

export const disclosureRules = companionSchema.table('disclosure_rules', {
  id: id(), characterId: uuid('character_id').notNull().references(() => characters.id), sourceId: uuid('source_id').references(() => memorySources.id), claimId: uuid('claim_id').references(() => knowledgeClaims.id), scope: visibilityScopeColumn(),
  allowedPersonIds: uuid('allowed_person_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), deniedPersonIds: uuid('denied_person_ids').array().notNull().default(sql`ARRAY[]::uuid[]`), createdAt: createdAt(), version: version(),
}, (t) => [versionCheck('disclosure_rules_version_positive')]);
