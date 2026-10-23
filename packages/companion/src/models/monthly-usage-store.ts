import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { modelProfiles, modelUsage } from '../database/schema/index.js';

export type MonthlyUsageKey = Readonly<{ profileId: string; month: string; invocationId: string }>;
export type MonthlyUsageReservation =
  | { kind: 'execute' }
  | { kind: 'unknown' };

export interface MonthlyUsageStore {
  reserve(input: MonthlyUsageKey & { amountUsd: number; inputHash: string }): Promise<MonthlyUsageReservation>;
  settle(input: MonthlyUsageKey & { actualUsd: number }): Promise<{ overReserved: boolean }>;
}

function validKey(input: MonthlyUsageKey): void {
  if (
    !/^[0-9a-f-]{36}$/i.test(input.profileId) || !/^\d{4}-\d{2}$/.test(input.month) ||
    !input.invocationId.trim() || input.invocationId.length > 512
  ) throw new Error('model_usage_invalid_key');
}

function positiveAmount(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('model_cost_unavailable');
}

function roundUpUsd(value: number): number {
  positiveAmount(value);
  return Math.ceil(value * 100_000_000) / 100_000_000;
}

/** Serializes monthly reservations on the profile row; uncertain calls stay reserved. */
export class PostgresMonthlyUsageStore implements MonthlyUsageStore {
  constructor(private readonly database: Database) {}

  async reserve(input: MonthlyUsageKey & { amountUsd: number; inputHash: string }): Promise<MonthlyUsageReservation> {
    validKey(input);
    if (!/^[0-9a-f]{64}$/i.test(input.inputHash)) throw new Error('model_usage_invalid_key');
    const amountUsd = roundUpUsd(input.amountUsd);
    return this.database.db.transaction(async (transaction) => {
      const [profile] = await transaction.select({ monthlyBudgetUsd: modelProfiles.monthlyBudgetUsd })
        .from(modelProfiles).where(eq(modelProfiles.id, input.profileId)).for('update').limit(1);
      if (!profile || profile.monthlyBudgetUsd == null) throw new Error('model_monthly_budget_unavailable');

      const [existing] = await transaction.select({
        actualUsd: modelUsage.actualUsd,
        reservedUsd: modelUsage.reservedUsd,
        inputHash: modelUsage.inputHash,
      }).from(modelUsage).where(and(
        eq(modelUsage.profileId, input.profileId),
        eq(modelUsage.invocationId, input.invocationId),
      )).limit(1);
      if (existing) {
        if (existing.inputHash !== input.inputHash || Number(existing.reservedUsd) !== amountUsd) {
          throw new Error('model_usage_invocation_conflict');
        }
        return { kind: 'unknown' };
      }

      const [aggregate] = await transaction.select({
        usedUsd: sql<string>`coalesce(sum(coalesce(${modelUsage.actualUsd}, ${modelUsage.reservedUsd})), 0)`,
      }).from(modelUsage).where(and(
        eq(modelUsage.profileId, input.profileId),
        eq(modelUsage.usageMonth, input.month),
      ));
      const usedUsd = Number(aggregate?.usedUsd ?? 0);
      const monthlyLimit = Number(profile.monthlyBudgetUsd);
      if (!Number.isFinite(monthlyLimit) || monthlyLimit < 0 || usedUsd + amountUsd > monthlyLimit) {
        throw new Error('model_monthly_budget_exceeded');
      }
      await transaction.insert(modelUsage).values({
        profileId: input.profileId,
        usageMonth: input.month,
        invocationId: input.invocationId,
        inputHash: input.inputHash,
        reservedUsd: amountUsd.toFixed(8),
      });
      return { kind: 'execute' };
    });
  }

  async settle(input: MonthlyUsageKey & { actualUsd: number }): Promise<{ overReserved: boolean }> {
    validKey(input);
    const actualUsd = roundUpUsd(input.actualUsd);
    return this.database.db.transaction(async (transaction) => {
      await transaction.select({ id: modelProfiles.id }).from(modelProfiles)
        .where(eq(modelProfiles.id, input.profileId)).for('update').limit(1);
      const [row] = await transaction.select({
        actualUsd: modelUsage.actualUsd,
        reservedUsd: modelUsage.reservedUsd,
      }).from(modelUsage).where(and(
        eq(modelUsage.profileId, input.profileId),
        eq(modelUsage.invocationId, input.invocationId),
      )).for('update').limit(1);
      if (!row) throw new Error('model_usage_reservation_missing');
      if (row.actualUsd != null) {
        if (Number(row.actualUsd) !== actualUsd) throw new Error('model_usage_settlement_conflict');
        return { overReserved: actualUsd > Number(row.reservedUsd) };
      }
      await transaction.update(modelUsage).set({
        actualUsd: actualUsd.toFixed(8),
        settledAt: new Date(),
      }).where(and(
        eq(modelUsage.profileId, input.profileId),
        eq(modelUsage.invocationId, input.invocationId),
      ));
      return { overReserved: actualUsd > Number(row.reservedUsd) };
    });
  }
}
