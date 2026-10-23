import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Database } from '../database/database.js';
import { businessOutbox, jobLogs } from '../database/schema/index.js';

const QUEUES = { process_turn: 'process', deliver_message: 'deliver' } as const;
type OutboxKind = keyof typeof QUEUES;
const safeCode = (error: unknown) => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code)) return `pg_${code.toLowerCase()}`;
  return error instanceof Error ? error.name.replace(/[^a-z0-9_]/gi, '').slice(0, 48).toLowerCase() || 'dispatch_failed' : 'dispatch_failed';
};

/** A short database claim followed by network I/O, then a fenced status update. */
export class OutboxDispatcher {
  private readonly ownerPrefix = `dispatcher-${randomUUID()}`;
  constructor(private readonly database: Database, private readonly boss: PgBoss, private readonly options: { now?: () => Date; leaseMs?: number; batchSize?: number; operationKeys?: readonly string[]; queuePrefix?: string } = {}) {}

  private queueFor(kind: string): string | undefined {
    const suffix = QUEUES[kind as OutboxKind];
    return suffix ? `${this.options.queuePrefix ?? 'companion'}.${suffix}` : undefined;
  }

  async dispatchBatch(): Promise<number> {
    const owner = `${this.ownerPrefix}:${randomUUID()}`;
    const leaseMs = this.options.leaseMs ?? 30_000;
    const batchSize = this.options.batchSize ?? 20;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('OUTBOX_OPTIONS_INVALID');
    const claimed = await this.database.db.transaction(async (tx) => {
      const ready = or(
        and(eq(businessOutbox.status, 'pending'), lte(businessOutbox.availableAt, sql`now()`)),
        and(eq(businessOutbox.status, 'leased'), lte(businessOutbox.leaseExpiresAt, sql`now()`)),
      );
      const conditions = this.options.operationKeys?.length
        ? and(ready, inArray(businessOutbox.operationKey, [...this.options.operationKeys]))
        : ready;
      const rows = await tx.select().from(businessOutbox).where(conditions).orderBy(businessOutbox.createdAt).for('update', { skipLocked: true }).limit(batchSize);
      const now = this.now();
      const expires = new Date(now.getTime() + leaseMs);
      for (const row of rows) await tx.update(businessOutbox).set({ status: 'leased', leaseOwner: owner, leaseExpiresAt: expires, attempts: row.attempts + 1, updatedAt: now }).where(and(eq(businessOutbox.id, row.id), eq(businessOutbox.status, row.status)));
      return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
    });
    for (const row of claimed) await this.dispatchOne(row, owner);
    return claimed.length;
  }

  private async dispatchOne(row: typeof businessOutbox.$inferSelect, owner: string): Promise<void> {
    const queueName = this.queueFor(row.kind);
    if (!queueName || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      await this.finishFailure(row.id, owner, row.attempts, 'invalid_job');
      return;
    }
    try {
      const pgBossId = await this.boss.send(queueName, { operationKey: row.operationKey, outboxId: row.id, kind: row.kind, payload: row.payload }, { retryLimit: 5, retryDelay: 10 });
      if (!pgBossId) throw new Error('queue_rejected');
      await this.database.db.transaction(async (tx) => {
        const [current] = await tx.select().from(businessOutbox).where(eq(businessOutbox.id, row.id)).for('update').limit(1);
        const now = this.now();
        if (!current || current.status !== 'leased' || current.leaseOwner !== owner || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return;
        const [updated] = await tx.update(businessOutbox).set({ status: 'dispatched', leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, updatedAt: now }).where(and(eq(businessOutbox.id, row.id), eq(businessOutbox.status, 'leased'), eq(businessOutbox.leaseOwner, owner), gt(businessOutbox.leaseExpiresAt, now))).returning({ id: businessOutbox.id });
        if (!updated) return;
        await tx.insert(jobLogs).values({ operationKey: row.operationKey, queueName, pgBossId, status: 'pending', attempts: 0, nextRunAt: null }).onConflictDoUpdate({
          target: jobLogs.operationKey,
          set: {
            queueName: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.queueName} else ${queueName} end`,
            pgBossId: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.pgBossId} else ${pgBossId} end`,
            status: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.status} else 'pending' end`,
            attempts: jobLogs.attempts,
            errorCode: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.errorCode} else null end`,
            nextRunAt: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.nextRunAt} else null end`,
            leaseOwner: sql`case when ${jobLogs.status} = 'running' and ${jobLogs.leaseExpiresAt} > ${now} then ${jobLogs.leaseOwner} else null end`,
            leaseExpiresAt: sql`case when ${jobLogs.status} = 'running' and ${jobLogs.leaseExpiresAt} > ${now} then ${jobLogs.leaseExpiresAt} else null end`,
            updatedAt: now,
          },
        });
      });
    } catch (error) {
      await this.finishFailure(row.id, owner, row.attempts, safeCode(error));
    }
  }

  private async finishFailure(id: string, owner: string, attempts: number, errorCode: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [current] = await tx.select().from(businessOutbox).where(eq(businessOutbox.id, id)).for('update').limit(1);
      const now = this.now();
      if (!current || current.status !== 'leased' || current.leaseOwner !== owner || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return;
      const nextRunAt = new Date(now.getTime() + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8)));
      const [row] = await tx.update(businessOutbox).set({ status: 'pending', leaseOwner: null, leaseExpiresAt: null, lastErrorCode: errorCode, availableAt: nextRunAt, updatedAt: now }).where(and(eq(businessOutbox.id, id), eq(businessOutbox.status, 'leased'), eq(businessOutbox.leaseOwner, owner), gt(businessOutbox.leaseExpiresAt, now))).returning({ operationKey: businessOutbox.operationKey, kind: businessOutbox.kind });
      if (!row) return;
      const queueName = this.queueFor(row.kind) ?? `${this.options.queuePrefix ?? 'companion'}.unknown`;
      await tx.insert(jobLogs).values({ operationKey: row.operationKey, queueName, status: 'failed', attempts: 0, errorCode, nextRunAt }).onConflictDoUpdate({
        target: jobLogs.operationKey,
        set: {
          queueName: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.queueName} else ${queueName} end`,
          status: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.status} else 'failed' end`,
          attempts: jobLogs.attempts,
          errorCode: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.errorCode} else ${errorCode} end`,
          nextRunAt: sql`case when ${jobLogs.status} in ('running', 'completed') and (${jobLogs.status} = 'completed' or ${jobLogs.leaseExpiresAt} > ${now}) then ${jobLogs.nextRunAt} else ${nextRunAt} end`,
          leaseOwner: sql`case when ${jobLogs.status} = 'running' and ${jobLogs.leaseExpiresAt} > ${now} then ${jobLogs.leaseOwner} else null end`,
          leaseExpiresAt: sql`case when ${jobLogs.status} = 'running' and ${jobLogs.leaseExpiresAt} > ${now} then ${jobLogs.leaseExpiresAt} else null end`,
          updatedAt: now,
        },
      });
    });
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('INVALID_CLOCK');
    return value;
  }
}
