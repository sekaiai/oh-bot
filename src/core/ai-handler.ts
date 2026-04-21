import type { BotMessage, SessionMessage } from '../types/bot.js';
import { NapcatSender } from '../adapters/napcat/sender.js';
import { PersonaService } from '../services/persona-service.js';
import { AiService } from '../services/ai-service.js';
import { SessionManager } from './session-manager.js';
import { RuleService } from '../services/rule-service.js';
import { RuleEngine } from './rule-engine.js';
import { logger } from '../utils/logger.js';

export interface AiHandleResult {
  replied: boolean;
  reason?: string;
}

export class AiHandler {
  constructor(
    private readonly sender: NapcatSender,
    private readonly personaService: PersonaService,
    private readonly aiService: AiService,
    private readonly sessionManager: SessionManager,
    private readonly ruleService: RuleService,
    private readonly ruleEngine: RuleEngine
  ) {}

  async handle(message: BotMessage): Promise<AiHandleResult> {
    const rules = await this.ruleService.getRules();
    const aiCheck = this.ruleEngine.checkAiAllowed(message, rules);
    if (!aiCheck.allowed) {
      return { replied: false, reason: aiCheck.reason };
    }

    const sessionKey = this.personaService.resolveSessionKey(message);
    const persona = await this.personaService.getCurrentPersona(sessionKey);
    const history = await this.sessionManager.getMessages(sessionKey);

    const promptMessages: SessionMessage[] = [
      {
        role: 'system',
        content: persona.systemPrompt,
        time: Date.now()
      },
      ...history,
      {
        role: 'user',
        content: message.cleanText,
        time: Date.now()
      }
    ];

    try {
      logger.info({ sessionKey, personaId: persona.id }, 'Calling AI service');
      const aiText = await this.aiService.chat(promptMessages, {
        temperature: persona.temperature,
        maxTokens: persona.maxTokens
      });

      await this.sender.sendText({
        chatType: message.chatType,
        userId: message.userId,
        groupId: message.groupId,
        message: aiText
      });

      await this.sessionManager.appendMessages(sessionKey, [
        {
          role: 'user',
          content: message.cleanText,
          time: Date.now()
        },
        {
          role: 'assistant',
          content: aiText,
          time: Date.now()
        }
      ]);

      return { replied: true };
    } catch (error) {
      logger.error({ err: error }, 'AI handler failed');
      await this.sender.sendText({
        chatType: message.chatType,
        userId: message.userId,
        groupId: message.groupId,
        message: 'AI 服务暂时不可用，请稍后再试。'
      });
      return { replied: true, reason: 'AI service error' };
    }
  }
}
