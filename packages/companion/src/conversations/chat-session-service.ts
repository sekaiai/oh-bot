import { desc, and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { conversations, messages } from '../database/schema/index.js';
import {
  inboundEventSchema,
  type ConversationKind,
  type InboundEvent,
} from '../domain/contracts.js';
import {
  IdentityService,
  type VerifiedChannelEvidence,
} from '../identity/identity-service.js';
import {
  InboundService,
  type InboundAccepted,
} from '../transactions/inbound-service.js';
import { CompanionError } from '../transactions/errors.js';
import { readVerifiedChannelSubject } from '../identity/trust.js';

const characterIdSchema = z.string().uuid();
const historyOptionsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export type LocalChatSession = Readonly<{
  characterId: string;
  conversationId: string;
  personId: string;
  platformIdentityId: string;
  conversationKind: ConversationKind;
  linkedPersonIds: readonly string[];
}>;

export type AcceptedLocalChatMessage = Readonly<{
  session: LocalChatSession;
  accepted: InboundAccepted;
}>;

export type LocalChatHistoryMessage = Readonly<{
  messageId: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  personId: string | null;
  platformEventId: string;
  occurredAt: string | null;
  receivedAt: string;
}>;

export type LocalChatHistory = Readonly<{
  session: LocalChatSession;
  messages: readonly LocalChatHistoryMessage[];
}>;

export type LocalChatHistoryOptions = Readonly<{
  limit?: number;
}>;

export class LocalChatSessionService {
  constructor(
    private readonly database: Database,
    private readonly identityService: IdentityService,
    private readonly inboundService: InboundService = new InboundService(database, identityService),
  ) {}

  async acceptMessage(
    characterId: string,
    event: InboundEvent,
    evidence: VerifiedChannelEvidence,
  ): Promise<AcceptedLocalChatMessage> {
    const parsedCharacterId = characterIdSchema.safeParse(characterId);
    const parsedEvent = inboundEventSchema.safeParse(event);
    if (!parsedCharacterId.success || !parsedEvent.success) {
      throw new CompanionError('invalid_input');
    }
    const subject = this.requireSubject(evidence);
    if (
      parsedEvent.data.platform !== subject.platform ||
      parsedEvent.data.senderPlatformId !== subject.platformUserId ||
      parsedEvent.data.conversationPlatformId !== subject.channelId ||
      parsedEvent.data.conversationKind !== subject.conversationKind
    ) {
      throw new CompanionError('invalid_evidence');
    }
    if (subject.conversationKind !== 'private') {
      throw new CompanionError('unsupported_conversation_kind');
    }

    const accepted = await this.inboundService.accept(parsedCharacterId.data, parsedEvent.data, evidence);
    const session = await this.resolveSession(
      parsedCharacterId.data,
      subject.platform,
      subject.platformUserId,
      accepted.conversationId,
      evidence,
    );
    return { session, accepted };
  }

  async readHistory(
    characterId: string,
    evidence: VerifiedChannelEvidence,
    options: LocalChatHistoryOptions = {},
  ): Promise<LocalChatHistory | null> {
    const parsedCharacterId = characterIdSchema.safeParse(characterId);
    const parsedOptions = historyOptionsSchema.safeParse(options);
    if (!parsedCharacterId.success || !parsedOptions.success) {
      throw new CompanionError('invalid_input');
    }
    const subject = this.requireSubject(evidence);
    if (subject.conversationKind !== 'private') {
      throw new CompanionError('unsupported_conversation_kind');
    }

    const [conversation] = await this.database.db.select({ id: conversations.id })
      .from(conversations)
      .where(and(
        eq(conversations.characterId, parsedCharacterId.data),
        eq(conversations.platform, subject.platform),
        eq(conversations.platformConversationId, subject.channelId),
        eq(conversations.kind, 'private'),
      ))
      .limit(1);
    if (!conversation) return null;

    const session = await this.resolveSession(
      parsedCharacterId.data,
      subject.platform,
      subject.platformUserId,
      conversation.id,
      evidence,
    );

    const rows = await this.database.db.select({
      id: messages.id,
      role: messages.role,
      text: messages.text,
      personId: messages.personId,
      platformEventId: messages.platformEventId,
      occurredAt: messages.occurredAt,
      receivedAt: messages.receivedAt,
    }).from(messages).where(and(
      eq(messages.conversationId, session.conversationId),
      isNull(messages.deletedAt),
      or(
        isNull(messages.personId),
        inArray(messages.personId, [...session.linkedPersonIds]),
      ),
    )).orderBy(desc(messages.receivedAt), desc(messages.id)).limit(parsedOptions.data.limit);

    const ordered = [...rows].reverse().map((row) => Object.freeze({
      messageId: row.id,
      role: row.role,
      text: row.text ?? '',
      personId: row.personId,
      platformEventId: row.platformEventId,
      occurredAt: row.occurredAt?.toISOString() ?? null,
      receivedAt: row.receivedAt.toISOString(),
    }));

    return Object.freeze({
      session,
      messages: Object.freeze(ordered),
    });
  }

  private requireSubject(evidence: VerifiedChannelEvidence): {
    platform: 'qq' | 'weixin' | 'dingtalk';
    channelId: string;
    platformUserId: string;
    conversationKind: 'private' | 'group';
  } {
    const subject = readVerifiedChannelSubject(evidence);
    if (!subject) throw new CompanionError('invalid_evidence');
    return subject;
  }

  private async resolveSession(
    characterId: string,
    platform: 'qq' | 'weixin' | 'dingtalk',
    platformUserId: string,
    conversationId: string,
    evidence: VerifiedChannelEvidence,
  ): Promise<LocalChatSession> {
    try {
      const actor = await this.identityService.resolveActorContext({
        platform,
        platformUserId,
        characterId,
        conversationId,
      }, evidence);
      if (actor.conversationKind !== 'private') {
        throw new CompanionError('unsupported_conversation_kind');
      }
      if (actor.characterId !== characterId || actor.conversationId !== conversationId) {
        throw new CompanionError('session_unauthorized');
      }
      return Object.freeze({
        characterId: actor.characterId,
        conversationId: actor.conversationId,
        personId: actor.personId,
        platformIdentityId: actor.platformIdentityId,
        conversationKind: actor.conversationKind,
        linkedPersonIds: Object.freeze([...actor.linkedPersonIds]),
      });
    } catch (error) {
      if (error instanceof CompanionError) throw error;
      throw new CompanionError('session_unauthorized');
    }
  }
}
