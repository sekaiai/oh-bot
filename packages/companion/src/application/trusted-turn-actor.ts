import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { conversationMembers, conversations, messages, platformIdentities, turns } from '../database/schema/index.js';
import { createVerifiedChannelEvidence } from '../identity/trust.js';
import type { IdentityService } from '../identity/identity-service.js';
import type { Platform } from '../domain/contracts.js';

/** Rebuild a fresh trusted actor from the exact source row accepted by InboundService. */
export async function resolvePersistedTurnActor(database: Database, identity: IdentityService, turnId: string) {
  const [row] = await database.db.select({
    turn: turns,
    message: messages,
    conversation: conversations,
  }).from(turns)
    .innerJoin(messages, eq(messages.id, turns.inboundMessageId))
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(eq(turns.id, turnId)).limit(1);
  if (!row || row.message.role !== 'user' || row.message.deletedAt || row.message.conversationId !== row.turn.conversationId ||
      row.conversation.id !== row.turn.conversationId || row.conversation.characterId.length === 0 || row.message.personId !== row.turn.personId ||
      row.message.platform !== row.conversation.platform) throw new Error('turn_source_unavailable');
  const metadata = row.message.metadata as Record<string, unknown>;
  const marker = metadata?.authenticatedChannel as Record<string, unknown> | undefined;
  if (!marker || marker.version !== 1 || marker.platform !== row.message.platform ||
      typeof marker.platformUserId !== 'string' || typeof marker.channelId !== 'string' ||
      marker.channelId !== row.conversation.platformConversationId || marker.conversationKind !== row.conversation.kind ||
      typeof marker.platformIdentityId !== 'string') throw new Error('turn_source_untrusted');
  const [storedIdentity] = await database.db.select().from(platformIdentities)
    .where(and(eq(platformIdentities.id, marker.platformIdentityId), eq(platformIdentities.platform, row.message.platform), eq(platformIdentities.platformUserId, marker.platformUserId)))
    .limit(1);
  if (!storedIdentity || storedIdentity.personId !== row.turn.personId || row.message.personId !== storedIdentity.personId) throw new Error('turn_identity_mismatch');
  const [membership] = await database.db.select({ personId: conversationMembers.personId })
    .from(conversationMembers).where(and(eq(conversationMembers.conversationId, row.conversation.id), eq(conversationMembers.personId, storedIdentity.personId), isNotNull(conversationMembers.confirmedAt))).limit(1);
  if (!membership) throw new Error('turn_membership_unconfirmed');
  const evidence = createVerifiedChannelEvidence(row.message.platform as Platform, marker.channelId, marker.platformUserId, row.conversation.kind);
  return identity.resolveActorContext({
    platform: row.message.platform as Platform,
    platformUserId: marker.platformUserId,
    characterId: row.conversation.characterId,
    conversationId: row.conversation.id,
  }, evidence);
}
