import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  jsonb,
  pgSchema,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  deliveryStatuses,
  memoryStatuses,
  sourceKinds,
  turnStatuses,
  type VisibilityScope,
} from '../../domain/contracts.js';

export const companionSchema = pgSchema('companion');
export const platformEnum = companionSchema.enum('platform', ['qq', 'weixin', 'dingtalk']);
export const conversationKindEnum = companionSchema.enum('conversation_kind', ['private', 'group']);
export const personStatusEnum = companionSchema.enum('person_status', ['active', 'erased']);
export const memberRoleEnum = companionSchema.enum('member_role', ['member', 'owner']);
export const entityStatusEnum = companionSchema.enum('entity_status', ['candidate', 'confirmed', 'superseded']);
export const sourceKindEnum = companionSchema.enum('source_kind', [...sourceKinds]);
export const memoryStatusEnum = companionSchema.enum('memory_status', [...memoryStatuses]);
export const turnStatusEnum = companionSchema.enum('turn_status', [...turnStatuses]);
export const deliveryStatusEnum = companionSchema.enum('delivery_status', [...deliveryStatuses]);
export const actorKindEnum = companionSchema.enum('actor_kind', ['admin', 'person', 'system']);
export const businessOutboxStatusEnum = companionSchema.enum('business_outbox_status', ['pending', 'leased', 'dispatched', 'failed']);
export const deletionStatusEnum = companionSchema.enum('deletion_status', ['pending', 'applied']);
export const messageRoleEnum = companionSchema.enum('message_role', ['user', 'assistant', 'tool']);
export const claimKindEnum = companionSchema.enum('claim_kind', ['direct', 'reported', 'hypothetical', 'fiction', 'tool']);
export const validationStatusEnum = companionSchema.enum('validation_status', ['candidate', 'validated', 'conflict', 'rejected']);
export const memorySourceStatusEnum = companionSchema.enum('memory_source_status', ['active', 'deleted']);
export const eventStatusEnum = companionSchema.enum('event_status', ['candidate', 'confirmed', 'deleted']);
export const participationEnum = companionSchema.enum('participation', ['direct', 'reported']);
export const claimStatusEnum = companionSchema.enum('claim_status', ['candidate', 'confirmed', 'refuted', 'deleted']);
export const preferenceScopeEnum = companionSchema.enum('preference_scope', ['temporary', 'long_term']);
export const topicStatusEnum = companionSchema.enum('topic_status', ['active', 'archived', 'deleted']);
export const episodeStatusEnum = companionSchema.enum('episode_status', ['active', 'archived', 'deleted']);
export const commitmentStatusEnum = companionSchema.enum('commitment_status', ['proposed', 'scheduled', 'completed', 'cancelled', 'failed']);
export const modelPurposeEnum = companionSchema.enum('model_purpose', ['chat', 'memory', 'embedding', 'search', 'rerank']);
export const modelTestStatusEnum = companionSchema.enum('model_test_status', ['never', 'passed', 'failed']);
export const agentKindEnum = companionSchema.enum('agent_kind', ['search', 'research', 'reminder', 'workflow']);
export const agentRunStatusEnum = companionSchema.enum('agent_run_status', ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']);
export const toolPermissionEnum = companionSchema.enum('tool_permission', ['read', 'external_action']);
export const toolRunStatusEnum = companionSchema.enum('tool_run_status', ['pending', 'running', 'completed', 'failed', 'receipt_unknown']);
export const operationKeyStatusEnum = companionSchema.enum('operation_key_status', ['leased', 'completed', 'failed']);
export const jobStatusEnum = companionSchema.enum('job_status', ['pending', 'running', 'completed', 'failed', 'cancelled']);
export const migrationRecordStatusEnum = companionSchema.enum('migration_record_status', ['prepared', 'imported', 'failed']);
export const backupKindEnum = companionSchema.enum('backup_kind', ['local_export', 'offsite', 'restore_drill', 'pre_upgrade']);
export const backupStatusEnum = companionSchema.enum('backup_status', ['started', 'completed', 'failed']);
export const memoryIndexStatusEnum = companionSchema.enum('memory_index_status', ['building', 'active', 'retired']);
export const triggerModeEnum = companionSchema.enum('trigger_mode', ['mentioned', 'all', 'disabled']);
export const relationshipStageEnum = companionSchema.enum('relationship_stage', ['new', 'known', 'close', 'partner']);

export const id = () => uuid('id').primaryKey().defaultRandom();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const version = () => integer('version').notNull().default(1);
export const versionCheck = (name: string) => check(name, sql`"version" >= 1`);
export const jsonDefault = () => jsonb().notNull().default(sql`'{}'::jsonb`);
export const visibilityScopeColumn = () => jsonb('scope').$type<VisibilityScope>().notNull();
export const journalSequence = () => bigint('journal_sequence', { mode: 'bigint' });
