import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, like, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import {
  auditEvents, commitments, conversationMembers, conversationPolicies, conversations, deliveryOutbox, messages,
  operationKeys, people, platformIdentities, proactivePermissions,
} from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';
import { isAuthenticatedAdminPrincipal, type AuthenticatedAdminPrincipal } from '../admin/auth.js';
import { isTrustedActorContext } from '../identity/trust.js';
import { canonicalPersonId, currentLinkedPersonIds, requireCurrentActor } from '../persona/current-actor.js';

type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
const uuidSchema = z.string().uuid();
const workerSchema = z.string().trim().min(1).max(128);
const leaseSchema = z.number().int().min(1_000).max(60 * 60_000);
const errorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const receiptSchema = z.string().trim().min(1).max(512);
const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('receipt'), receipt: receiptSchema }).strict(),
  z.object({ kind: z.literal('not_sent'), errorCode: errorCodeSchema }).strict(),
  z.object({ kind: z.literal('receipt_unknown'), errorCode: errorCodeSchema }).strict(),
]);
export type ProactiveResult = z.infer<typeof resultSchema>;
export type ProactiveDelivery = (input: { operationKey: string; personId: string; conversationId: string; description: string }) => Promise<unknown>;
export type ProactiveDeliveryOutcome = 'sent' | 'failed' | 'receipt_unknown' | 'not_due' | 'not_authorized' | 'quiet_window' | 'quota' | 'already_claimed';
type Claim = { item: typeof commitments.$inferSelect; operationKey: string; fence: number; owner: string; reservationKeys: string[] };

export class ProactiveCommitmentService {
  constructor(private readonly database: Database, private readonly now: () => Date = () => new Date()) {}

  async schedule(actor: ActorContext, sourceMessageId: string, input: { description: string; dueAt: Date }): Promise<typeof commitments.$inferSelect> {
    this.assertActor(actor);
    if (!uuidSchema.safeParse(sourceMessageId).success || !input?.description?.trim() || input.description.length > 1_000 || !(input.dueAt instanceof Date) || !Number.isFinite(input.dueAt.getTime()) || input.dueAt <= this.clock()) {
      throw new Error('explicit future due time and description required');
    }
    return this.database.db.transaction(async (tx) => {
      const current = await requireCurrentActor(tx, actor);
      const [source] = await tx.select({ id: messages.id, personId: messages.personId, text: messages.text, deletedAt: messages.deletedAt }).from(messages).where(and(
        eq(messages.id, sourceMessageId), eq(messages.role, 'user'), eq(messages.conversationId, current.conversation.id),
      )).limit(1);
      if (!source?.personId || source.text === null || source.deletedAt || await canonicalPersonId(tx, source.personId) !== current.personId) throw new Error('source message unavailable');
      const [permission] = await tx.select().from(proactivePermissions).where(and(
        eq(proactivePermissions.characterId, actor.characterId), eq(proactivePermissions.personId, current.personId),
      )).limit(1);
      if (!permission?.enabled) throw new Error('person proactive permission disabled');
      if (current.conversation.kind === 'group') {
        const [policy] = await tx.select().from(conversationPolicies).where(eq(conversationPolicies.conversationId, current.conversation.id)).limit(1);
        if (!policy?.proactiveEnabled) throw new Error('group proactive permission disabled');
      }
      const operationKey = `commitment:${sourceMessageId}:${current.personId}`;
      const [row] = await tx.insert(commitments).values({
        characterId: actor.characterId, personId: current.personId, conversationId: current.conversation.id,
        description: input.description.trim(), sourceMessageId, dueAt: input.dueAt, status: 'scheduled', operationKey,
      }).onConflictDoNothing({ target: commitments.operationKey }).returning();
      const [commitment] = row ? [row] : await tx.select().from(commitments).where(eq(commitments.operationKey, operationKey)).limit(1);
      if (!commitment) throw new Error('commitment persistence failed');
      if (row) await tx.insert(auditEvents).values({ actorKind: 'person', actorId: current.personId, action: 'proactive_commitment_scheduled', targetId: row.id, metadata: { dueAt: input.dueAt.toISOString(), sourceMessageId } });
      return commitment;
    });
  }

  async deliverDue(commitmentId: string, delivery: ProactiveDelivery, workerId = `proactive-${randomUUID()}`, leaseMs = 30_000): Promise<ProactiveDeliveryOutcome> {
    if (!uuidSchema.safeParse(commitmentId).success || !workerSchema.safeParse(workerId).success || !leaseSchema.safeParse(leaseMs).success) throw new Error('invalid proactive delivery claim');
    const claim = await this.claim(commitmentId, workerId, leaseMs);
    if ('outcome' in claim) return claim.outcome;

    // Membership, canonical identity and both opt-ins are checked again after the claim commits, directly before dispatch.
    if (!await this.reauthorizeBeforeDispatch(claim.value)) {
      await this.finish(claim.value, { kind: 'not_sent', errorCode: 'authorization_revoked' });
      return 'not_authorized';
    }

    let result: ProactiveResult;
    try {
      const raw = await delivery({
        operationKey: claim.value.operationKey, personId: claim.value.item.personId,
        conversationId: claim.value.item.conversationId, description: claim.value.item.description ?? '',
      });
      const parsed = resultSchema.safeParse(raw);
      result = parsed.success ? parsed.data : { kind: 'receipt_unknown', errorCode: 'invalid_delivery_result' };
    } catch {
      result = { kind: 'receipt_unknown', errorCode: 'receipt_unknown' };
    }
    const finished = await this.finish(claim.value, result);
    if (!finished) return 'receipt_unknown';
    return result.kind === 'receipt' ? 'sent' : result.kind === 'not_sent' ? 'failed' : 'receipt_unknown';
  }

  /** Recheck a claimed commitment at the transport boundary after its outbox row was read. */
  async validateStandaloneDelivery(deliveryId: string): Promise<boolean> {
    if (!uuidSchema.safeParse(deliveryId).success) return false;
    return this.database.db.transaction(async (tx) => {
      const [delivery] = await tx.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, deliveryId)).limit(1);
      if (!delivery || delivery.turnId !== null || delivery.status !== 'sending') return false;
      const [item] = await tx.select().from(commitments).where(eq(commitments.operationKey, delivery.operationKey)).limit(1);
      const content = delivery.content && typeof delivery.content === 'object' ? (delivery.content as { text?: unknown }).text : undefined;
      if (!item || item.status !== 'scheduled' || !item.jobId?.startsWith('sending:') || item.conversationId !== delivery.conversationId || content !== item.description) return false;
      const fence = Number(item.jobId.slice('sending:'.length));
      if (!Number.isSafeInteger(fence) || fence < 1) return false;
      const [operation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, deliveryKey(item.id))).limit(1);
      if (!operation || operation.kind !== 'proactive_delivery' || operation.status !== 'leased' || operation.version !== fence || operation.resultRef !== 'dispatching' || !operation.leaseExpiresAt || operation.leaseExpiresAt <= this.clock()) return false;
      return Boolean(await this.authorizeCommitment(tx, item));
    });
  }

  async recoverExpiredClaims(): Promise<number> {
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const candidates = await tx.select().from(operationKeys).where(and(
        eq(operationKeys.kind, 'proactive_delivery'), eq(operationKeys.status, 'leased'), isNotNull(operationKeys.leaseExpiresAt),
        lt(operationKeys.leaseExpiresAt, now), eq(operationKeys.resultRef, 'dispatching'),
      ));
      let recovered = 0;
      for (const candidate of candidates) {
        const commitmentId = commitmentIdFromDeliveryKey(candidate.key);
        const [item] = commitmentId ? await tx.select().from(commitments).where(eq(commitments.id, commitmentId)).for('update').limit(1) : [];
        const [operation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, candidate.key)).for('update').limit(1);
        if (!operation || operation.status !== 'leased' || operation.resultRef !== 'dispatching' || operation.version !== candidate.version || !operation.leaseExpiresAt || operation.leaseExpiresAt > now) continue;
        recovered++;
        await tx.update(operationKeys).set({ resultRef: 'receipt_unknown:worker_expired', leaseOwner: null, leaseExpiresAt: null, updatedAt: now, version: operation.version + 1 }).where(and(
          eq(operationKeys.key, operation.key), eq(operationKeys.version, operation.version), eq(operationKeys.status, 'leased'),
        ));
        if (item?.jobId === `sending:${operation.version}`) {
          await tx.update(commitments).set({ status: 'failed', jobId: 'receipt_unknown', updatedAt: now, version: item.version + 1 }).where(and(eq(commitments.id, item.id), eq(commitments.version, item.version)));
          await tx.insert(auditEvents).values({ actorKind: 'system', action: 'proactive_receipt_unknown', targetId: item.id, metadata: { reason: 'worker_expired', operationKey: operation.key } });
        }
      }
      return recovered;
    });
  }

  async retryNotSent(commitmentId: string, principal: AuthenticatedAdminPrincipal): Promise<boolean> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new Error('authenticated admin required');
    if (!uuidSchema.safeParse(commitmentId).success) throw new Error('invalid commitment');
    return this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId)).for('update').limit(1);
      if (!item || item.status !== 'failed' || !item.jobId?.startsWith('not_sent:')) return false;
      const [operation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, deliveryKey(item.id))).for('update').limit(1);
      if (!operation || operation.status !== 'failed' || !operation.resultRef?.startsWith('not_sent:')) return false;
      const now = this.clock();
      await tx.update(commitments).set({ status: 'scheduled', jobId: null, updatedAt: now, version: item.version + 1 }).where(and(eq(commitments.id, item.id), eq(commitments.version, item.version)));
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: 'proactive_not_sent_retry_authorized', targetId: item.id, metadata: { operationKey: operation.key } });
      return true;
    });
  }

  async reschedule(commitmentId: string, input: { dueAt: Date; description?: string }, principal: AuthenticatedAdminPrincipal): Promise<void> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new Error('authenticated admin required');
    if (!uuidSchema.safeParse(commitmentId).success || !(input?.dueAt instanceof Date) || !Number.isFinite(input.dueAt.getTime()) || input.dueAt <= this.clock() || (input.description !== undefined && (!input.description.trim() || input.description.length > 1_000))) throw new Error('valid future commitment update required');
    await this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId)).for('update').limit(1);
      if (!item || item.status !== 'scheduled' || item.jobId) throw new Error('editable scheduled commitment required');
      const now = this.clock();
      await tx.update(commitments).set({ dueAt: input.dueAt, ...(input.description === undefined ? {} : { description: input.description.trim() }), updatedAt: now, version: item.version + 1 }).where(and(eq(commitments.id, item.id), eq(commitments.version, item.version)));
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: 'proactive_commitment_rescheduled', targetId: item.id, metadata: { dueAt: input.dueAt.toISOString(), descriptionChanged: input.description !== undefined } });
    });
  }

  async cancel(commitmentId: string, principal: AuthenticatedAdminPrincipal): Promise<void> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new Error('authenticated admin required');
    if (!uuidSchema.safeParse(commitmentId).success) throw new Error('invalid commitment');
    await this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId)).for('update').limit(1);
      if (!item || item.status !== 'scheduled' || item.jobId) throw new Error('cancellable scheduled commitment required');
      const now = this.clock();
      await tx.update(commitments).set({ status: 'cancelled', updatedAt: now, version: item.version + 1 }).where(and(eq(commitments.id, item.id), eq(commitments.version, item.version)));
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: 'proactive_commitment_cancelled', targetId: item.id, metadata: { operationKey: item.operationKey } });
    });
  }

  async reconcile(commitmentId: string, decision: 'sent' | 'not_sent', principal: AuthenticatedAdminPrincipal, receipt?: string): Promise<void> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new Error('authenticated admin required');
    if (!uuidSchema.safeParse(commitmentId).success || !['sent', 'not_sent'].includes(decision)) throw new Error('invalid reconciliation');
    if (decision === 'sent' && !receiptSchema.safeParse(receipt).success) throw new Error('valid receipt required');
    await this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId)).for('update').limit(1);
      const [operation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, deliveryKey(commitmentId))).for('update').limit(1);
      if (!item || item.jobId !== 'receipt_unknown' || !operation || operation.status !== 'leased' || !operation.resultRef?.startsWith('receipt_unknown:')) throw new Error('receipt_unknown state required');
      const now = this.clock();
      await tx.update(operationKeys).set({
        status: decision === 'sent' ? 'completed' : 'failed', resultRef: decision === 'sent' ? `receipt:${receipt}` : 'not_sent:admin_reconciled',
        leaseOwner: null, leaseExpiresAt: null, updatedAt: now, version: operation.version + 1,
      }).where(and(eq(operationKeys.key, operation.key), eq(operationKeys.version, operation.version)));
      await this.reconcileReservationKeys(tx, item.id, decision === 'sent' ? 'completed' : 'failed', now);
      await tx.update(commitments).set({ status: decision === 'sent' ? 'completed' : 'failed', jobId: decision === 'sent' ? `receipt:${receipt}` : 'not_sent:admin_reconciled', updatedAt: now, version: item.version + 1 }).where(and(eq(commitments.id, item.id), eq(commitments.version, item.version)));
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: 'proactive_receipt_reconciled', targetId: item.id, metadata: { decision, receipt: decision === 'sent' ? receipt : null, operationKey: operation.key } });
    });
  }

  private async claim(commitmentId: string, workerId: string, leaseMs: number): Promise<{ outcome: ProactiveDeliveryOutcome } | { value: Claim }> {
    return this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId)).for('update').limit(1);
      if (!item || item.status !== 'scheduled' || item.jobId) return { outcome: item?.jobId === 'receipt_unknown' ? 'receipt_unknown' : 'already_claimed' };
      const now = this.clock();
      if (!item.dueAt || item.dueAt > now) return { outcome: 'not_due' };
      const authorized = await this.authorizeCommitment(tx, item);
      if (!authorized) return { outcome: 'not_authorized' };
      const { permission, policy } = authorized;
      if (this.isQuiet(now, permission.quietStart, permission.quietEnd, permission.timeZone) || (policy && this.isQuiet(now, policy.quietStart, policy.quietEnd, policy.timeZone))) return { outcome: 'quiet_window' };
      const reservations = this.reservationScopes(item, permission, policy, now);
      for (const lockKey of [...new Set(reservations.map((reservation) => reservation.lockKey))].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      for (const reservation of reservations) {
        const rows = await tx.select({ status: operationKeys.status }).from(operationKeys).where(and(
          like(operationKeys.key, `${reservation.keyPrefix}%`), inArray(operationKeys.status, ['leased', 'completed']),
        ));
        if (rows.length >= reservation.maximum) return { outcome: 'quota' };
      }

      const operationKey = deliveryKey(item.id);
      const [priorOperation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, operationKey)).for('update').limit(1);
      if (priorOperation && priorOperation.status !== 'failed') return { outcome: priorOperation.resultRef?.startsWith('receipt_unknown:') ? 'receipt_unknown' : 'already_claimed' };
      const fence = (priorOperation?.version ?? 0) + 1;
      const expiresAt = new Date(now.getTime() + leaseMs);
      const reservationKeys = reservations.map((reservation) => `${reservation.keyPrefix}${item.id}`);
      const resultRef = JSON.stringify({ state: 'dispatching', reservationKeys });
      if (priorOperation) await tx.update(operationKeys).set({ kind: 'proactive_delivery', status: 'leased', leaseOwner: workerId, leaseExpiresAt: expiresAt, resultRef: 'dispatching', updatedAt: now, version: fence }).where(and(eq(operationKeys.key, operationKey), eq(operationKeys.version, priorOperation.version)));
      else await tx.insert(operationKeys).values({ key: operationKey, kind: 'proactive_delivery', status: 'leased', leaseOwner: workerId, leaseExpiresAt: expiresAt, resultRef: 'dispatching', version: fence, updatedAt: now });
      for (let index = 0; index < reservations.length; index++) {
        const reservationKey = reservationKeys[index]!;
        const [priorReservation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, reservationKey)).for('update').limit(1);
        if (priorReservation) {
          if (priorReservation.status !== 'failed') throw new Error('quota reservation already active');
          await tx.update(operationKeys).set({ status: 'leased', leaseOwner: workerId, resultRef: 'reserved', updatedAt: now, version: priorReservation.version + 1 }).where(and(eq(operationKeys.key, reservationKey), eq(operationKeys.version, priorReservation.version)));
        } else {
          await tx.insert(operationKeys).values({ key: reservationKey, kind: 'proactive_quota_reservation', status: 'leased', leaseOwner: workerId, leaseExpiresAt: null, resultRef: 'reserved', version: 1, updatedAt: now });
        }
      }
      const [claimed] = await tx.update(commitments).set({ jobId: `sending:${fence}`, updatedAt: now, version: item.version + 1 }).where(and(eq(commitments.id, item.id), eq(commitments.version, item.version))).returning();
      if (!claimed) throw new Error('commitment claim conflict');
      await tx.insert(auditEvents).values({ actorKind: 'system', action: 'proactive_delivery_claimed', targetId: item.id, metadata: { operationKey, workerId, fence, expiresAt: expiresAt.toISOString(), reservationKeys } });
      return { value: { item: claimed, operationKey, fence, owner: workerId, reservationKeys } };
    });
  }

  private async reauthorizeBeforeDispatch(claim: Claim): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, claim.item.id)).limit(1);
      const [operation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, claim.operationKey)).limit(1);
      if (!item || item.version !== claim.item.version || item.jobId !== `sending:${claim.fence}` || !operation || operation.status !== 'leased' || operation.version !== claim.fence || operation.leaseOwner !== claim.owner || operation.resultRef !== 'dispatching' || !operation.leaseExpiresAt || operation.leaseExpiresAt <= this.clock()) return false;
      return !!await this.authorizeCommitment(tx, item);
    });
  }

  private async finish(claim: Claim, result: ProactiveResult): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [item] = await tx.select().from(commitments).where(eq(commitments.id, claim.item.id)).for('update').limit(1);
      const [operation] = await tx.select().from(operationKeys).where(eq(operationKeys.key, claim.operationKey)).for('update').limit(1);
      if (!operation || !item || operation.status !== 'leased' || operation.version !== claim.fence || operation.leaseOwner !== claim.owner || operation.resultRef !== 'dispatching' || !operation.leaseExpiresAt || operation.leaseExpiresAt <= this.clock() || item.version !== claim.item.version || item.jobId !== `sending:${claim.fence}`) return false;
      const now = this.clock();
      const state = result.kind === 'receipt' ? 'completed' : result.kind === 'not_sent' ? 'failed' : 'leased';
      const deliveryRef = result.kind === 'receipt' ? `receipt:${result.receipt}` : result.kind === 'not_sent' ? `not_sent:${result.errorCode}` : `receipt_unknown:${result.errorCode}`;
      await tx.update(operationKeys).set({ status: state, resultRef: deliveryRef, leaseOwner: null, leaseExpiresAt: null, updatedAt: now, version: operation.version + 1 }).where(eq(operationKeys.key, operation.key));
      for (const key of claim.reservationKeys) await tx.update(operationKeys).set({ status: result.kind === 'not_sent' ? 'failed' : result.kind === 'receipt' ? 'completed' : 'leased', resultRef: result.kind === 'not_sent' ? `not_sent:${result.errorCode}` : result.kind === 'receipt' ? 'receipt:sent' : 'receipt_unknown:ambiguous', leaseOwner: null, leaseExpiresAt: null, updatedAt: now, version: sql`${operationKeys.version} + 1` }).where(and(eq(operationKeys.key, key), eq(operationKeys.status, 'leased')));
      await tx.update(commitments).set({
        status: result.kind === 'receipt' ? 'completed' : 'failed',
        jobId: result.kind === 'receipt' ? `receipt:${result.receipt}` : result.kind === 'not_sent' ? `not_sent:${result.errorCode}` : 'receipt_unknown',
        updatedAt: now, version: item.version + 1,
      }).where(eq(commitments.id, item.id));
      await tx.insert(auditEvents).values({
        actorKind: 'system', action: result.kind === 'receipt' ? 'proactive_delivery_receipted' : result.kind === 'not_sent' ? 'proactive_delivery_not_sent' : 'proactive_receipt_unknown',
        targetId: item.id, metadata: { operationKey: claim.operationKey, result: result.kind, receipt: result.kind === 'receipt' ? result.receipt : null, errorCode: result.kind === 'receipt' ? null : result.errorCode },
      });
      return true;
    });
  }

  private async authorizeCommitment(tx: Transaction, item: typeof commitments.$inferSelect): Promise<{ permission: typeof proactivePermissions.$inferSelect; policy?: typeof conversationPolicies.$inferSelect } | undefined> {
    const [person] = await tx.select().from(people).where(eq(people.id, item.personId)).limit(1);
    if (!person || person.status !== 'active' || await canonicalPersonId(tx, person.id) !== item.personId) return undefined;
    const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.id, item.conversationId), eq(conversations.characterId, item.characterId))).limit(1);
    if (!conversation) return undefined;
    const linked = await currentLinkedPersonIds(tx, item.personId);
    const [membership] = await tx.select({ personId: conversationMembers.personId }).from(conversationMembers).where(and(
      eq(conversationMembers.conversationId, conversation.id), inArray(conversationMembers.personId, linked), isNotNull(conversationMembers.confirmedAt),
    )).limit(1);
    if (!membership) return undefined;
    const identities = await tx.select({ id: platformIdentities.id }).from(platformIdentities).where(and(inArray(platformIdentities.personId, linked), eq(platformIdentities.platform, conversation.platform), isNotNull(platformIdentities.verifiedAt)));
    if (!identities.length) return undefined;
    const [source] = await tx.select({ id: messages.id, personId: messages.personId, text: messages.text, deletedAt: messages.deletedAt }).from(messages).where(and(eq(messages.id, item.sourceMessageId), eq(messages.conversationId, conversation.id), eq(messages.role, 'user'))).limit(1);
    if (!source?.personId || source.text === null || source.deletedAt || await canonicalPersonId(tx, source.personId) !== item.personId) return undefined;
    const [permission] = await tx.select().from(proactivePermissions).where(and(eq(proactivePermissions.characterId, item.characterId), eq(proactivePermissions.personId, item.personId))).limit(1);
    if (!permission?.enabled) return undefined;
    let policy: typeof conversationPolicies.$inferSelect | undefined;
    if (conversation.kind === 'group') {
      [policy] = await tx.select().from(conversationPolicies).where(and(eq(conversationPolicies.conversationId, conversation.id), eq(conversationPolicies.proactiveEnabled, true))).limit(1);
      if (!policy) return undefined;
    }
    return { permission, policy };
  }

  private reservationScopes(item: typeof commitments.$inferSelect, permission: typeof proactivePermissions.$inferSelect, policy: typeof conversationPolicies.$inferSelect | undefined, now: Date): Array<{ keyPrefix: string; maximum: number; lockKey: string }> {
    const scopes = [{ scope: `person:${item.personId}`, zone: permission.timeZone, maximum: permission.maxPerDay }];
    if (policy) scopes.push({ scope: `conversation:${item.conversationId}`, zone: policy.timeZone, maximum: policy.maxPerDay });
    return scopes.map(({ scope, zone, maximum }) => {
      const day = this.localDate(now, zone);
      const keyPrefix = `proactive-quota:${scope}:${day}:`;
      return { keyPrefix, maximum, lockKey: `proactive-quota-lock:${scope}:${day}` };
    });
  }

  private async quotaReservationsUpdate(keys: string[], state: 'completed' | 'failed', tx: Transaction, now: Date): Promise<void> {
    for (const key of keys) await tx.update(operationKeys).set({ status: state, resultRef: state === 'completed' ? 'receipt:reconciled' : 'not_sent:admin_reconciled', leaseOwner: null, leaseExpiresAt: null, updatedAt: now, version: sql`${operationKeys.version} + 1` }).where(and(eq(operationKeys.key, key), eq(operationKeys.status, 'leased')));
  }

  private async reconcileReservationKeys(tx: Transaction, commitmentId: string, state: 'completed' | 'failed', now: Date): Promise<void> {
    const rows = await tx.select({ key: operationKeys.key }).from(operationKeys).where(like(operationKeys.key, `proactive-quota:%:${commitmentId}`));
    await this.quotaReservationsUpdate(rows.map(({ key }) => key), state, tx, now);
  }

  private isQuiet(now: Date, start: string, end: string, timeZone: string): boolean {
    const minute = (value: string) => {
      if (!/^\d{2}:\d{2}$/.test(value)) throw new Error('invalid quiet window');
      const [hour, min] = value.split(':').map(Number);
      if (hour! > 23 || min! > 59) throw new Error('invalid quiet window');
      return hour! * 60 + min!;
    };
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = formatter.formatToParts(now);
    const localMinute = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
    const begin = minute(start), finish = minute(end);
    return begin <= finish ? localMinute >= begin && localMinute < finish : localMinute >= begin || localMinute < finish;
  }

  private localDate(now: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  private assertActor(actor: ActorContext): void { if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required'); }
  private clock(): Date { const value = this.now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('invalid clock'); return value; }
}

function deliveryKey(commitmentId: string): string { return `proactive-delivery:${commitmentId}`; }
function commitmentIdFromDeliveryKey(value: string): string | undefined { const id = value.slice('proactive-delivery:'.length); return uuidSchema.safeParse(id).success ? id : undefined; }
