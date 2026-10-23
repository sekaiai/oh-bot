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
import type { PersonaContextService } from '../persona/persona-context-service.js';
import type { MemoryGateway } from '../memory/memory-gateway.js';
import { analyzeIncomingInteraction, RelationshipEventService } from '../relationships/relationship-event-service.js';

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

export type PersistentTurnOrchestration = Readonly<{
  processor(input: { turnId: string; workerId: string }): Promise<{ text: string }>;
  validatePendingContext?(turnId: string): Promise<unknown>;
}>;

const lockKey = (characterId: string, platform: string, channelId: string) => `oh-bot-local-chat:${characterId}:${platform}:${channelId}`;

/** Orchestrates trusted local turns while leaving delivery pending in the normal outbox. */
export class LocalChatService {
  private readonly relationshipEvents: RelationshipEventService;
  constructor(
    private readonly sessions: LocalChatSessionService,
    private readonly database: Database,
    private readonly gateway: ModelGateway | undefined,
    private readonly turnsService: TurnService = new TurnService(database),
    private readonly workerId = `local-cli:${randomUUID()}`,
    private readonly contextServices: { persona?: PersonaContextService; memory?: MemoryGateway } = {},
    private readonly orchestration?: PersistentTurnOrchestration,
  ) {
    this.relationshipEvents = new RelationshipEventService(database, analyzeIncomingInteraction);
  }

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
    let released = false;
    try {
      let result: { rows: Array<{ locked: boolean }> };
      try {
        result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [key]);
      } catch {
        client.release(new Error('local chat advisory lock acquisition was uncertain'));
        released = true;
        throw new CompanionError('local_chat_lock_unavailable');
      }
      const acquired = result.rows[0]?.locked;
      if (typeof acquired !== 'boolean') {
        client.release(new Error('local chat advisory lock result was uncertain'));
        released = true;
        throw new CompanionError('local_chat_lock_unavailable');
      }
      locked = acquired;
      if (!locked) throw new CompanionError('local_chat_busy');

      const accepted = await this.sessions.acceptMessage(characterId, event, evidence);
      const trustedActor = await this.sessions.resolveActorContext(characterId, evidence, accepted.accepted.conversationId);
      if (!this.orchestration) await this.relationshipEvents.recordIncoming(trustedActor, accepted.accepted.messageId);

      const [turn] = await this.database.db.select({ status: turns.status }).from(turns).where(eq(turns.id, accepted.accepted.turnId)).limit(1);
      if (turn?.status === 'generated' || turn?.status === 'sent' || turn?.status === 'receipt_unknown') {
        return await this.recover(accepted.accepted.turnId, accepted.accepted.conversationId, accepted.accepted.messageId, true);
      }
      if (accepted.accepted.duplicate && turn?.status === 'failed') throw new CompanionError('local_chat_previous_failed');
      if (accepted.accepted.duplicate) throw new CompanionError('local_chat_incomplete');

      const lease = await this.turnsService.claim(accepted.accepted.turnId, this.workerId, 3_600_000);
      if (!lease) throw new CompanionError('local_chat_busy');
      try {
        if (this.orchestration) {
          const generated = await this.orchestration.processor({ turnId: accepted.accepted.turnId, workerId: this.workerId });
          if (typeof generated.text !== 'string' || !generated.text.trim()) throw new CompanionError('processor_failed');
          await this.orchestration.validatePendingContext?.(accepted.accepted.turnId);
          const persisted = await this.turnsService.persistGenerated(lease, { text: generated.text.trim() });
          return Object.freeze({
            conversationId: accepted.accepted.conversationId,
            turnId: accepted.accepted.turnId,
            userMessageId: accepted.accepted.messageId,
            assistantMessageId: persisted.messageId,
            deliveryId: persisted.deliveryId,
            text: generated.text.trim(),
            duplicate: accepted.accepted.duplicate || persisted.duplicate,
          });
        }
        const history = await this.sessions.readHistory(characterId, evidence, { limit: options.system ? 199 : 200 });
        if (!history || history.session.conversationId !== accepted.accepted.conversationId) throw new CompanionError('session_unauthorized');
        const actor = trustedActor;
        const systemParts: string[] = [];
        if (this.contextServices.persona && actor) systemParts.push(await this.contextServices.persona.buildContext(actor));
        if (this.contextServices.memory && actor) {
          // Registering a source only queues durable extraction; the current turn never waits for Mem0.
          await this.contextServices.memory.record(actor, accepted.accepted.messageId);
          const recall = await this.contextServices.memory.recall(actor, event.text, { limit: 8 });
          if (recall.context) systemParts.push(`可用于本轮的已授权记忆（仅作参考）：\n${recall.context}`);
        }
        if (options.system !== undefined) systemParts.push(options.system);
        const messagesForModel: ChatMessage[] = [];
        if (systemParts.length) messagesForModel.push({ role: 'system', content: systemParts.join('\n\n') });
        for (const message of history.messages) {
          if (message.role === 'tool') continue;
          messagesForModel.push({ role: message.role, content: message.text });
        }
        if (!this.gateway) throw new CompanionError('model_not_configured');
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
      if (!released && locked) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>('select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked', [key]);
          if (unlocked.rows[0]?.unlocked !== true) throw new Error('unlock failed');
          client.release();
          released = true;
        } catch {
          client.release(new Error('local chat advisory lock release failed'));
          released = true;
          throw new CompanionError('local_chat_lock_release_failed');
        }
      } else if (!released) {
        client.release();
        released = true;
      }
    }
  }

  private async recover(turnId: string, conversationId: string, userMessageId: string, duplicate: boolean): Promise<LocalChatResult> {
    const [turn, delivery] = await Promise.all([
      this.database.db.select({ id: turns.id }).from(turns).where(eq(turns.id, turnId)).limit(1),
      this.database.db.select({ id: deliveryOutbox.id, content: deliveryOutbox.content }).from(deliveryOutbox).where(eq(deliveryOutbox.turnId, turnId)).limit(1),
    ]);
    const [assistant] = await this.database.db.select({ id: messages.id, text: messages.text }).from(messages).where(and(
      eq(messages.conversationId, conversationId), eq(messages.platformEventId, `generated:${turnId}`),
      isNull(messages.deletedAt),
    )).limit(1);
    const deliveryText = (delivery[0]?.content as { text?: unknown } | undefined)?.text;
    if (!turn[0] || !delivery[0] || !assistant?.text || typeof deliveryText !== 'string' || !deliveryText.trim()) {
      throw new CompanionError('local_chat_incomplete');
    }
    return Object.freeze({
      conversationId, turnId, userMessageId, assistantMessageId: assistant.id,
      deliveryId: delivery[0].id, text: deliveryText, duplicate,
    });
  }
}
