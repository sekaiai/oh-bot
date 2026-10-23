import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { circleMembers, conversationMembers, conversationPolicies, conversations, disclosureRules, knowledgeClaims, memoryRevisions, memorySources, messages, personIdentityLinks, platformIdentities } from '../database/schema/index.js';
import type { ActorContext, VisibilityScope } from '../domain/contracts.js';
import { visibilityScopeSchema } from '../domain/contracts.js';
import { DisclosurePolicy } from '../identity/disclosure-policy.js';
import { isTrustedActorContext } from '../identity/trust.js';

const MAX_SCAN_ROWS = 1_000;
const MAX_SOURCE_GROUPS = 1_000;
const optionsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(MAX_SCAN_ROWS - 1).default(0),
}).strict().superRefine((value, context) => {
  if (value.offset + value.limit > MAX_SCAN_ROWS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'requested page exceeds bounded memory scan' });
  }
});

export type ReadableMemory = Readonly<{
  revisionId: string;
  sourceId: string;
  messageId: string;
  characterId: string;
  factText: string;
  scope: VisibilityScope;
  subjectPersonIds: readonly string[];
  validFrom: Date;
  version: number;
}>;

function scopeKey(scope: VisibilityScope): string {
  switch (scope.kind) {
    case 'character_public': return 'character_public';
    case 'circle_shared': return `circle_shared:${scope.circleId}`;
    case 'conversation_shared': return `conversation_shared:${scope.conversationId}`;
    case 'person_private': return `person_private:${scope.personId}`;
    case 'partner_private': return `partner_private:${scope.personId}`;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedRight = [...right].sort();
  return [...left].sort().every((id, index) => id === normalizedRight[index]);
}

export class MemoryReadService {
  private readonly policy: DisclosurePolicy;

  constructor(private readonly database: Database, policy?: DisclosurePolicy) {
    this.policy = policy ?? new DisclosurePolicy(database);
  }

  async listForActor(context: ActorContext, rawOptions: unknown = {}): Promise<ReadableMemory[]> {
    if (!isTrustedActorContext(context)) throw new Error('untrusted actor context');
    const options = optionsSchema.parse(rawOptions);
    return this.database.db.transaction(async (tx) => {
      // Discover all source groups in this repeatable-read snapshot before taking
      // any conversation lock. Lock the caller and those sources in one global ID
      // order, then lock roster, policy, and circle-membership rows in stable order.
      const sourceGroupRows = await tx.select({ conversationId: memorySources.conversationId, scope: memorySources.scope })
        .from(memoryRevisions)
        .innerJoin(memorySources, eq(memorySources.id, memoryRevisions.sourceId))
        .innerJoin(conversations, eq(conversations.id, memorySources.conversationId))
        .where(and(
          eq(memoryRevisions.characterId, context.characterId),
          eq(memorySources.characterId, context.characterId),
          eq(conversations.characterId, context.characterId),
          eq(conversations.kind, 'group'),
          eq(memoryRevisions.status, 'validated'),
          isNull(memoryRevisions.validTo),
          eq(memorySources.status, 'active'),
          isNull(memorySources.deletedAt),
          eq(memorySources.sourceKind, 'user'),
          eq(memorySources.claimKind, 'direct'),
          eq(memorySources.allowedForExtraction, true),
          sql`${memorySources.scope}->>'kind' = 'circle_shared'`,
          sql`${memoryRevisions.scope} = ${memorySources.scope}`,
        ))
        .groupBy(memorySources.conversationId, memorySources.scope)
        .orderBy(asc(memorySources.conversationId))
        .limit(MAX_SOURCE_GROUPS + 1);
      if (sourceGroupRows.length > MAX_SOURCE_GROUPS) throw new Error('memory source group scan exceeded its bound');
      const conversationIds = [...new Set([context.conversationId, ...sourceGroupRows.map((row) => row.conversationId)])].sort();

      // Pre-read the actor's current linked IDs and circle memberships from this
      // transaction snapshot so all relevant circle rows can be locked together.
      const [identity] = await tx.select({ personId: platformIdentities.personId }).from(platformIdentities)
        .where(eq(platformIdentities.id, context.platformIdentityId)).limit(1);
      const links = identity ? await tx.select().from(personIdentityLinks) : [];
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
      const ownCanonicalId = identity ? canonicalFor(identity.personId) : undefined;
      const ownPersonIds = identity && ownCanonicalId
        ? [...new Set([ownCanonicalId, ...links.filter((link) => canonicalFor(link.aliasPersonId) === ownCanonicalId).map((link) => link.aliasPersonId)])]
        : [];
      const ownCircleRows = ownPersonIds.length
        ? await tx.select({ circleId: circleMembers.circleId }).from(circleMembers)
          .where(and(inArray(circleMembers.personId, ownPersonIds), isNotNull(circleMembers.confirmedAt)))
        : [];
      const candidateSourceCircleIds = sourceGroupRows.flatMap((row) => {
        const scope = visibilityScopeSchema.safeParse(row.scope);
        return scope.success && scope.data.kind === 'circle_shared' ? [scope.data.circleId] : [];
      });
      const circleIds = [...new Set([...ownCircleRows.map((row) => row.circleId), ...candidateSourceCircleIds])].sort();

      await tx.select({ id: conversations.id }).from(conversations)
        .where(inArray(conversations.id, conversationIds))
        .orderBy(asc(conversations.id)).for('share');
      await tx.select({ conversationId: conversationMembers.conversationId, personId: conversationMembers.personId })
        .from(conversationMembers).where(inArray(conversationMembers.conversationId, conversationIds))
        .orderBy(asc(conversationMembers.conversationId), asc(conversationMembers.personId)).for('share');
      await tx.select({ conversationId: conversationPolicies.conversationId }).from(conversationPolicies)
        .where(inArray(conversationPolicies.conversationId, conversationIds))
        .orderBy(asc(conversationPolicies.conversationId)).for('share');
      if (circleIds.length) {
        await tx.select({ circleId: circleMembers.circleId, personId: circleMembers.personId }).from(circleMembers)
          .where(inArray(circleMembers.circleId, circleIds))
          .orderBy(asc(circleMembers.circleId), asc(circleMembers.personId)).for('share');
      }

      const authorization = await this.policy.authorizationSnapshot(context, tx);
      const allowedScopes = authorization.allowedScopes;
      if (!allowedScopes.length) return [];
      const allowedScopeKeys = new Set(allowedScopes.map(scopeKey));
      const now = new Date();
      const rows = await tx.select({
        revision: memoryRevisions,
        source: memorySources,
        messageId: messages.id,
        messageConversationId: messages.conversationId,
        messagePersonId: messages.personId,
        conversationKind: conversations.kind,
        conversationCircleId: conversations.circleId,
        conversationParticipantsComplete: conversations.participantsComplete,
        conversationRosterObservedAt: conversations.rosterObservedAt,
        conversationRosterInvalidatedAt: conversations.rosterInvalidatedAt,
      }).from(memoryRevisions)
        .innerJoin(memorySources, eq(memorySources.id, memoryRevisions.sourceId))
        .innerJoin(messages, eq(messages.id, memorySources.messageId))
        .innerJoin(conversations, eq(conversations.id, memorySources.conversationId))
        .where(and(
          eq(memoryRevisions.characterId, context.characterId),
          eq(memorySources.characterId, context.characterId),
          eq(conversations.characterId, context.characterId),
          eq(memoryRevisions.status, 'validated'),
          isNull(memoryRevisions.validTo),
          eq(memorySources.status, 'active'),
          isNull(memorySources.deletedAt),
          eq(memorySources.sourceKind, 'user'),
          eq(memorySources.claimKind, 'direct'),
          eq(memorySources.allowedForExtraction, true),
          eq(messages.role, 'user'),
          isNull(messages.deletedAt),
          inArray(memorySources.scope, allowedScopes),
          inArray(memoryRevisions.scope, allowedScopes),
        ))
        .orderBy(desc(memoryRevisions.validFrom), asc(memoryRevisions.id))
        .limit(MAX_SCAN_ROWS);
      if (!rows.length) return [];

      const sourceIds = [...new Set(rows.map(({ source }) => source.id))];
      const claims = await tx.select({ id: knowledgeClaims.id, sourceId: knowledgeClaims.sourceId })
        .from(knowledgeClaims).where(and(
          eq(knowledgeClaims.characterId, context.characterId),
          inArray(knowledgeClaims.sourceId, sourceIds),
        ));
      const claimIdsBySource = new Map<string, Set<string>>();
      for (const claim of claims) {
        const claimIds = claimIdsBySource.get(claim.sourceId) ?? new Set<string>();
        claimIds.add(claim.id);
        claimIdsBySource.set(claim.sourceId, claimIds);
      }
      const groupConversationIds = [...new Set(rows.filter((row) => row.conversationKind === 'group').map((row) => row.source.conversationId))];
      const groupMembers = groupConversationIds.length
        ? await tx.select({ conversationId: conversationMembers.conversationId, personId: conversationMembers.personId, confirmedAt: conversationMembers.confirmedAt })
          .from(conversationMembers).where(inArray(conversationMembers.conversationId, groupConversationIds))
        : [];
      const groupPolicies = groupConversationIds.length
        ? await tx.select().from(conversationPolicies).where(inArray(conversationPolicies.conversationId, groupConversationIds))
        : [];
      const sourceCircleIds = [...new Set(rows.flatMap((row) => {
        const parsed = visibilityScopeSchema.safeParse(row.source.scope);
        return parsed.success && parsed.data.kind === 'circle_shared' ? [parsed.data.circleId] : [];
      }))];
      const confirmedCircleMembers = sourceCircleIds.length
        ? await tx.select({ circleId: circleMembers.circleId, personId: circleMembers.personId })
          .from(circleMembers).where(and(inArray(circleMembers.circleId, sourceCircleIds), isNotNull(circleMembers.confirmedAt)))
        : [];
      const rules = await tx.select().from(disclosureRules).where(and(
        eq(disclosureRules.characterId, context.characterId),
        or(isNull(disclosureRules.sourceId), inArray(disclosureRules.sourceId, sourceIds),
          ...(claims.length ? [inArray(disclosureRules.claimId, claims.map(({ id }) => id))] : [])),
      ));
      const result: ReadableMemory[] = [];
      for (const row of rows) {
        const { revision, source } = row;
        if (row.messageConversationId !== source.conversationId || row.messagePersonId === null ||
            source.speakerPersonId !== row.messagePersonId || source.personId !== row.messagePersonId ||
            !source.subjectPersonIds.includes(row.messagePersonId) ||
            !sameIds(source.subjectPersonIds, revision.subjectPersonIds) ||
            revision.factText === null || revision.factText.trim() === '' ||
            revision.validFrom > now) continue;

        const sourceScope = visibilityScopeSchema.safeParse(source.scope);
        const revisionScope = visibilityScopeSchema.safeParse(revision.scope);
        if (!sourceScope.success || !revisionScope.success ||
            scopeKey(sourceScope.data) !== scopeKey(revisionScope.data) ||
            !allowedScopeKeys.has(scopeKey(revisionScope.data))) continue;
        // A source cannot broaden the conversation's disclosure ceiling just by
        // carrying a wider JSON scope. Private messages never become circle/public
        // memories, and a group utterance is never character-public by default.
        if ((row.conversationKind === 'private' &&
            (revisionScope.data.kind === 'circle_shared' || revisionScope.data.kind === 'character_public')) ||
            (row.conversationKind === 'group' && revisionScope.data.kind === 'character_public')) continue;
        if (row.conversationKind === 'group' && sourceScope.data.kind === 'circle_shared') {
          const members = groupMembers.filter((member) => member.conversationId === source.conversationId);
          const policy = groupPolicies.find((item) => item.conversationId === source.conversationId);
          const memberIds = members.map((member) => member.personId);
          const allMembersConfirmed = members.length > 0 && members.every((member) => member.confirmedAt !== null);
          const circleId = sourceScope.data.circleId;
          const rosterFresh = row.conversationRosterObservedAt !== null &&
            (row.conversationRosterInvalidatedAt === null || row.conversationRosterObservedAt > row.conversationRosterInvalidatedAt);
          if (row.conversationCircleId !== sourceScope.data.circleId || !row.conversationParticipantsComplete ||
              !rosterFresh || !policy?.circleDisclosureVerified || !allMembersConfirmed ||
              memberIds.some((personId) => !source.participantPersonIds.includes(personId)) ||
              memberIds.some((personId) => !confirmedCircleMembers.some((member) =>
                member.circleId === circleId && member.personId === personId))) continue;
        }
        if ((revisionScope.data.kind === 'person_private' || revisionScope.data.kind === 'partner_private') &&
            !authorization.matchesPersonIds(revision.subjectPersonIds)) continue;

        let denied = false;
        for (const rule of rules) {
          const ruleScope = rule.scope === null ? null : visibilityScopeSchema.safeParse(rule.scope);
          if (rule.scope !== null && (!ruleScope || !ruleScope.success || scopeKey(ruleScope.data) !== scopeKey(revisionScope.data))) continue;
          if (rule.sourceId !== null && rule.sourceId !== source.id) continue;
          if (rule.claimId !== null && !claimIdsBySource.get(source.id)?.has(rule.claimId)) continue;
          if (rule.deniedPersonIds.length && authorization.matchesPersonIds(rule.deniedPersonIds)) {
            denied = true;
            break;
          }
          if (rule.allowedPersonIds.length && !authorization.matchesPersonIds(rule.allowedPersonIds)) {
            denied = true;
            break;
          }
        }
        if (denied) continue;
        result.push({
          revisionId: revision.id,
          sourceId: source.id,
          messageId: row.messageId,
          characterId: revision.characterId,
          factText: revision.factText,
          scope: revisionScope.data,
          subjectPersonIds: [...revision.subjectPersonIds],
          validFrom: revision.validFrom,
          version: revision.version,
        });
      }
      return result.slice(options.offset, options.offset + options.limit);
    }, { isolationLevel: 'repeatable read' });
  }
}
