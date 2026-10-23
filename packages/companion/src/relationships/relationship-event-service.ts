import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { emotionStates, interactionEvents, messages, relationshipStates } from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';
import { isTrustedActorContext } from '../identity/trust.js';
import { canonicalPersonId, requireCurrentActor } from '../persona/current-actor.js';

export type GroundedInteractionKind =
  | 'conversation' | 'appreciation' | 'shared_experience' | 'boundary_respected'
  | 'distress' | 'direct_attack' | 'quoted_attack' | 'refusal' | 'late_reply' | 'delay';
export type InteractionAnalyzer = (text: string) => GroundedInteractionKind;
type Delta = { familiarity: number; trust: number; pleasantness: number; activity: number; tension: number; care: number };
const deltas: Record<GroundedInteractionKind, Delta> = {
  conversation: { familiarity: .01, trust: 0, pleasantness: 0, activity: 0, tension: 0, care: 0 },
  appreciation: { familiarity: .01, trust: .02, pleasantness: .03, activity: 0, tension: 0, care: .02 },
  shared_experience: { familiarity: .02, trust: .01, pleasantness: .02, activity: .01, tension: 0, care: .01 },
  boundary_respected: { familiarity: 0, trust: .02, pleasantness: .01, activity: 0, tension: -.01, care: .02 },
  distress: { familiarity: 0, trust: 0, pleasantness: 0, activity: .03, tension: .03, care: .04 },
  direct_attack: { familiarity: 0, trust: -.03, pleasantness: -.03, activity: .02, tension: .03, care: 0 },
  quoted_attack: { familiarity: 0, trust: 0, pleasantness: 0, activity: 0, tension: 0, care: 0 },
  refusal: { familiarity: 0, trust: 0, pleasantness: 0, activity: 0, tension: 0, care: 0 },
  late_reply: { familiarity: 0, trust: 0, pleasantness: 0, activity: 0, tension: 0, care: 0 },
  delay: { familiarity: 0, trust: 0, pleasantness: 0, activity: 0, tension: 0, care: 0 },
};

export class RelationshipEventService {
  constructor(private readonly database: Database, private readonly analyze: InteractionAnalyzer) {}

  async recordIncoming(actor: ActorContext, messageId: string): Promise<{ applied: boolean; kind?: GroundedInteractionKind }> {
    if (!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) throw new Error('valid source message required');
    return this.database.db.transaction(async (tx) => {
      const current = await requireCurrentActor(tx, actor);
      const [source] = await tx.select({ text: messages.text, personId: messages.personId }).from(messages).where(and(
        eq(messages.id, messageId), eq(messages.role, 'user'), eq(messages.conversationId, current.conversation.id),
      )).limit(1);
      if (!source?.text?.trim() || !source.personId || await canonicalPersonId(tx, source.personId) !== current.personId) throw new Error('source message unavailable');
      let kind: GroundedInteractionKind;
      try {
        const result: unknown = this.analyze(source.text);
        if (typeof result !== 'string' || !Object.hasOwn(deltas, result)) return { applied: false };
        kind = result as GroundedInteractionKind;
      } catch {
        return { applied: false };
      }
      const delta = deltas[kind];
      const now = new Date();
      const key = `incoming:${messageId}`;
      const [event] = await tx.insert(interactionEvents).values({
        eventKey: key, characterId: actor.characterId, personId: current.personId, sourceMessageId: messageId,
        kind, payload: { sourceMessageId: messageId, kind, delta }, appliedAt: now,
      }).onConflictDoNothing({ target: interactionEvents.eventKey }).returning({ id: interactionEvents.id });
      if (!event) return { applied: false, kind };

      await tx.insert(relationshipStates).values({
        characterId: actor.characterId, personId: current.personId,
        familiarity: delta.familiarity, trust: Math.max(0, delta.trust), lastEventAt: now,
      }).onConflictDoUpdate({
        target: [relationshipStates.characterId, relationshipStates.personId],
        set: {
          familiarity: sql`greatest(0, least(1, ${relationshipStates.familiarity} + ${delta.familiarity}))`,
          trust: sql`greatest(0, least(1, ${relationshipStates.trust} + ${delta.trust}))`,
          lastEventAt: now, version: sql`${relationshipStates.version} + 1`,
        },
      });
      await tx.insert(emotionStates).values({
        characterId: actor.characterId, personId: current.personId,
        pleasantness: delta.pleasantness, activity: .5 + delta.activity, tension: delta.tension,
        care: .5 + delta.care, lastEventAt: now,
      }).onConflictDoUpdate({
        target: [emotionStates.characterId, emotionStates.personId],
        set: {
          pleasantness: sql`greatest(-1, least(1, ${emotionStates.pleasantness} + ${delta.pleasantness}))`,
          activity: sql`greatest(0, least(1, ${emotionStates.activity} + ${delta.activity}))`,
          tension: sql`greatest(0, least(1, ${emotionStates.tension} + ${delta.tension}))`,
          care: sql`greatest(0, least(1, ${emotionStates.care} + ${delta.care}))`,
          lastEventAt: now, version: sql`${emotionStates.version} + 1`,
        },
      });
      return { applied: true, kind };
    });
  }
}
