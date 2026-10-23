import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import {
  auditEvents,
  bindingChallenges,
  circleMembers,
  conversationMembers,
  conversations,
  people,
  personIdentityLinks,
  platformIdentities,
  primaryRelationshipBindings,
} from '../database/schema/index.js';
import type { ActorContext, ConversationKind, Platform, Principal } from '../domain/contracts.js';
import { isTrustedActorContext, isTrustedEvidence, trustActorContext } from './trust.js';

export type VerifiedChannelEvidence = Readonly<{
  kind: 'verified-channel';
  platform: Platform;
  channelId: string;
}>;
export type IdentityResolution = Readonly<{
  personId: string;
  platformIdentityId: string;
  linkedPersonIds: string[];
}>;
type CompanionTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

const advisoryLockKey = (domain: string) => JSON.stringify(['oh-bot-companion-identity', domain]);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const supportedPlatforms: readonly Platform[] = ['qq', 'weixin', 'dingtalk'];
const maximumChallengeTtlMs = 24 * 60 * 60_000;

export class IdentityService {
  private readonly now: () => Date;
  private readonly challengeTtlMs: number;

  constructor(
    private readonly database: Database,
    options: { now?: () => Date; challengeTtlMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.challengeTtlMs = options.challengeTtlMs ?? 10 * 60_000;
    if (!Number.isFinite(this.challengeTtlMs) || this.challengeTtlMs <= 0 || this.challengeTtlMs > maximumChallengeTtlMs) {
      throw new Error('challenge TTL must be finite, positive, and at most 24 hours');
    }
  }

  private validateEvidence(
    evidence: VerifiedChannelEvidence,
    platform: Platform,
    platformUserId?: string,
    conversationKind?: ConversationKind,
  ): void {
    if (
      !isTrustedEvidence(evidence, platformUserId, conversationKind) ||
      evidence.kind !== 'verified-channel' ||
      evidence.platform !== platform ||
      !evidence.channelId.trim()
    ) {
      throw new Error('verified channel evidence required');
    }
  }

  private async lock(tx: CompanionTransaction): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${advisoryLockKey('graph')}, 0))`);
  }

  private async rootOf(
    personId: string,
    tx: CompanionTransaction,
    options: { allowErasedCanonical?: boolean } = {},
  ): Promise<string> {
    const seen = new Set<string>();
    let root = personId;
    while (true) {
      if (seen.has(root)) throw new Error('identity link cycle');
      const [link] = await tx.select({ canonicalPersonId: personIdentityLinks.canonicalPersonId })
        .from(personIdentityLinks).where(eq(personIdentityLinks.aliasPersonId, root)).limit(1);
      if (!link) break;
      seen.add(root);
      root = link.canonicalPersonId;
    }
    const [person] = await tx.select({ id: people.id, status: people.status }).from(people).where(eq(people.id, root)).limit(1);
    if (!person || (!options.allowErasedCanonical && person.status === 'erased')) {
      throw new Error('canonical person unavailable');
    }
    return root;
  }

  private async linkedIds(personId: string, tx: CompanionTransaction): Promise<string[]> {
    const canonicalId = await this.rootOf(personId, tx);
    const aliases = await tx.select({ aliasPersonId: personIdentityLinks.aliasPersonId })
      .from(personIdentityLinks).where(eq(personIdentityLinks.canonicalPersonId, canonicalId));
    return [canonicalId, ...aliases.map(({ aliasPersonId }) => aliasPersonId)];
  }

  private async resolution(identity: typeof platformIdentities.$inferSelect, tx: CompanionTransaction): Promise<IdentityResolution> {
    return {
      personId: await this.rootOf(identity.personId, tx),
      platformIdentityId: identity.id,
      linkedPersonIds: await this.linkedIds(identity.personId, tx),
    };
  }

  async resolveIdentity(
    input: { platform: Platform; platformUserId: string; displayName?: string },
    evidence: VerifiedChannelEvidence,
  ): Promise<IdentityResolution> {
    this.validatePlatformAndUser(input.platform, input.platformUserId);
    this.validateEvidence(evidence, input.platform, input.platformUserId);

    return this.database.db.transaction(async (tx) => {
      await this.lock(tx);
      const [existing] = await tx.select().from(platformIdentities).where(and(
        eq(platformIdentities.platform, input.platform),
        eq(platformIdentities.platformUserId, input.platformUserId),
      )).limit(1);
      if (existing) return this.resolution(existing, tx);

      const personId = randomUUID();
      const identityId = randomUUID();
      const verifiedAt = this.now();
      await tx.insert(people).values({ id: personId, displayName: input.displayName ?? null });
      await tx.insert(platformIdentities).values({
        id: identityId,
        personId,
        platform: input.platform,
        platformUserId: input.platformUserId,
        verifiedAt,
        verificationMethod: `channel:${evidence.channelId}`,
      });
      return { personId, platformIdentityId: identityId, linkedPersonIds: [personId] };
    });
  }

  private validatePlatformAndUser(platform: Platform, platformUserId: string): void {
    if (!supportedPlatforms.includes(platform) || typeof platformUserId !== 'string' || !platformUserId.trim()) {
      throw new Error('supported platform and non-empty platform user id required');
    }
  }

  async createPerson(input: { displayName?: string }, principal: Principal): Promise<{ personId: string }> {
    if (principal.kind !== 'admin') throw new Error('admin required');
    const personId = randomUUID();
    await this.database.db.insert(people).values({ id: personId, displayName: input.displayName ?? null });
    return { personId };
  }

  async setPrimaryPartner(characterId: string, personId: string, principal: Principal): Promise<void> {
    if (principal.kind !== 'admin') throw new Error('admin required');
    await this.database.db.transaction(async (tx) => {
      await this.lock(tx);
      const canonicalPersonId = await this.rootOf(personId, tx);
      const [person] = await tx.select().from(people).where(and(
        eq(people.id, canonicalPersonId), eq(people.status, 'active'),
      )).limit(1);
      if (!person) throw new Error('active canonical person required');
      const [prior] = await tx.select().from(primaryRelationshipBindings)
        .where(eq(primaryRelationshipBindings.characterId, characterId)).limit(1);
      if (prior && await this.rootOf(prior.personId, tx, { allowErasedCanonical: true }) === canonicalPersonId) return;
      if (prior) await tx.delete(primaryRelationshipBindings)
        .where(eq(primaryRelationshipBindings.characterId, characterId));
      await tx.insert(primaryRelationshipBindings).values({
        characterId, personId: canonicalPersonId, createdBy: principal.auditActorId,
      });
      await tx.insert(auditEvents).values({
        actorKind: 'admin', actorId: principal.auditActorId, action: 'primary_partner_changed',
        targetId: characterId,
        metadata: { oldPersonId: prior?.personId ?? null, newPersonId: canonicalPersonId },
      });
    });
  }

  async createBindingChallenge(
    sourceIdentityId: string,
    targetPlatform: Platform,
    principal: Principal,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (typeof sourceIdentityId !== 'string' || !sourceIdentityId.trim() || !supportedPlatforms.includes(targetPlatform)) {
      throw new Error('source identity and supported target platform required');
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.now().getTime() + this.challengeTtlMs);
    await this.database.db.transaction(async (tx) => {
      await this.lock(tx);
      const [source] = await tx.select().from(platformIdentities)
        .where(eq(platformIdentities.id, sourceIdentityId)).limit(1);
      if (!source) throw new Error('source identity unavailable');
      let actorId: string;
      if (principal.kind === 'admin') {
        actorId = principal.auditActorId;
      } else {
        if (!isTrustedActorContext(principal.actor) || principal.actor.conversationKind !== 'private') {
          throw new Error('source private identity required');
        }
        const actorPersonId = await this.actorStillPrivate(principal.actor, source.personId, tx);
        if (!actorPersonId) throw new Error('source private identity required');
        actorId = actorPersonId;
      }
      await tx.insert(bindingChallenges).values({
        personId: source.personId, sourceIdentityId, targetPlatform, tokenHash: tokenHash(token), expiresAt,
      });
      await tx.insert(auditEvents).values({
        actorKind: principal.kind,
        actorId: principal.kind === 'admin' ? principal.auditActorId : actorId,
        action: 'binding_challenge_created', targetId: sourceIdentityId, metadata: { targetPlatform },
      });
    });
    return { token, expiresAt };
  }

  private async actorStillPrivate(
    context: ActorContext,
    sourcePersonId: string,
    tx: CompanionTransaction,
  ): Promise<string | undefined> {
    const [actorIdentity] = await tx.select().from(platformIdentities)
      .where(eq(platformIdentities.id, context.platformIdentityId)).limit(1);
    const [conversation] = await tx.select().from(conversations).where(and(
      eq(conversations.id, context.conversationId),
      eq(conversations.characterId, context.characterId),
      eq(conversations.kind, 'private'),
    )).limit(1);
    if (!actorIdentity || !conversation || actorIdentity.platform !== conversation.platform) return undefined;
    const actorPersonId = await this.rootOf(actorIdentity.personId, tx);
    const sourceCanonicalId = await this.rootOf(sourcePersonId, tx);
    if (actorPersonId !== sourceCanonicalId) return undefined;
    const members = await tx.select().from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversation.id));
    for (const member of members) {
      if (member.confirmedAt && await this.rootOf(member.personId, tx) === actorPersonId) return actorPersonId;
    }
    return undefined;
  }

  async consumeBindingChallenge(
    token: string,
    target: { platform: Platform; platformUserId: string; conversationKind: ConversationKind },
    evidence: VerifiedChannelEvidence,
  ): Promise<IdentityResolution> {
    if (typeof token !== 'string' || !token.trim()) throw new Error('binding token required');
    this.validatePlatformAndUser(target.platform, target.platformUserId);
    if (target.conversationKind !== 'private' && target.conversationKind !== 'group') {
      throw new Error('supported target conversation kind required');
    }
    this.validateEvidence(evidence, target.platform, target.platformUserId, 'private');
    if (target.conversationKind !== 'private') throw new Error('private conversation required');
    return this.database.db.transaction(async (tx) => {
      await this.lock(tx);
      const [challenge] = await tx.select().from(bindingChallenges)
        .where(eq(bindingChallenges.tokenHash, tokenHash(token))).for('update').limit(1);
      const now = this.now();
      if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.targetPlatform !== target.platform) {
        throw new Error('invalid binding challenge');
      }
      let [identity] = await tx.select().from(platformIdentities).where(and(
        eq(platformIdentities.platform, target.platform),
        eq(platformIdentities.platformUserId, target.platformUserId),
      )).limit(1);
      let targetPersonId: string;
      if (!identity) {
        targetPersonId = randomUUID();
        const identityId = randomUUID();
        await tx.insert(people).values({ id: targetPersonId });
        await tx.insert(platformIdentities).values({
          id: identityId, personId: targetPersonId, platform: target.platform,
          platformUserId: target.platformUserId, verifiedAt: now,
          verificationMethod: `channel:${evidence.channelId}`,
        });
        [identity] = await tx.select().from(platformIdentities).where(eq(platformIdentities.id, identityId)).limit(1);
      } else targetPersonId = identity.personId;

      const canonicalPersonId = await this.rootOf(challenge.personId, tx);
      const targetRoot = await this.rootOf(targetPersonId, tx);
      if (canonicalPersonId !== targetRoot) {
        for (const aliasPersonId of await this.linkedIds(targetPersonId, tx)) {
          if (aliasPersonId === canonicalPersonId) continue;
          await tx.insert(personIdentityLinks).values({
            aliasPersonId, canonicalPersonId, proofChallengeId: challenge.id,
          }).onConflictDoUpdate({
            target: personIdentityLinks.aliasPersonId,
            set: { canonicalPersonId, proofChallengeId: challenge.id },
          });
        }
      }
      await tx.update(bindingChallenges).set({ consumedAt: now })
        .where(eq(bindingChallenges.id, challenge.id));
      await tx.insert(auditEvents).values({
        actorKind: 'person', actorId: challenge.personId, action: 'identity_binding_consumed',
        targetId: identity.id,
        metadata: { sourcePersonId: challenge.personId, targetPersonId: targetPersonId, canonicalPersonId },
      });
      return this.resolution(identity, tx);
    });
  }

  async getLinkedPersonIds(personId: string): Promise<string[]> {
    return this.database.db.transaction(async (tx) => {
      await this.lock(tx);
      return this.linkedIds(personId, tx);
    });
  }

  async resolveActorContext(
    input: { platform: Platform; platformUserId: string; characterId: string; conversationId: string },
    evidence: VerifiedChannelEvidence,
  ): Promise<ActorContext> {
    this.validatePlatformAndUser(input.platform, input.platformUserId);
    if (typeof input.characterId !== 'string' || !input.characterId.trim() || typeof input.conversationId !== 'string' || !input.conversationId.trim()) {
      throw new Error('character and conversation ids required');
    }
    this.validateEvidence(evidence, input.platform, input.platformUserId);
    const [identity] = await this.database.db.select().from(platformIdentities).where(and(
      eq(platformIdentities.platform, input.platform),
      eq(platformIdentities.platformUserId, input.platformUserId),
    )).limit(1);
    if (!identity) throw new Error('unknown platform identity');
    const [conversation] = await this.database.db.select().from(conversations).where(and(
      eq(conversations.id, input.conversationId),
      eq(conversations.characterId, input.characterId),
      eq(conversations.platform, input.platform),
    )).limit(1);
    if (!conversation) throw new Error('conversation unavailable');
    this.validateEvidence(evidence, input.platform, input.platformUserId, conversation.kind);
    if (evidence.channelId !== conversation.platformConversationId) {
      throw new Error('verified evidence does not match conversation channel');
    }
    const linkedPersonIds = await this.getLinkedPersonIds(identity.personId);
    const personId = await this.database.db.transaction((tx) => this.rootOf(identity.personId, tx));
    const participants = await this.database.db.select({ personId: conversationMembers.personId, confirmedAt: conversationMembers.confirmedAt })
      .from(conversationMembers).where(eq(conversationMembers.conversationId, conversation.id));
    const confirmedParticipants = participants.filter((item) => item.confirmedAt !== null);
    const memberships = conversation.circleId
      ? await this.database.db.select({ personId: circleMembers.personId })
        .from(circleMembers).where(and(
          eq(circleMembers.circleId, conversation.circleId),
          inArray(circleMembers.personId, linkedPersonIds),
          isNotNull(circleMembers.confirmedAt),
        ))
      : [];
    const binding = (await this.database.db.select().from(primaryRelationshipBindings)
      .where(eq(primaryRelationshipBindings.characterId, conversation.characterId)).limit(1))[0];
    const circleIds = conversation.circleId && memberships.length ? [conversation.circleId] : [];
    const context: ActorContext = {
      personId, characterId: conversation.characterId, conversationId: conversation.id,
      platformIdentityId: identity.id, conversationKind: conversation.kind,
      isPartner: !!binding && linkedPersonIds.includes(binding.personId),
      circleIds, participantIds: confirmedParticipants.map((item) => item.personId),
      linkedPersonIds,
      participantsComplete: conversation.participantsComplete && participants.every((item) => item.confirmedAt !== null),
    };
    if (!confirmedParticipants.some((member) => linkedPersonIds.includes(member.personId))) {
      throw new Error('actor is not a confirmed conversation participant');
    }
    return trustActorContext(Object.freeze({
      ...context,
      circleIds: Object.freeze([...context.circleIds]),
      participantIds: Object.freeze([...context.participantIds]),
      linkedPersonIds: Object.freeze([...context.linkedPersonIds]),
    }));
  }
}
