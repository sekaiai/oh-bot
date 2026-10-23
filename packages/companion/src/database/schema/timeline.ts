import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  actorKindEnum,
  businessOutboxStatusEnum,
  companionSchema,
  conversationKindEnum,
  createdAt,
  deliveryStatusEnum,
  deletionStatusEnum,
  id,
  messageRoleEnum,
  platformEnum,
  turnStatusEnum,
  updatedAt,
  version,
  versionCheck,
  visibilityScopeColumn,
} from './common.js';
import { characters, people, socialCircles } from './identity.js';

export const conversations = companionSchema.table('conversations', {
  id: id(),
  characterId: uuid('character_id').notNull().references(() => characters.id),
  platform: platformEnum('platform').notNull(),
  platformConversationId: text('platform_conversation_id').notNull(),
  kind: conversationKindEnum('kind').notNull(),
  circleId: uuid('circle_id').references(() => socialCircles.id),
  participantsComplete: boolean('participants_complete').notNull().default(false),
  rosterObservedAt: timestamp('roster_observed_at', { withTimezone: true }),
  rosterInvalidatedAt: timestamp('roster_invalidated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
}, (table) => [
  unique('conversations_identity_unique').on(
    table.characterId,
    table.platform,
    table.platformConversationId,
    table.kind,
  ),
  index('conversations_character_idx').on(table.characterId),
  versionCheck('conversations_version_positive'),
]);

export const conversationMembers = companionSchema.table('conversation_members', {
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  personId: uuid('person_id').notNull().references(() => people.id),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.personId] }),
  index('conversation_members_person_idx').on(table.personId),
]);

export const messages = companionSchema.table('messages', {
  id: id(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  personId: uuid('person_id').references(() => people.id),
  platform: platformEnum('platform').notNull(),
  platformEventId: text('platform_event_id').notNull(),
  role: messageRoleEnum('role').notNull(),
  text: text('text'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
}, (table) => [
  unique('messages_platform_event_unique').on(table.platform, table.platformEventId),
  index('messages_conversation_occurred_idx').on(table.conversationId, table.occurredAt),
  index('messages_person_idx').on(table.personId),
]);

export const turns = companionSchema.table('turns', {
  id: id(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  inboundMessageId: uuid('inbound_message_id').notNull().unique().references(() => messages.id),
  personId: uuid('person_id').notNull().references(() => people.id),
  status: turnStatusEnum('status').notNull().default('received'),
  graphThreadId: text('graph_thread_id').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  version: version(),
  errorCode: text('error_code'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  versionCheck('turns_version_positive'),
  index('turns_status_lease_idx').on(table.status, table.leaseExpiresAt),
]);

export const businessOutbox = companionSchema.table('business_outbox', {
  id: id(),
  operationKey: text('operation_key').notNull().unique(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  status: businessOutboxStatusEnum('status').notNull().default('pending'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  lastErrorCode: text('last_error_code'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index('business_outbox_dispatch_idx').on(table.status, table.availableAt)]);

export const deliveryOutbox = companionSchema.table('delivery_outbox', {
  id: id(),
  turnId: uuid('turn_id').notNull().unique().references(() => turns.id),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  operationKey: text('operation_key').notNull().unique(),
  content: jsonb('content').notNull(),
  status: deliveryStatusEnum('status').notNull().default('pending'),
  platformReceipt: text('platform_receipt'),
  attempts: integer('attempts').notNull().default(0),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  errorCode: text('error_code'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
}, (table) => [
  versionCheck('delivery_outbox_version_positive'),
  index('delivery_outbox_status_idx').on(table.status, table.leaseExpiresAt),
]);

export const auditEvents = companionSchema.table('audit_events', {
  id: id(),
  actorKind: actorKindEnum('actor_kind').notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetId: text('target_id'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (table) => [index('audit_events_target_idx').on(table.targetId, table.createdAt)]);

export const deletionRecords = companionSchema.table('deletion_records', {
  id: id(),
  characterId: uuid('character_id').notNull().references(() => characters.id),
  personId: uuid('person_id').references(() => people.id),
  scope: visibilityScopeColumn(),
  sourceIds: uuid('source_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
  memoryIds: text('memory_ids').array().notNull().default(sql`ARRAY[]::text[]`),
  operationKey: text('operation_key').notNull().unique(),
  status: deletionStatusEnum('status').notNull().default('pending'),
  journalSequence: bigint('journal_sequence', { mode: 'bigint' }),
  createdAt: createdAt(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
}, (table) => [index('deletion_records_person_idx').on(table.personId, table.createdAt)]);
