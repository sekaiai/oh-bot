import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { businessOutbox, conversations, deliveryOutbox, messages, turns } from '../database/schema/index.js';
import { CompanionError } from './errors.js';

const uuidSchema = z.string().uuid();
const workerSchema = z.string().trim().min(1).max(128);
const leaseSchema = z.number().int().min(100).max(3_600_000);
const generatedContentSchema = z.object({ text: z.string().trim().min(1).max(32_000) }).passthrough();

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new CompanionError('invalid_input');
  if (ancestors.has(value)) throw new CompanionError('invalid_input');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new CompanionError('invalid_input');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new CompanionError('invalid_input');
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CompanionError('invalid_input');
    const fields = Object.keys(value as Record<string, unknown>).sort().map((key) => {
      const entry = (value as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`;
    });
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function parseGeneratedContent(value: unknown): { text: string; [key: string]: unknown } {
  const parsed = generatedContentSchema.safeParse(value);
  if (!parsed.success) throw new CompanionError('invalid_input');
  canonicalJson(parsed.data);
  return parsed.data;
}

export type TurnLease = Readonly<{
  turnId: string;
  workerId: string;
  version: number;
  expiresAt: Date;
}>;

type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export class TurnService {
  constructor(
    private readonly database: Database,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async claim(turnId: string, workerId: string, leaseMs: number): Promise<TurnLease | null> {
    this.validateClaim(turnId, workerId, leaseMs);

    return this.database.db.transaction(async (tx) => {
      const [turn] = await tx.select().from(turns)
        .where(eq(turns.id, turnId)).for('update').limit(1);
      if (!turn || !['received', 'processing'].includes(turn.status)) return null;
      const now = this.now();
      if (turn.status === 'processing' && turn.leaseExpiresAt && turn.leaseExpiresAt > now) return null;
      const expiresAt = new Date(now.getTime() + leaseMs);

      const [claimed] = await tx.update(turns).set({
        status: 'processing',
        leaseOwner: workerId,
        leaseExpiresAt: expiresAt,
        version: turn.version + 1,
        updatedAt: now,
      }).where(and(eq(turns.id, turnId), eq(turns.version, turn.version)))
        .returning({ version: turns.version });

      return claimed ? { turnId, workerId, version: claimed.version, expiresAt } : null;
    });
  }

  async renew(lease: TurnLease, leaseMs: number): Promise<TurnLease> {
    this.validateLease(lease, leaseMs);
    return this.database.db.transaction(async (tx) => {
      const [turn] = await tx.select().from(turns)
        .where(eq(turns.id, lease.turnId)).for('update').limit(1);
      if (!turn || turn.status !== 'processing' || turn.leaseOwner !== lease.workerId || turn.version !== lease.version) {
        throw new CompanionError('lease_lost');
      }
      const now = this.now();
      if (!turn.leaseExpiresAt || turn.leaseExpiresAt <= now) throw new CompanionError('lease_lost');
      const expiresAt = new Date(now.getTime() + leaseMs);
      const [renewed] = await tx.update(turns).set({
        leaseExpiresAt: expiresAt,
        version: turn.version + 1,
        updatedAt: now,
      }).where(and(
        eq(turns.id, lease.turnId),
        eq(turns.leaseOwner, lease.workerId),
        eq(turns.version, lease.version),
        gt(turns.leaseExpiresAt, now),
        eq(turns.status, 'processing'),
      )).returning({ version: turns.version });
      if (!renewed) throw new CompanionError('lease_lost');
      return { ...lease, version: renewed.version, expiresAt };
    });
  }

  async fail(lease: TurnLease, errorCode: string): Promise<void> {
    this.validateLease(lease);
    if (typeof errorCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)) {
      throw new CompanionError('invalid_input');
    }
    await this.database.db.transaction(async (tx) => {
      const [turn] = await tx.select().from(turns)
        .where(eq(turns.id, lease.turnId)).for('update').limit(1);
      if (!turn || turn.status !== 'processing' || turn.leaseOwner !== lease.workerId || turn.version !== lease.version) {
        throw new CompanionError('lease_lost');
      }
      const now = this.now();
      if (!turn.leaseExpiresAt || turn.leaseExpiresAt <= now) throw new CompanionError('lease_lost');
      const [failed] = await tx.update(turns).set({
        status: 'failed',
        errorCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        version: turn.version + 1,
        updatedAt: now,
      }).where(and(
        eq(turns.id, lease.turnId),
        eq(turns.leaseOwner, lease.workerId),
        eq(turns.version, lease.version),
        gt(turns.leaseExpiresAt, now),
        eq(turns.status, 'processing'),
      )).returning({ id: turns.id });
      if (!failed) throw new CompanionError('lease_lost');
    });
  }

  async persistGenerated(
    lease: TurnLease,
    content: { text: string; [key: string]: unknown },
  ): Promise<{ deliveryId: string; messageId: string; duplicate: boolean }> {
    this.validateLease(lease);
    const normalizedContent = parseGeneratedContent(content);

    return this.database.db.transaction(async (tx) => {
      const [turn] = await tx.select().from(turns)
        .where(eq(turns.id, lease.turnId)).for('update').limit(1);
      if (!turn) throw new CompanionError('lease_lost');

      const [existingDelivery] = await tx.select().from(deliveryOutbox)
        .where(eq(deliveryOutbox.turnId, turn.id)).limit(1);
      if (existingDelivery) {
        return this.existingGenerated(tx, turn.conversationId, turn.id, existingDelivery, normalizedContent);
      }

      const now = this.now();
      if (
        turn.status !== 'processing' ||
        turn.leaseOwner !== lease.workerId ||
        turn.version !== lease.version ||
        !turn.leaseExpiresAt ||
        turn.leaseExpiresAt <= now
      ) throw new CompanionError('lease_lost');

      const [conversation] = await tx.select().from(conversations)
        .where(eq(conversations.id, turn.conversationId)).limit(1);
      if (!conversation) throw new CompanionError('transaction_failed');

      const messageId = randomUUID();
      const deliveryId = randomUUID();
      await tx.insert(messages).values({
        id: messageId,
        conversationId: turn.conversationId,
        personId: null,
        platform: conversation.platform,
        platformEventId: `generated:${turn.id}`,
        role: 'assistant',
        text: normalizedContent.text,
        metadata: { generatedContent: normalizedContent },
      });
      await tx.insert(deliveryOutbox).values({
        id: deliveryId,
        turnId: turn.id,
        conversationId: turn.conversationId,
        operationKey: `turn:${turn.id}:deliver`,
        content: normalizedContent,
        status: 'pending',
      });
      await tx.insert(businessOutbox).values({
        operationKey: `turn:${turn.id}:deliver`,
        kind: 'deliver_message',
        payload: { turnId: turn.id, deliveryId },
      });
      await tx.update(turns).set({
        status: 'generated',
        leaseOwner: null,
        leaseExpiresAt: null,
        version: sql`${turns.version} + 1`,
        updatedAt: now,
      }).where(eq(turns.id, turn.id));

      return { deliveryId, messageId, duplicate: false };
    });
  }

  private async existingGenerated(
    tx: Transaction,
    conversationId: string,
    turnId: string,
    delivery: typeof deliveryOutbox.$inferSelect,
    content: { text: string; [key: string]: unknown },
  ): Promise<{ deliveryId: string; messageId: string; duplicate: boolean }> {
    if (canonicalJson(delivery.content) !== canonicalJson(content)) {
      throw new CompanionError('generated_conflict');
    }
    const [message] = await tx.select({ id: messages.id }).from(messages).where(and(
      eq(messages.conversationId, conversationId),
      eq(messages.platformEventId, `generated:${turnId}`),
    )).limit(1);
    if (!message) throw new CompanionError('transaction_failed');
    return { deliveryId: delivery.id, messageId: message.id, duplicate: true };
  }

  private validateClaim(turnId: string, workerId: string, leaseMs: number): void {
    this.validateLease({ turnId, workerId, version: 1, expiresAt: new Date() }, leaseMs);
  }

  private validateLease(lease: TurnLease, leaseMs?: number): void {
    if (
      !lease || !uuidSchema.safeParse(lease.turnId).success || !workerSchema.safeParse(lease.workerId).success ||
      !Number.isSafeInteger(lease.version) || lease.version < 1 ||
      (leaseMs !== undefined && !leaseSchema.safeParse(leaseMs).success)
    ) throw new CompanionError('invalid_input');
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CompanionError('invalid_clock');
    return value;
  }
}
