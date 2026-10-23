import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import {
  businessOutbox,
  conversationMembers,
  conversations,
  messages,
  turns,
} from '../database/schema/index.js';
import { inboundEventSchema, type InboundEvent, type Platform } from '../domain/contracts.js';
import type { IdentityService, VerifiedChannelEvidence } from '../identity/identity-service.js';
import {
  createRosterMemberEvidence,
  isTrustedEvidence,
  readTrustedRoster,
  type TrustedRosterEvidence,
} from '../identity/trust.js';
import { CompanionError } from './errors.js';

const characterIdSchema = z.string().uuid();
const platformSchema = z.enum(['qq', 'weixin', 'dingtalk']);
const eventLockKey = (event: InboundEvent) =>
  JSON.stringify(['oh-bot-inbound', event.platform, event.eventId]);

function fingerprint(characterId: string, event: InboundEvent): string {
  const canonicalPayload = {
    characterId,
    platform: event.platform,
    conversation: event.conversationPlatformId,
    kind: event.conversationKind,
    sender: event.senderPlatformId,
    text: event.text,
    timestamp: event.timestamp,
    replyTo: event.replyToEventId ?? null,
    participants: [...new Set(event.participantPlatformIds)].sort(),
    complete: event.participantsComplete,
  };
  return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}

export type InboundAccepted = Readonly<{
  messageId: string;
  turnId: string;
  conversationId: string;
  duplicate: boolean;
}>;

export class InboundService {
  constructor(
    private readonly database: Database,
    private readonly identityService: IdentityService,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async accept(
    characterId: string,
    input: InboundEvent,
    evidence: VerifiedChannelEvidence,
  ): Promise<InboundAccepted> {
    const parsed = inboundEventSchema.safeParse(input);
    if (!parsed.success || !characterIdSchema.safeParse(characterId).success) {
      throw new CompanionError('invalid_input');
    }
    const event = parsed.data;
    if (
      !isTrustedEvidence(evidence, event.senderPlatformId, event.conversationKind, event.conversationPlatformId) ||
      evidence.platform !== event.platform
    ) throw new CompanionError('invalid_evidence');

    let identity: Awaited<ReturnType<IdentityService['resolveIdentity']>>;
    try {
      identity = await this.identityService.resolveIdentity({
        platform: event.platform,
        platformUserId: event.senderPlatformId,
      }, evidence);
    } catch {
      throw new CompanionError('identity_resolution_failed');
    }

    try {
      return await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${eventLockKey(event)}, 0))`);
        const [prior] = await tx.select({
          messageId: messages.id,
          conversationId: messages.conversationId,
          personId: messages.personId,
          turnId: turns.id,
          metadata: messages.metadata,
        }).from(messages)
          .innerJoin(turns, eq(turns.inboundMessageId, messages.id))
          .where(and(
            eq(messages.platform, event.platform),
            eq(messages.platformEventId, event.eventId),
          )).limit(1);
        const digest = fingerprint(characterId, event);

        if (prior) {
          const storedDigest = (prior.metadata as { fingerprint?: string }).fingerprint;
          if (storedDigest !== digest) {
            throw new CompanionError('replay_conflict');
          }
          return {
            messageId: prior.messageId,
            turnId: prior.turnId,
            conversationId: prior.conversationId,
            duplicate: true,
          };
        }

        const proposedConversationId = randomUUID();
        await tx.insert(conversations).values({
          id: proposedConversationId,
          characterId,
          platform: event.platform,
          platformConversationId: event.conversationPlatformId,
          kind: event.conversationKind,
          participantsComplete: false,
          rosterObservedAt: null,
          rosterInvalidatedAt: null,
        }).onConflictDoNothing();
        const [conversation] = await tx.select().from(conversations).where(and(
          eq(conversations.characterId, characterId),
          eq(conversations.platform, event.platform),
          eq(conversations.platformConversationId, event.conversationPlatformId),
          eq(conversations.kind, event.conversationKind),
        )).for('update').limit(1);
        if (!conversation) throw new CompanionError('transaction_failed');

        if (event.conversationKind === 'private') {
          const members = await tx.select({ personId: conversationMembers.personId })
            .from(conversationMembers)
            .where(eq(conversationMembers.conversationId, conversation.id))
            .for('update');
          if (members.length && !members.some((member) => identity.linkedPersonIds.includes(member.personId))) {
            throw new CompanionError('conversation_member_mismatch');
          }
        }

        const receivedAt = this.now();
        await tx.update(conversations).set({
          participantsComplete: false,
          rosterInvalidatedAt: sql`greatest(coalesce(${conversations.rosterInvalidatedAt}, '-infinity'::timestamptz), ${receivedAt})`,
          version: sql`${conversations.version} + 1`,
          updatedAt: receivedAt,
        }).where(eq(conversations.id, conversation.id));
        const [message] = await tx.insert(messages).values({
          conversationId: conversation.id,
          personId: identity.personId,
          platform: event.platform,
          platformEventId: event.eventId,
          role: 'user',
          text: event.text,
          occurredAt: new Date(event.timestamp),
          receivedAt,
          metadata: { fingerprint: digest, replyToEventId: event.replyToEventId ?? null },
        }).returning({ id: messages.id });
        if (!message) throw new CompanionError('transaction_failed');

        const turnId = randomUUID();
        await tx.insert(turns).values({
          id: turnId,
          conversationId: conversation.id,
          inboundMessageId: message.id,
          personId: identity.personId,
          status: 'received',
          graphThreadId: turnId,
        });
        await tx.insert(businessOutbox).values({
          operationKey: `turn:${turnId}:process`,
          kind: 'process_turn',
          payload: {
            turnId,
            characterId,
            conversationId: conversation.id,
            messageId: message.id,
          },
        });
        await tx.insert(conversationMembers).values({
          conversationId: conversation.id,
          personId: identity.personId,
          confirmedAt: receivedAt,
        }).onConflictDoUpdate({
          target: [conversationMembers.conversationId, conversationMembers.personId],
          set: { confirmedAt: receivedAt },
        });
        if (event.conversationKind === 'private') {
          await tx.delete(conversationMembers).where(and(
            eq(conversationMembers.conversationId, conversation.id),
            ne(conversationMembers.personId, identity.personId),
          ));
        }

        return {
          messageId: message.id,
          turnId,
          conversationId: conversation.id,
          duplicate: false,
        };
      });
    } catch (error) {
      if (error instanceof CompanionError) throw error;
      throw new CompanionError('transaction_failed');
    }
  }

  async updateVerifiedRoster(
    platform: Platform,
    channelId: string,
    evidence: TrustedRosterEvidence,
  ): Promise<void> {
    const roster = readTrustedRoster(evidence);
    if (
      !platformSchema.safeParse(platform).success ||
      !roster || roster.platform !== platform || roster.channelId !== channelId ||
      roster.memberIds.length === 0
    ) throw new CompanionError('invalid_roster_evidence');

    const members: Array<{ personId: string }> = [];
    for (const platformUserId of roster.memberIds) {
      try {
        const proof = createRosterMemberEvidence(evidence, platformUserId);
        const identity = await this.identityService.resolveIdentity({ platform, platformUserId }, proof);
        members.push({ personId: identity.personId });
      } catch {
        throw new CompanionError('identity_resolution_failed');
      }
    }

    const uniqueMembers = [...new Map(members.map((member) => [member.personId, member])).values()];

    try {
      await this.database.db.transaction(async (tx) => {
        const chats = await tx.select({
          id: conversations.id,
          rosterObservedAt: conversations.rosterObservedAt,
          rosterInvalidatedAt: conversations.rosterInvalidatedAt,
        }).from(conversations).where(and(
          eq(conversations.platform, platform),
          eq(conversations.platformConversationId, channelId),
          eq(conversations.kind, 'group'),
        )).orderBy(asc(conversations.id)).for('update');

        for (const chat of chats) {
          if (
            (chat.rosterObservedAt && chat.rosterObservedAt >= roster.observedAt) ||
            (chat.rosterInvalidatedAt && roster.observedAt < chat.rosterInvalidatedAt)
          ) continue;
          await tx.delete(conversationMembers).where(eq(conversationMembers.conversationId, chat.id));
          await tx.insert(conversationMembers).values(uniqueMembers.map((member) => ({
            conversationId: chat.id,
            personId: member.personId,
            confirmedAt: roster.observedAt,
          })));
          await tx.update(conversations).set({
            participantsComplete: true,
            rosterObservedAt: roster.observedAt,
            updatedAt: this.now(),
            version: sql`${conversations.version} + 1`,
          }).where(eq(conversations.id, chat.id));
        }
      });
    } catch (error) {
      if (error instanceof CompanionError) throw error;
      throw new CompanionError('transaction_failed');
    }
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new CompanionError('invalid_clock');
    }
    return value;
  }
}
