import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { jobLogs } from '../database/schema/index.js';

const leaseRange = { min: 100, max: 3_600_000 };
const safeErrorCode = /^[a-z][a-z0-9_]{0,63}$/;

export type JobAttemptToken = Readonly<{
  operationKey: string;
  bossId: string;
  owner: string;
  version: number;
  expiresAt: Date;
}>;

export class JobAttemptService {
  constructor(private readonly database: Database, private readonly options: { now?: () => Date } = {}) {}

  async claim(operationKey: string, bossId: string, leaseMs: number): Promise<JobAttemptToken | null> {
    this.validateIdentity(operationKey, bossId);
    this.validateLease(leaseMs);
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey)).for('update').limit(1);
      if (!row) throw new Error('invalid_job');
      const now = this.now();
      if (row.status === 'completed' || (row.status === 'running' && row.leaseOwner && row.leaseExpiresAt && row.leaseExpiresAt > now)) return null;
      const owner = randomUUID();
      const expiresAt = new Date(now.getTime() + leaseMs);
      const [claimed] = await tx.update(jobLogs).set({
        pgBossId: bossId,
        status: 'running',
        leaseOwner: owner,
        leaseExpiresAt: expiresAt,
        version: row.version + 1,
        attempts: row.attempts + 1,
        errorCode: null,
        nextRunAt: null,
        updatedAt: now,
      }).where(eq(jobLogs.id, row.id)).returning({ version: jobLogs.version });
      if (!claimed) return null;
      return { operationKey, bossId, owner, version: claimed.version, expiresAt };
    });
  }

  async renew(token: JobAttemptToken, leaseMs: number): Promise<JobAttemptToken> {
    this.validateToken(token);
    this.validateLease(leaseMs);
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(jobLogs).where(eq(jobLogs.operationKey, token.operationKey)).for('update').limit(1);
      const now = this.now();
      if (!this.matches(row, token, now)) throw new Error('attempt_lost');
      const expiresAt = new Date(now.getTime() + leaseMs);
      const version = row.version + 1;
      const [renewed] = await tx.update(jobLogs).set({ leaseExpiresAt: expiresAt, version, updatedAt: now })
        .where(and(eq(jobLogs.id, row.id), eq(jobLogs.version, token.version), eq(jobLogs.leaseOwner, token.owner), eq(jobLogs.status, 'running'), gt(jobLogs.leaseExpiresAt, now)))
        .returning({ version: jobLogs.version });
      if (!renewed) throw new Error('attempt_lost');
      return { ...token, version: renewed.version, expiresAt };
    });
  }

  async complete(token: JobAttemptToken): Promise<void> {
    await this.finish(token, 'completed');
  }

  async fail(token: JobAttemptToken, errorCode: string, nextRunAt?: Date | null): Promise<void> {
    if (!safeErrorCode.test(errorCode)) throw new Error('invalid_attempt_error');
    if (nextRunAt != null && (!(nextRunAt instanceof Date) || !Number.isFinite(nextRunAt.getTime()))) throw new Error('invalid_attempt_schedule');
    await this.finish(token, 'failed', errorCode, nextRunAt ?? null);
  }

  private async finish(token: JobAttemptToken, status: 'completed' | 'failed', errorCode: string | null = null, nextRunAt: Date | null = null): Promise<void> {
    this.validateToken(token);
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(jobLogs).where(eq(jobLogs.operationKey, token.operationKey)).for('update').limit(1);
      const now = this.now();
      if (!this.matches(row, token, now)) throw new Error('attempt_lost');
      const [updated] = await tx.update(jobLogs).set({
        status,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode,
        nextRunAt,
        version: row.version + 1,
        updatedAt: now,
      }).where(and(eq(jobLogs.id, row.id), eq(jobLogs.version, token.version), eq(jobLogs.leaseOwner, token.owner), eq(jobLogs.status, 'running'), gt(jobLogs.leaseExpiresAt, now))).returning({ id: jobLogs.id });
      if (!updated) throw new Error('attempt_lost');
    });
  }

  private matches(row: typeof jobLogs.$inferSelect | undefined, token: JobAttemptToken, now: Date): row is typeof jobLogs.$inferSelect {
    return Boolean(row && row.status === 'running' && row.leaseOwner === token.owner && row.version === token.version && row.leaseExpiresAt && row.leaseExpiresAt > now);
  }

  private validateIdentity(operationKey: string, bossId: string): void {
    if (typeof operationKey !== 'string' || !operationKey.trim() || typeof bossId !== 'string' || !bossId.trim()) throw new Error('invalid_job');
  }

  private validateToken(token: JobAttemptToken): void {
    if (!token || !Number.isSafeInteger(token.version) || token.version < 1 || typeof token.owner !== 'string' || !token.owner || typeof token.bossId !== 'string' || !token.bossId || typeof token.operationKey !== 'string' || !token.operationKey) throw new Error('invalid_attempt');
  }

  private validateLease(leaseMs: number): void {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < leaseRange.min || leaseMs > leaseRange.max) throw new Error('invalid_attempt_lease');
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('invalid_clock');
    return value;
  }
}
