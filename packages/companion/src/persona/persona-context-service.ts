import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { auditEvents, characterVersions, characters, people, primaryRelationshipBindings } from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';
import { isAuthenticatedAdminPrincipal, type AuthenticatedAdminPrincipal } from '../admin/auth.js';
import { isTrustedActorContext } from '../identity/trust.js';
import { canonicalPersonId, currentLinkedPersonIds, requireCurrentActor } from './current-actor.js';
import { SocialGraphService } from '../relationships/social-graph-service.js';

const personaSchema = z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32);
const adultPersona = Object.freeze({ age: '成年', name: '南枝', traits: Object.freeze(['温柔', '主动表达', '有主见', '尊重空间']) });

export class PersonaContextService {
  constructor(private readonly database: Database) {}

  async publish(characterId: string, core: unknown, principal: AuthenticatedAdminPrincipal): Promise<{ id: string; revision: number; core: unknown }> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new Error('authenticated admin required');
    if (!z.string().uuid().safeParse(characterId).success) throw new Error('invalid character');
    const parsed = personaSchema.parse(core);
    return this.database.db.transaction(async (tx) => {
      const [character] = await tx.select().from(characters).where(eq(characters.id, characterId)).for('update').limit(1);
      if (!character) throw new Error('character unavailable');
      const [latest] = await tx.select().from(characterVersions).where(eq(characterVersions.characterId, characterId)).orderBy(desc(characterVersions.revision)).limit(1);
      const revision = (latest?.revision ?? 0) + 1;
      const value = { ...parsed, age: adultPersona.age, name: adultPersona.name, traits: parsed.traits ?? adultPersona.traits };
      const [version] = await tx.insert(characterVersions).values({ characterId, revision, core: value, createdBy: principal.auditActorId }).returning();
      await tx.update(characters).set({ currentVersionId: version!.id, version: character.version + 1 }).where(eq(characters.id, characterId));
      return { id: version!.id, revision, core: value };
    });
  }

  async setPrimaryPartner(characterId: string, personId: string, principal: AuthenticatedAdminPrincipal): Promise<void> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new Error('authenticated admin required');
    if (!z.string().uuid().safeParse(characterId).success || !z.string().uuid().safeParse(personId).success) throw new Error('invalid binding');
    await this.database.db.transaction(async (tx) => {
      const [character] = await tx.select({ id: characters.id }).from(characters).where(eq(characters.id, characterId)).for('update').limit(1);
      if (!character) throw new Error('character unavailable');
      const canonicalId = await canonicalPersonId(tx, personId);
      const [person] = await tx.select({ id: people.id, status: people.status }).from(people).where(eq(people.id, canonicalId)).limit(1);
      if (!person || person.status !== 'active') throw new Error('active canonical person required');
      const [prior] = await tx.select().from(primaryRelationshipBindings).where(eq(primaryRelationshipBindings.characterId, characterId)).limit(1);
      const priorCanonical = prior ? await canonicalPersonId(tx, prior.personId) : null;
      if (prior && priorCanonical === canonicalId) return;
      if (prior) await tx.delete(primaryRelationshipBindings).where(eq(primaryRelationshipBindings.characterId, characterId));
      await tx.insert(primaryRelationshipBindings).values({ characterId, personId: canonicalId, createdBy: principal.auditActorId });
      await tx.insert(auditEvents).values({
        actorKind: 'admin', actorId: principal.auditActorId, action: 'primary_partner_changed', targetId: characterId,
        metadata: { oldPersonId: priorCanonical, newPersonId: canonicalId },
      });
    });
  }

  async buildContext(actor: ActorContext): Promise<string> {
    if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
    const socialRelations = await new SocialGraphService(this.database).listForActor(actor);
    return this.database.db.transaction(async (tx) => {
      const current = await requireCurrentActor(tx, actor);
      const [character] = await tx.select().from(characters).where(eq(characters.id, actor.characterId)).limit(1);
      if (!character) throw new Error('character unavailable');
      const [version] = character.currentVersionId
        ? await tx.select().from(characterVersions).where(and(eq(characterVersions.id, character.currentVersionId), eq(characterVersions.characterId, character.id))).limit(1)
        : [];
      const [binding] = await tx.select().from(primaryRelationshipBindings).where(eq(primaryRelationshipBindings.characterId, character.id)).limit(1);
      const bindingPersonId = binding ? await canonicalPersonId(tx, binding.personId) : undefined;
      const isPartner = bindingPersonId === current.personId;
      const linkedNow = await currentLinkedPersonIds(tx, current.personId);
      if (!linkedNow.includes(current.identity.personId)) throw new Error('actor identity link changed');
      const core = version?.core ?? adultPersona;
      const relationSummary = socialRelations.length
        ? `已确认的关系事实：${socialRelations.map((relation) => `${relation.displayName}（${relation.kind === 'user_friend' ? '用户的朋友' : '角色的朋友/熟人'}）`).join('、')}`
        : '已确认的关系事实：无';
      return [
        `角色核心人格：${JSON.stringify(core)}`,
        `关系定位：${isPartner ? '已绑定的唯一伴侣' : '朋友与共同社交圈成员'}`,
        relationSummary,
      ].join('\n');
    });
  }
}
