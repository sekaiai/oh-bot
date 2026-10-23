import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  companionSchema,
  createdAt,
  entityStatusEnum,
  id,
  memberRoleEnum,
  personStatusEnum,
  platformEnum,
  updatedAt,
  version,
  versionCheck,
} from './common.js';
import { messages } from './timeline.js';

export const people = companionSchema.table('people', {
  id: id(),
  displayName: text('display_name'),
  aliases: text('aliases').array().notNull().default(sql`ARRAY[]::text[]`),
  status: personStatusEnum('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
}, (table) => [versionCheck('people_version_positive')]);

export const platformIdentities = companionSchema.table('platform_identities', {
  id: id(),
  personId: uuid('person_id').notNull().references(() => people.id),
  platform: platformEnum('platform').notNull(),
  platformUserId: text('platform_user_id').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationMethod: text('verification_method').notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique('platform_identity_platform_user_unique').on(table.platform, table.platformUserId),
  index('platform_identity_person_idx').on(table.personId),
]);

export const characters = companionSchema.table('characters', {
  id: id(),
  name: text('name').notNull(),
  currentVersionId: uuid('current_version_id'),
  createdAt: createdAt(),
  version: version(),
}, (table) => [
  versionCheck('characters_version_positive'),
  foreignKey({
    name: 'characters_current_version_fk',
    columns: [table.id, table.currentVersionId],
    foreignColumns: [characterVersions.characterId, characterVersions.id],
  }),
]);

export const characterVersions = companionSchema.table('character_versions', {
  id: id(),
  characterId: uuid('character_id').notNull().references((): AnyPgColumn => characters.id),
  revision: integer('revision').notNull(),
  core: jsonb('core').notNull(),
  createdAt: createdAt(),
  createdBy: text('created_by').notNull(),
}, (table) => [
  unique('character_versions_character_revision_unique').on(table.characterId, table.revision),
  unique('character_versions_character_id_id_unique').on(table.characterId, table.id),
]);

export const primaryRelationshipBindings = companionSchema.table('primary_relationship_bindings', {
  id: id(),
  characterId: uuid('character_id').notNull().references(() => characters.id),
  personId: uuid('person_id').notNull().references(() => people.id),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique('primary_binding_character_unique').on(table.characterId),
  index('primary_binding_person_idx').on(table.personId),
]);

export const bindingChallenges = companionSchema.table('binding_challenges', {
  id: id(),
  personId: uuid('person_id').notNull().references(() => people.id),
  sourceIdentityId: uuid('source_identity_id').notNull().references(() => platformIdentities.id),
  targetPlatform: platformEnum('target_platform').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const socialCircles = companionSchema.table('social_circles', {
  id: id(),
  characterId: uuid('character_id').notNull().references(() => characters.id),
  name: text('name').notNull(),
  createdAt: createdAt(),
  version: version(),
}, (table) => [
  versionCheck('social_circles_version_positive'),
  index('social_circles_character_idx').on(table.characterId),
]);

export const circleMembers = companionSchema.table('circle_members', {
  circleId: uuid('circle_id').notNull().references(() => socialCircles.id),
  personId: uuid('person_id').notNull().references(() => people.id),
  role: memberRoleEnum('role').notNull().default('member'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.circleId, table.personId] }),
  index('circle_members_person_idx').on(table.personId),
]);

export const personEntities = companionSchema.table('person_entities', {
  id: id(),
  characterId: uuid('character_id').notNull().references(() => characters.id),
  personId: uuid('person_id').references(() => people.id),
  displayName: text('display_name').notNull(),
  aliases: text('aliases').array().notNull().default(sql`ARRAY[]::text[]`),
  confirmed: boolean('confirmed').notNull().default(false),
  createdAt: createdAt(),
  version: version(),
}, (table) => [
  versionCheck('person_entities_version_positive'),
  index('person_entities_character_idx').on(table.characterId),
]);

export const relationshipEdges = companionSchema.table('relationship_edges', {
  id: id(),
  characterId: uuid('character_id').notNull().references(() => characters.id),
  subjectEntityId: uuid('subject_entity_id').notNull().references(() => personEntities.id),
  objectEntityId: uuid('object_entity_id').notNull().references(() => personEntities.id),
  kind: text('kind').notNull(),
  status: entityStatusEnum('status').notNull().default('candidate'),
  sourceMessageId: uuid('source_message_id').references(() => messages.id),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  createdAt: createdAt(),
  version: version(),
}, (table) => [
  versionCheck('relationship_edges_version_positive'),
  index('relationship_edges_character_idx').on(table.characterId),
]);
