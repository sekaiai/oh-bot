import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import {
  circleMembers,
  conversationMembers,
  conversationPolicies,
  conversations,
  people,
  personIdentityLinks,
  platformIdentities,
  primaryRelationshipBindings,
} from '../database/schema/index.js';
import type { ActorContext, VisibilityScope } from '../domain/contracts.js';
import { isTrustedActorContext } from './trust.js';

type CompanionTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export class DisclosurePolicy {
  constructor(private readonly database: Database) {}

  private assertTrusted(context: ActorContext): void {
    if (!isTrustedActorContext(context)) throw new Error('untrusted actor context');
  }

  private async current(context: ActorContext, tx: CompanionTransaction) {
    this.assertTrusted(context);
    const [identity] = await tx.select().from(platformIdentities)
      .where(eq(platformIdentities.id, context.platformIdentityId)).limit(1).for('share');
    const [conversation] = await tx.select().from(conversations).where(and(
      eq(conversations.id, context.conversationId),
      eq(conversations.characterId, context.characterId),
    )).limit(1).for('share');
    if (!identity || !conversation) throw new Error('actor context revoked');

    const links = await tx.select().from(personIdentityLinks).for('share');
    const canonicalFor = (personId: string): string => {
      const seen = new Set<string>();
      let canonical = personId;
      while (links.some((link) => link.aliasPersonId === canonical)) {
        if (seen.has(canonical)) throw new Error('identity link cycle');
        seen.add(canonical);
        canonical = links.find((link) => link.aliasPersonId === canonical)!.canonicalPersonId;
      }
      return canonical;
    };
    const own = canonicalFor(identity.personId);
    const [canonicalPerson] = await tx.select({ status: people.status }).from(people)
      .where(eq(people.id, own)).limit(1).for('share');
    if (!canonicalPerson || canonicalPerson.status === 'erased') throw new Error('canonical person unavailable');
    const ownIds = new Set([own, ...links.filter((link) => canonicalFor(link.aliasPersonId) === own).map((link) => link.aliasPersonId)]);
    const members = await tx.select({ personId: conversationMembers.personId, confirmedAt: conversationMembers.confirmedAt })
      .from(conversationMembers).where(eq(conversationMembers.conversationId, conversation.id)).for('share');
    const hasUnconfirmedParticipant = members.some(({ confirmedAt }) => confirmedAt === null);
    const currentMembers = new Set(members.filter(({ confirmedAt }) => confirmedAt !== null).map(({ personId }) => canonicalFor(personId)));
    if (!currentMembers.has(own)) throw new Error('actor is not a confirmed conversation member');

    const [binding] = await tx.select().from(primaryRelationshipBindings)
      .where(eq(primaryRelationshipBindings.characterId, conversation.characterId)).limit(1).for('share');
    const isPartner = !!binding && ownIds.has(binding.personId);
    const confirmedCircles = await tx.select({ circleId: circleMembers.circleId })
      .from(circleMembers).where(and(
        isNotNull(circleMembers.confirmedAt),
        eq(circleMembers.personId, [...ownIds][0]),
      )).for('share');
    const circleIds = new Set(confirmedCircles.map(({ circleId }) => circleId));
    // Historical aliases may each carry independent circle membership.
    for (const personId of [...ownIds].slice(1)) {
      const rows = await tx.select({ circleId: circleMembers.circleId })
        .from(circleMembers).where(and(
          isNotNull(circleMembers.confirmedAt), eq(circleMembers.personId, personId),
        )).for('share');
      for (const row of rows) circleIds.add(row.circleId);
    }
    const [policy] = await tx.select().from(conversationPolicies)
      .where(eq(conversationPolicies.conversationId, conversation.id)).limit(1).for('share');
    const groupCircleMembers = conversation.circleId
      ? await tx.select({ personId: circleMembers.personId }).from(circleMembers).where(and(
        eq(circleMembers.circleId, conversation.circleId), isNotNull(circleMembers.confirmedAt),
      )).for('share')
      : [];
    const circlePersonIds = new Set(groupCircleMembers.map(({ personId }) => canonicalFor(personId)));
    return { conversation, ownIds, currentMembers, hasUnconfirmedParticipant, isPartner, circleIds, policy, circlePersonIds };
  }

  async allowedScopes(context: ActorContext): Promise<VisibilityScope[]> {
    this.assertTrusted(context);
    return this.database.db.transaction(async (tx) =>
      (await this.authorizationSnapshot(context, tx)).allowedScopes,
    { isolationLevel: 'repeatable read' });
  }

  async authorizationSnapshot(context: ActorContext, tx: CompanionTransaction): Promise<{
    allowedScopes: VisibilityScope[];
    matchesPersonIds(personIds: readonly string[]): boolean;
  }> {
    this.assertTrusted(context);
    const current = await this.current(context, tx);
    const scopes: VisibilityScope[] = [
      { kind: 'character_public' },
      { kind: 'conversation_shared', conversationId: current.conversation.id },
    ];
    if (current.conversation.kind === 'private') {
      for (const personId of current.ownIds) scopes.push({ kind: 'person_private', personId });
      if (current.isPartner) {
        for (const personId of current.ownIds) scopes.push({ kind: 'partner_private', personId });
      }
      for (const circleId of current.circleIds) scopes.push({ kind: 'circle_shared', circleId });
    } else if (
      current.conversation.circleId &&
      !current.hasUnconfirmedParticipant &&
      current.policy?.circleDisclosureVerified &&
      current.conversation.participantsComplete &&
      current.currentMembers.size > 0 &&
      [...current.currentMembers].every((personId) => current.circlePersonIds.has(personId))
    ) {
      scopes.push({ kind: 'circle_shared', circleId: current.conversation.circleId });
    }
    const ownIds = new Set(current.ownIds);
    return {
      allowedScopes: scopes,
      matchesPersonIds: (personIds) => personIds.some((personId) => ownIds.has(personId)),
    };
  }

  async canUse(context: ActorContext, scope: VisibilityScope): Promise<boolean> {
    this.assertTrusted(context);
    return this.database.db.transaction(async (tx) => {
      const current = await this.current(context, tx);
      switch (scope.kind) {
        case 'character_public':
          return true;
        case 'conversation_shared':
          return scope.conversationId === current.conversation.id;
        case 'person_private':
          return current.conversation.kind === 'private' && current.ownIds.has(scope.personId);
        case 'partner_private':
          return current.conversation.kind === 'private' && current.isPartner && current.ownIds.has(scope.personId);
        case 'circle_shared':
          if (current.conversation.kind === 'private') return current.circleIds.has(scope.circleId);
          return current.conversation.circleId === scope.circleId &&
            !!current.policy?.circleDisclosureVerified &&
            !current.hasUnconfirmedParticipant &&
            current.conversation.participantsComplete &&
            current.currentMembers.size > 0 &&
            [...current.currentMembers].every((personId) => current.circlePersonIds.has(personId));
      }
    }, { isolationLevel: 'repeatable read' });
  }

}
