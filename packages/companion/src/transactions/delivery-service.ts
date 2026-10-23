import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { auditEvents, businessOutbox, deliveryOutbox, jobLogs, turns } from '../database/schema/index.js';
import { CompanionError } from './errors.js';

const uuidSchema = z.string().uuid();
const workerSchema = z.string().trim().min(1).max(128);
const leaseSchema = z.number().int().min(100).max(3_600_000);
const errorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export type DeliveryToken = Readonly<{
  deliveryId: string;
  workerId: string;
  version: number;
  expiresAt: Date;
}>;

export type DeliveryResult =
  | { kind: 'receipt'; receipt: string }
  | { kind: 'not_sent'; errorCode: string }
  | { kind: 'unknown'; errorCode: string };

export class DeliveryService {
  constructor(
    private readonly database: Database,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async claimPending(deliveryId: string, workerId: string, leaseMs: number): Promise<DeliveryToken | null> {
    this.validateClaim(deliveryId, workerId, leaseMs);

    return this.database.db.transaction(async (tx) => {
      const [delivery] = await tx.select().from(deliveryOutbox).where(and(
        eq(deliveryOutbox.id, deliveryId),
        eq(deliveryOutbox.status, 'pending'),
      )).for('update').limit(1);
      if (!delivery) return null;
      const now = this.now();
      const expiresAt = new Date(now.getTime() + leaseMs);

      const [claimed] = await tx.update(deliveryOutbox).set({
        status: 'sending',
        attempts: delivery.attempts + 1,
        leaseOwner: workerId,
        leaseExpiresAt: expiresAt,
        version: delivery.version + 1,
        updatedAt: now,
      }).where(and(
        eq(deliveryOutbox.id, deliveryId),
        eq(deliveryOutbox.version, delivery.version),
      )).returning({ version: deliveryOutbox.version });

      return claimed ? { deliveryId, workerId, version: claimed.version, expiresAt } : null;
    });
  }

  async finish(token: DeliveryToken, result: DeliveryResult): Promise<void> {
    this.validateToken(token);
    this.validateResult(result);

    await this.database.db.transaction(async (tx) => {
      const [delivery] = await tx.select().from(deliveryOutbox).where(and(
        eq(deliveryOutbox.id, token.deliveryId),
        eq(deliveryOutbox.status, 'sending'),
        eq(deliveryOutbox.leaseOwner, token.workerId),
        eq(deliveryOutbox.version, token.version),
      )).for('update').limit(1);
      if (!delivery) throw new CompanionError('lease_lost');
      const now = this.now();
      if (!delivery.leaseExpiresAt || delivery.leaseExpiresAt <= now) throw new CompanionError('lease_lost');

      const status = result.kind === 'receipt' ? 'sent' : result.kind === 'not_sent' ? 'failed' : 'receipt_unknown';
      await tx.update(deliveryOutbox).set({
        status,
        platformReceipt: result.kind === 'receipt' ? result.receipt : null,
        errorCode: result.kind === 'receipt' ? null : result.errorCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        version: sql`${deliveryOutbox.version} + 1`,
        updatedAt: now,
      }).where(eq(deliveryOutbox.id, delivery.id));
      await tx.update(turns).set({
        status: status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'receipt_unknown',
        errorCode: result.kind === 'receipt' ? null : result.errorCode,
        version: sql`${turns.version} + 1`,
        updatedAt: now,
      }).where(eq(turns.id, delivery.turnId));
    });
  }

  async recoverExpiredSending(): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      const expired = await tx.select({
        id: deliveryOutbox.id,
        turnId: deliveryOutbox.turnId,
        leaseExpiresAt: deliveryOutbox.leaseExpiresAt,
      })
        .from(deliveryOutbox).where(eq(deliveryOutbox.status, 'sending')).for('update');
      const now = this.now();
      const timedOut = expired.filter((delivery) => !delivery.leaseExpiresAt || delivery.leaseExpiresAt <= now);

      for (const delivery of timedOut) {
        await tx.update(deliveryOutbox).set({
          status: 'receipt_unknown',
          errorCode: 'receipt_unknown',
          leaseOwner: null,
          leaseExpiresAt: null,
          version: sql`${deliveryOutbox.version} + 1`,
          updatedAt: now,
        }).where(eq(deliveryOutbox.id, delivery.id));
        await tx.update(turns).set({
          status: 'receipt_unknown',
          errorCode: 'receipt_unknown',
          version: sql`${turns.version} + 1`,
          updatedAt: now,
        }).where(eq(turns.id, delivery.turnId));
      }
      return timedOut.length;
    });
  }

  async reconcile(
    deliveryId: string,
    decision: 'sent' | 'retry',
    principal: { kind: 'admin'; auditActorId: string } | { kind: 'person'; actor: unknown },
    receipt?: string,
  ): Promise<void> {
    if (principal?.kind !== 'admin' || !principal.auditActorId.trim()) {
      throw new CompanionError('admin_required');
    }
    if (!uuidSchema.safeParse(deliveryId).success || !['sent', 'retry'].includes(decision)) {
      throw new CompanionError('invalid_input');
    }
    if (decision === 'sent' && (!receipt || receipt.length > 512 || !receipt.trim())) {
      throw new CompanionError('invalid_input');
    }

    const now = this.now();
    await this.database.db.transaction(async (tx) => {
      const [delivery] = await tx.select().from(deliveryOutbox).where(and(
        eq(deliveryOutbox.id, deliveryId),
        eq(deliveryOutbox.status, 'receipt_unknown'),
      )).for('update').limit(1);
      if (!delivery) throw new CompanionError('invalid_state');

      const status = decision === 'sent' ? 'sent' : 'pending';
      await tx.update(deliveryOutbox).set({
        status,
        platformReceipt: decision === 'sent' ? receipt : null,
        errorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        version: sql`${deliveryOutbox.version} + 1`,
        updatedAt: now,
      }).where(eq(deliveryOutbox.id, deliveryId));
      await tx.update(turns).set({
        status: decision === 'sent' ? 'sent' : 'generated',
        errorCode: null,
        version: sql`${turns.version} + 1`,
        updatedAt: now,
      }).where(eq(turns.id, delivery.turnId));
      const operationKey = `turn:${delivery.turnId}:deliver`;
      await tx.update(businessOutbox).set({
        status: decision === 'retry' ? 'pending' : 'dispatched',
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: now,
        lastErrorCode: null,
        updatedAt: now,
      }).where(eq(businessOutbox.operationKey, operationKey));
      await tx.update(jobLogs).set({
        status: decision === 'retry' ? 'pending' : 'completed',
        errorCode: null,
        nextRunAt: decision === 'retry' ? now : null,
        updatedAt: now,
      }).where(eq(jobLogs.operationKey, operationKey));
      await tx.insert(auditEvents).values({
        actorKind: 'admin',
        actorId: principal.auditActorId,
        action: 'delivery_reconciled',
        targetId: deliveryId,
        metadata: { decision },
      });
    });
  }

  private validateClaim(deliveryId: string, workerId: string, leaseMs: number): void {
    if (!uuidSchema.safeParse(deliveryId).success || !workerSchema.safeParse(workerId).success || !leaseSchema.safeParse(leaseMs).success) {
      throw new CompanionError('invalid_input');
    }
  }

  private validateToken(token: DeliveryToken): void {
    if (
      !token || !uuidSchema.safeParse(token.deliveryId).success || !workerSchema.safeParse(token.workerId).success ||
      !Number.isSafeInteger(token.version) || token.version < 1 ||
      !(token.expiresAt instanceof Date) || !Number.isFinite(token.expiresAt.getTime())
    ) throw new CompanionError('invalid_input');
  }

  private validateResult(result: DeliveryResult): void {
    if (!result || !['receipt', 'not_sent', 'unknown'].includes(result.kind)) throw new CompanionError('invalid_input');
    if (result.kind === 'receipt' && (!result.receipt?.trim() || result.receipt.length > 512)) throw new CompanionError('invalid_input');
    if (result.kind !== 'receipt' && !errorCodeSchema.safeParse(result.errorCode).success) throw new CompanionError('invalid_input');
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CompanionError('invalid_clock');
    return value;
  }
}
