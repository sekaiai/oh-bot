import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { deliveryOutbox, messages, turns } from '../database/schema/index.js';
import type { InboundEvent } from '../domain/contracts.js';
import type { VerifiedChannelEvidence } from '../identity/identity-service.js';
import { ModelGatewayError, type ChatMessage, type ModelGateway } from '../models/chat-gateway.js';
import { CompanionError } from '../transactions/errors.js';
import { TurnService } from '../transactions/turn-service.js';
import { LocalChatSessionService } from './chat-session-service.js';
import { readVerifiedChannelSubject } from '../identity/trust.js';

export type LocalChatGenerationOptions = Readonly<{ system?: string; temperature?: number }>;
export type LocalChatResult = Readonly<{
  conversationId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  deliveryId: string;
  text: string;
  duplicate: boolean;
}>;

const lockKey = (characterId: string, platform: string, channelId: string) => `oh-bot-local-chat:${characterId}:${platform}:${channelId}`;

/** Orchestrates trusted local turns while leaving delivery pending in the normal outbox. */
export class LocalChatService {
  constructor(
    private readonly sessions: LocalChatSessionService,
    private readonly database: Database,
    private readonly gateway: ModelGateway,
    private readonly turnsService: TurnService = new TurnService(database),
    private readonly workerId = `local-cli:${randomUUID()}`,
  ) {}

  async handle(
    characterId: string,
    event: InboundEvent,
    evidence: VerifiedChannelEvidence,
    options: LocalChatGenerationOptions = {},
  ): Promise<LocalChatResult> {
    const subject = readVerifiedChannelSubject(evidence);
    if (!subject || subject.platform !== event.platform || subject.platformUserId !== event.senderPlatformId ||
        subject.channelId !== event.conversationPlatformId || subject.conversationKind !== event.conversationKind) {
      throw new CompanionError('invalid_evidence');
    }
    const client = await this.database.pool.connect();
    const key = lockKey(characterId, subject.platform, subject.channelId);
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [key]);
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new CompanionError('local_chat_busy');

      const accepted = await this.sessions.acceptMessage(characterId, event, evidence);

      const [turn] = await this.database.db.select({ status: turns.status }).from(turns).where(eq(turns.id, accepted.accepted.turnId)).limit(1);
      if (turn?.status === 'generated' || turn?.status === 'sent' || turn?.status === 'receipt_unknown') {
        return await this.recover(accepted.accepted.turnId, accepted.accepted.conversationId, accepted.accepted.messageId, true);
      }
      if (accepted.accepted.duplicate && turn?.status === 'failed') throw new CompanionError('local_chat_previous_failed');

      const lease = await this.turnsService.claim(accepted.accepted.turnId, this.workerId, 3_600_000);
      if (!lease) throw new CompanionError('local_chat_busy');
      try {
        const history = await this.sessions.readHistory(characterId, evidence, { limit: options.system ? 199 : 200 });
        if (!history || history.session.conversationId !== accepted.accepted.conversationId) throw new CompanionError('session_unauthorized');
        const messagesForModel: ChatMessage[] = [];
        if (options.system !== undefined) messagesForModel.push({ role: 'system', content: options.system });
        for (const message of history.messages) {
          if (message.role === 'tool') continue;
          messagesForModel.push({ role: message.role, content: message.text });
        }
        const reply = await this.gateway.complete({
          messages: messagesForModel.slice(-200),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        });
        const persistedText = reply.text.trim();
        const persisted = await this.turnsService.persistGenerated(lease, { text: persistedText });
        return Object.freeze({
          conversationId: accepted.accepted.conversationId,
          turnId: accepted.accepted.turnId,
          userMessageId: accepted.accepted.messageId,
          assistantMessageId: persisted.messageId,
          deliveryId: persisted.deliveryId,
          text: persistedText,
          duplicate: accepted.accepted.duplicate || persisted.duplicate,
        });
      } catch (error) {
        try { await this.turnsService.fail(lease, error instanceof CompanionError ? error.code : 'local_chat_generation_failed'); } catch { /* fencing may already have expired */ }
        if (error instanceof CompanionError) throw error;
        const code = error instanceof ModelGatewayError ? error.code : 'local_chat_generation_failed';
        throw new CompanionError(code);
      }
    } finally {
      if (locked) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>('select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked', [key]);
          if (unlocked.rows[0]?.unlocked !== true) throw new Error('unlock failed');
          client.release();
        } catch {
          client.release(new Error('local chat advisory lock release failed'));
          throw new CompanionError('local_chat_lock_release_failed');
        }
      } else client.release();
    }
  }

  private async recover(turnId: string, conversationId: string, userMessageId: string, duplicate: boolean): Promise<LocalChatResult> {
    const [turn, delivery] = await Promise.all([
      this.database.db.select({ id: turns.id }).from(turns).where(eq(turns.id, turnId)).limit(1),
      this.database.db.select({ id: deliveryOutbox.id, content: deliveryOutbox.content }).from(deliveryOutbox).where(eq(deliveryOutbox.turnId, turnId)).limit(1),
    ]);
    const [assistant] = await this.database.db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.conversationId, conversationId), eq(messages.platformEventId, `generated:${turnId}`),
      isNull(messages.deletedAt),
    )).limit(1);
    if (!turn[0] || !delivery[0] || !assistant || typeof (delivery[0].content as { text?: unknown }).text !== 'string') {
      throw new CompanionError('local_chat_incomplete');
    }
    return Object.freeze({
      conversationId, turnId, userMessageId, assistantMessageId: assistant.id,
      deliveryId: delivery[0].id, text: (delivery[0].content as { text: string }).text, duplicate,
    });
  }
}
