import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../database/database.js';
import {
  auditEvents,
  characters,
  conversations,
  messages,
  people,
  personEntities,
  platformIdentities,
  relationshipEdges,
} from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';
import { canonicalPersonId, currentLinkedPersonIds, requireCurrentActor } from '../persona/current-actor.js';
import { DisclosurePolicy } from '../identity/disclosure-policy.js';
import { isTrustedActorContext } from '../identity/trust.js';

type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
export type SocialRelationKind = 'user_friend' | 'character_friend';
export type IntroductionProposal = Readonly<{ entityId: string; version: number; created: boolean }>;
export type ConfirmedSocialRelation = Readonly<{
  entityId: string;
  edgeId: string;
  displayName: string;
  personId: string | null;
  sourceMessageId: string;
  kind: SocialRelationKind;
}>;

const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\u0000-\u001f\u007f]/u.test(value);

// Role entities use deterministic, domain-separated IDs so names can never
// make a friend entity resolve as the character or current user.
const roleEntityId = (role: string) => {
  const bytes = createHash('sha256').update(`oh-bot-social-role:${role}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const explicitConfirmation = (text: string, displayName: string, kind: SocialRelationKind) => {
  const normalized = text.normalize('NFKC').trim().toLocaleLowerCase();
  const literalName = nameKey(displayName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = kind === 'user_friend'
    ? new RegExp(`^(?:我(?:确认|同意)|我愿意(?:确认|同意))\\s*[,，:：]?\\s*${literalName}\\s*(?:是)?\\s*(?:我的朋友|我朋友)[。.!！?？]?$`, 'u')
    : new RegExp(`^(?:我(?:确认|同意)|我愿意(?:确认|同意))\\s*[,，:：]?\\s*${literalName}\\s*(?:也)?(?:是)?\\s*角色的朋友[。.!！?？]?$`, 'u');
  const english = kind === 'user_friend'
    ? new RegExp(`^(?:i confirm|i agree|yes,? i confirm)\\s+${literalName}\\s+(?:is\\s+)?my friend[.!?]?$`, 'iu')
    : new RegExp(`^(?:i confirm|i agree|yes,? i confirm)\\s+${literalName}\\s+(?:is\\s+)?the character's friend[.!?]?$`, 'iu');
  return pattern.test(normalized) || english.test(normalized);
};

/**
 * Source-grounded social facts are only created through explicit proposal and
 * confirmation calls. This service is not an incoming-message extractor.
 */
export class SocialGraphService {
  private readonly policy: DisclosurePolicy;

  constructor(private readonly database: Database, policy?: DisclosurePolicy) {
    this.policy = policy ?? new DisclosurePolicy(database);
  }

  private async requirePrivateCurrentActor(tx: Transaction, actor: ActorContext) {
    if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
    const current = await requireCurrentActor(tx, actor);
    if (current.conversation.kind !== 'private') throw new Error('private conversation required');
    return current;
  }

  private async sourceForActor(tx: Transaction, actor: ActorContext, messageId: string, displayName?: string) {
    const current = await this.requirePrivateCurrentActor(tx, actor);
    const [message] = await tx.select().from(messages).where(and(
      eq(messages.id, messageId), eq(messages.conversationId, current.conversation.id),
      eq(messages.role, 'user'), isNull(messages.deletedAt),
    )).for('share').limit(1);
    if (!message?.text?.trim() || !message.personId || await canonicalPersonId(tx, message.personId) !== current.personId) {
      throw new Error('source message unavailable for current actor');
    }
    if (displayName) {
      const normalizedText = message.text.normalize('NFKC').toLocaleLowerCase();
      const normalizedName = nameKey(displayName);
      if (!normalizedText.includes(normalizedName) || !/(?:朋友|friend)/iu.test(normalizedText)) {
        throw new Error('source message does not ground this friend introduction');
      }
    }
    return { current, message };
  }

  private async actorEntity(tx: Transaction, actor: ActorContext, canonicalActorId: string, currentPersonIds: string[], displayName: string) {
    const roleId = roleEntityId(`actor:${actor.characterId}:${canonicalActorId}`);
    const [existing] = await tx.select().from(personEntities).where(and(
      eq(personEntities.id, roleId), eq(personEntities.characterId, actor.characterId),
      inArray(personEntities.personId, currentPersonIds),
    )).for('update').limit(1);
    if (existing) return existing;
    const [created] = await tx.insert(personEntities).values({
      id: roleId, characterId: actor.characterId, personId: canonicalActorId, displayName, confirmed: true,
    }).returning();
    if (!created) throw new Error('actor entity could not be created');
    return created;
  }

  private async targetPerson(tx: Transaction, identityId: string, currentPersonId: string): Promise<string> {
    const [identity] = await tx.select({ personId: platformIdentities.personId }).from(platformIdentities).where(and(
      eq(platformIdentities.id, identityId), isNotNull(platformIdentities.verifiedAt),
    )).for('share').limit(1);
    if (!identity) throw new Error('verified target identity required');
    const canonicalId = await canonicalPersonId(tx, identity.personId);
    const [person] = await tx.select({ status: people.status }).from(people).where(eq(people.id, canonicalId)).limit(1).for('share');
    if (!person || person.status !== 'active' || canonicalId === currentPersonId) throw new Error('verified target person unavailable');
    return canonicalId;
  }

  /** Creates a separate unconfirmed entity from a user-initiated, source-backed proposal. */
  async proposeIntroduction(actor: ActorContext, messageId: string, input: { displayName: string; verifiedTargetIdentityId?: string }): Promise<IntroductionProposal> {
    if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
    if (!validName(input?.displayName)) throw new Error('valid person display name required');
    return this.database.db.transaction(async (tx) => {
      const { current, message } = await this.sourceForActor(tx, actor, messageId, input.displayName);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`social-graph-proposal:${actor.characterId}:${current.personId}:${message.id}:${nameKey(input.displayName)}`}, 0))`);
      const currentPersonIds = await currentLinkedPersonIds(tx, current.personId);
      const [self] = await tx.select({ displayName: people.displayName }).from(people).where(eq(people.id, current.personId)).limit(1);
      const subject = await this.actorEntity(tx, actor, current.personId, currentPersonIds, self?.displayName ?? 'You');
      const targetPersonId = input.verifiedTargetIdentityId
        ? await this.targetPerson(tx, input.verifiedTargetIdentityId, current.personId)
        : null;
      const normalizedName = nameKey(input.displayName);
      const proposals = await tx.select({ edge: relationshipEdges, entity: personEntities }).from(relationshipEdges)
        .innerJoin(personEntities, eq(personEntities.id, relationshipEdges.objectEntityId))
        .where(and(
          eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.subjectEntityId, subject.id),
          eq(relationshipEdges.sourceMessageId, message.id), eq(relationshipEdges.kind, 'introduction_proposal'),
          eq(relationshipEdges.status, 'candidate'), isNull(relationshipEdges.validTo),
        )).for('share');
      const prior = proposals.find(({ entity }) => nameKey(entity.displayName) === normalizedName);
      if (prior) {
        if (prior.entity.personId !== targetPersonId) throw new Error('source introduction already has a different explicit identity target');
        return { entityId: prior.entity.id, version: prior.entity.version, created: false };
      }
      const [entity] = await tx.insert(personEntities).values({
        characterId: actor.characterId, personId: targetPersonId, displayName: input.displayName.trim(), confirmed: false,
      }).returning();
      if (!entity) throw new Error('friend proposal entity could not be created');
      await tx.insert(relationshipEdges).values({
        characterId: actor.characterId, subjectEntityId: subject.id, objectEntityId: entity.id,
        kind: 'introduction_proposal', status: 'candidate', sourceMessageId: message.id, validFrom: new Date(),
      });
      await tx.insert(auditEvents).values({
        actorKind: 'person', actorId: current.personId, action: 'social_graph_introduction_proposed', targetId: entity.id,
        metadata: { characterId: actor.characterId, sourceMessageId: message.id },
      });
      return { entityId: entity.id, version: entity.version, created: true };
    });
  }

  private async characterEntity(tx: Transaction, characterId: string) {
    const [character] = await tx.select().from(characters).where(eq(characters.id, characterId)).limit(1).for('share');
    if (!character) throw new Error('character unavailable');
    const [existing] = await tx.select().from(personEntities).where(and(
      eq(personEntities.id, roleEntityId(`character:${characterId}`)),
      eq(personEntities.characterId, characterId), isNull(personEntities.personId), eq(personEntities.confirmed, true),
    )).for('update').limit(1);
    if (existing) return existing;
    const [created] = await tx.insert(personEntities).values({
      id: roleEntityId(`character:${characterId}`), characterId, displayName: character.name, confirmed: true,
    }).returning();
    if (!created) throw new Error('character entity could not be created');
    return created;
  }

  /** Confirms one side of the relation at a time, using the proposal version as a CAS fence. */
  async confirmRelationship(actor: ActorContext, messageId: string, input: { entityId: string; expectedVersion: number; kind: SocialRelationKind }): Promise<{ entityId: string; version: number; edgeId: string; created: boolean }> {
    if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
    if (!messageId || !input || !['user_friend', 'character_friend'].includes(input.kind) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('valid relationship confirmation required');
    }
    return this.database.db.transaction(async (tx) => {
      const { current, message: confirmationMessage } = await this.sourceForActor(tx, actor, messageId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`social-graph:${actor.characterId}:${current.personId}:${input.entityId}`}, 0))`);
      const [entity] = await tx.select().from(personEntities).where(and(
        eq(personEntities.id, input.entityId), eq(personEntities.characterId, actor.characterId),
      )).for('update').limit(1);
      if (!entity) throw new Error('friend proposal unavailable');
      const [proposal] = await tx.select({ edge: relationshipEdges, subject: personEntities }).from(relationshipEdges)
        .innerJoin(personEntities, eq(personEntities.id, relationshipEdges.subjectEntityId))
        .where(and(
          eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.objectEntityId, entity.id),
          eq(relationshipEdges.kind, 'introduction_proposal'), eq(relationshipEdges.status, 'candidate'),
          isNull(relationshipEdges.validTo),
        )).limit(1);
      if (!proposal?.edge.sourceMessageId) throw new Error('friend proposal source unavailable');
      const { message } = await this.sourceForActor(tx, actor, proposal.edge.sourceMessageId, entity.displayName);
      if (!explicitConfirmation(confirmationMessage.text ?? '', entity.displayName, input.kind)) throw new Error('explicit current-turn confirmation required');
      const subject = await this.actorEntity(tx, actor, current.personId, current.linkedPersonIds, proposal.subject.displayName);
      if (proposal.edge.subjectEntityId !== subject.id) throw new Error('friend proposal belongs to another actor');

      const edgeKind = input.kind;
      const [alreadyConfirmed] = await tx.select().from(relationshipEdges).where(and(
        eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.sourceMessageId, confirmationMessage.id),
        eq(relationshipEdges.objectEntityId, entity.id), eq(relationshipEdges.kind, edgeKind),
        eq(relationshipEdges.status, 'confirmed'), isNull(relationshipEdges.validTo),
      )).limit(1);
      if (alreadyConfirmed) return { entityId: entity.id, version: entity.version, edgeId: alreadyConfirmed.id, created: false };
      if (confirmationMessage.id === message.id) throw new Error('confirmation must be a fresh message after the proposal');
      const [priorSide] = await tx.select({ id: relationshipEdges.id }).from(relationshipEdges).where(and(
        eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.objectEntityId, entity.id),
        eq(relationshipEdges.kind, edgeKind), eq(relationshipEdges.status, 'confirmed'), isNull(relationshipEdges.validTo),
      )).limit(1);
      if (priorSide) throw new Error('relationship side already confirmed by a different message');
      const [usedConfirmation] = await tx.select({ id: relationshipEdges.id }).from(relationshipEdges).where(and(
        eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.objectEntityId, entity.id),
        eq(relationshipEdges.sourceMessageId, confirmationMessage.id), eq(relationshipEdges.status, 'confirmed'), isNull(relationshipEdges.validTo),
      )).limit(1);
      if (usedConfirmation) throw new Error('each relationship side requires a fresh confirmation message');
      if (entity.version !== input.expectedVersion) throw new Error('stale person entity version');
      const relationSubject = input.kind === 'user_friend' ? subject : await this.characterEntity(tx, actor.characterId);
      if (input.kind === 'character_friend') {
        const [userEdge] = await tx.select({ id: relationshipEdges.id }).from(relationshipEdges).where(and(
          eq(relationshipEdges.characterId, actor.characterId),
          eq(relationshipEdges.subjectEntityId, subject.id), eq(relationshipEdges.objectEntityId, entity.id),
          eq(relationshipEdges.kind, 'user_friend'), eq(relationshipEdges.status, 'confirmed'), isNull(relationshipEdges.validTo),
        )).limit(1);
        if (!userEdge) throw new Error('user friendship must be confirmed first');
      }
      const [updated] = await tx.update(personEntities).set({ confirmed: true, version: sql`${personEntities.version} + 1` })
        .where(and(eq(personEntities.id, entity.id), eq(personEntities.version, input.expectedVersion))).returning({ version: personEntities.version });
      if (!updated) throw new Error('stale person entity version');
      const [edge] = await tx.insert(relationshipEdges).values({
        characterId: actor.characterId, subjectEntityId: relationSubject.id, objectEntityId: entity.id,
        kind: edgeKind, status: 'confirmed', sourceMessageId: confirmationMessage.id, validFrom: new Date(),
      }).returning();
      if (!edge) throw new Error('relationship confirmation failed');
      await tx.insert(auditEvents).values({
        actorKind: 'person', actorId: current.personId, action: `social_graph_${input.kind}_confirmed`, targetId: edge.id,
        metadata: { characterId: actor.characterId, entityId: entity.id, sourceMessageId: confirmationMessage.id, expectedVersion: input.expectedVersion, version: updated.version },
      });
      return { entityId: entity.id, version: updated.version, edgeId: edge.id, created: true };
    });
  }

  /** Only source-backed relations from the caller's current private conversation are visible. */
  async listForActor(actor: ActorContext): Promise<ConfirmedSocialRelation[]> {
    if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
    return this.database.db.transaction(async (tx) => {
      const current = await this.requirePrivateCurrentActor(tx, actor);
      const authorization = await this.policy.authorizationSnapshot(actor, tx);
      if (!authorization.allowedScopes.some((scope) => scope.kind === 'conversation_shared' && scope.conversationId === current.conversation.id)) return [];
      const personIds = await currentLinkedPersonIds(tx, current.personId);
      const subjects = await tx.select({ id: personEntities.id }).from(personEntities).where(and(
        eq(personEntities.characterId, actor.characterId), inArray(personEntities.personId, personIds),
      ));
      if (!subjects.length) return [];
      const userEdges = await tx.select({ edge: relationshipEdges, entity: personEntities, source: messages }).from(relationshipEdges)
        .innerJoin(personEntities, eq(personEntities.id, relationshipEdges.objectEntityId))
        .innerJoin(messages, eq(messages.id, relationshipEdges.sourceMessageId))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          eq(relationshipEdges.characterId, actor.characterId), inArray(relationshipEdges.subjectEntityId, subjects.map(({ id }) => id)),
          eq(relationshipEdges.kind, 'user_friend'), eq(relationshipEdges.status, 'confirmed'), isNull(relationshipEdges.validTo),
          eq(messages.conversationId, current.conversation.id), eq(messages.role, 'user'), isNull(messages.deletedAt),
          eq(conversations.kind, 'private'), eq(conversations.characterId, actor.characterId),
        )).for('share');
      const result: ConfirmedSocialRelation[] = [];
      for (const { edge, entity, source: confirmation } of userEdges) {
        if (!confirmation.personId || await canonicalPersonId(tx, confirmation.personId) !== current.personId || !explicitConfirmation(confirmation.text ?? '', entity.displayName, 'user_friend')) continue;
        const [proposal] = await tx.select({ sourceMessageId: relationshipEdges.sourceMessageId }).from(relationshipEdges).where(and(
          eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.objectEntityId, entity.id),
          eq(relationshipEdges.kind, 'introduction_proposal'), eq(relationshipEdges.status, 'candidate'), isNull(relationshipEdges.validTo),
        )).limit(1);
        if (!proposal?.sourceMessageId) continue;
        let introduction;
        try { introduction = (await this.sourceForActor(tx, actor, proposal.sourceMessageId, entity.displayName)).message; }
        catch { continue; }
        result.push({ entityId: entity.id, edgeId: edge.id, displayName: entity.displayName, personId: entity.personId, sourceMessageId: introduction.id, kind: 'user_friend' });
        const [characterEdge] = await tx.select().from(relationshipEdges).where(and(
          eq(relationshipEdges.characterId, actor.characterId), eq(relationshipEdges.objectEntityId, entity.id),
          eq(relationshipEdges.kind, 'character_friend'),
          eq(relationshipEdges.status, 'confirmed'), isNull(relationshipEdges.validTo),
        )).limit(1);
        if (characterEdge?.sourceMessageId) {
          try {
            const { message: characterConfirmation } = await this.sourceForActor(tx, actor, characterEdge.sourceMessageId);
            if (explicitConfirmation(characterConfirmation.text ?? '', entity.displayName, 'character_friend')) result.push({ entityId: entity.id, edgeId: characterEdge.id, displayName: entity.displayName, personId: entity.personId, sourceMessageId: introduction.id, kind: 'character_friend' });
          } catch { /* a deleted or out-of-scope confirmation is not disclosed */ }
        }
      }
      return result;
    }, { isolationLevel: 'repeatable read' });
  }
}
