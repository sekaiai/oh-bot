import { sql } from 'drizzle-orm';
import { check, numeric, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { companionSchema } from './common.js';
import { modelProfiles } from './operations.js';

export const modelUsage = companionSchema.table('model_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').notNull().references(() => modelProfiles.id),
  usageMonth: text('usage_month').notNull(),
  invocationId: text('invocation_id').notNull(),
  inputHash: text('input_hash').notNull(),
  reservedUsd: numeric('reserved_usd', { precision: 18, scale: 8 }).notNull(),
  actualUsd: numeric('actual_usd', { precision: 18, scale: 8 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (table) => [
  unique('model_usage_profile_invocation_unique').on(table.profileId, table.invocationId),
  check('model_usage_month_format', sql`${table.usageMonth} ~ '^[0-9]{4}-[0-9]{2}$'`),
  check('model_usage_reserved_nonnegative', sql`${table.reservedUsd} >= 0`),
  check('model_usage_actual_nonnegative', sql`${table.actualUsd} is null or ${table.actualUsd} >= 0`),
]);
