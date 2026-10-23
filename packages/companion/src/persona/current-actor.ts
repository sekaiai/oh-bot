import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { conversationMembers, conversations, people, personIdentityLinks, platformIdentities } from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';

type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
export type CurrentActor = { personId: string; linkedPersonIds: string[]; conversation: typeof conversations.$inferSelect; identity: typeof platformIdentities.$inferSelect };

export async function canonicalPersonId(tx: Transaction, personId: string): Promise<string> {
  const links = await tx.select({ alias: personIdentityLinks.aliasPersonId, canonical: personIdentityLinks.canonicalPersonId }).from(personIdentityLinks);
  const parent = new Map(links.map((row) => [row.alias, row.canonical]));
  const seen = new Set<string>();
  let current = personId;
  while (parent.has(current)) {
    if (seen.has(current)) throw new Error('identity link cycle');
    seen.add(current);
    current = parent.get(current)!;
  }
  return current;
}

export async function currentLinkedPersonIds(tx: Transaction, canonicalId: string): Promise<string[]> {
  const links = await tx.select({ alias: personIdentityLinks.aliasPersonId, canonical: personIdentityLinks.canonicalPersonId }).from(personIdentityLinks);
  const candidates = new Set<string>([canonicalId, ...links.map((row) => row.alias)]);
  const result: string[] = [];
  for (const candidate of candidates) if (await canonicalPersonIdFromLinks(candidate, links) === canonicalId) result.push(candidate);
  return result;
}

function canonicalPersonIdFromLinks(personId: string, links: Array<{ alias: string; canonical: string }>): string {
  const parent = new Map(links.map((row) => [row.alias, row.canonical]));
  const seen = new Set<string>();
  let current = personId;
  while (parent.has(current)) {
    if (seen.has(current)) throw new Error('identity link cycle');
    seen.add(current);
    current = parent.get(current)!;
  }
  return current;
}

export async function requireCurrentActor(tx: Transaction, actor: ActorContext): Promise<CurrentActor> {
  const [identity] = await tx.select().from(platformIdentities).where(eq(platformIdentities.id, actor.platformIdentityId)).limit(1);
  if (!identity || !identity.verifiedAt) throw new Error('verified actor identity unavailable');
  const canonicalId = await canonicalPersonId(tx, identity.personId);
  if (canonicalId !== actor.personId) throw new Error('actor identity is stale');
  const [person] = await tx.select().from(people).where(eq(people.id, canonicalId)).limit(1);
  if (!person || person.status !== 'active') throw new Error('active canonical person required');
  const [conversation] = await tx.select().from(conversations).where(and(
    eq(conversations.id, actor.conversationId), eq(conversations.characterId, actor.characterId),
    eq(conversations.kind, actor.conversationKind), eq(conversations.platform, identity.platform),
  )).limit(1);
  if (!conversation) throw new Error('current conversation unavailable');
  const linkedPersonIds = await currentLinkedPersonIds(tx, canonicalId);
  const [membership] = await tx.select({ personId: conversationMembers.personId }).from(conversationMembers).where(and(
    eq(conversationMembers.conversationId, conversation.id), inArray(conversationMembers.personId, linkedPersonIds),
    isNotNull(conversationMembers.confirmedAt),
  )).limit(1);
  if (!membership) throw new Error('confirmed current conversation membership required');
  return { personId: canonicalId, linkedPersonIds, conversation, identity };
}
