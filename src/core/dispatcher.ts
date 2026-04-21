import type { BotMessage } from '../types/bot.js';
import { CommandHandler } from './command-handler.js';
import { AiHandler } from './ai-handler.js';
import { RuleEngine } from './rule-engine.js';
import { RuleService } from '../services/rule-service.js';
import { SessionManager } from './session-manager.js';
import { PersonaService } from '../services/persona-service.js';
import { logger } from '../utils/logger.js';

export class Dispatcher {
  constructor(
    private readonly commandHandler: CommandHandler,
    private readonly aiHandler: AiHandler,
    private readonly ruleEngine: RuleEngine,
    private readonly ruleService: RuleService,
    private readonly sessionManager: SessionManager,
    private readonly personaService: PersonaService
  ) {}

  async dispatch(message: BotMessage): Promise<void> {
    try {
      if (message.userId === message.selfId) {
        return;
      }

      const rules = await this.ruleService.getRules();
      const msgCheck = this.ruleEngine.checkMessage(message, rules);
      if (!msgCheck.allowed) {
        logger.info({ reason: msgCheck.reason, userId: message.userId }, 'Message blocked by rules');
        return;
      }

      const commandResult = await this.commandHandler.handle(message);
      if (commandResult.handled) {
        return;
      }

      const aiResult = await this.aiHandler.handle(message);
      if (aiResult.replied) {
        return;
      }

      const sessionKey = this.personaService.resolveSessionKey(message);
      await this.sessionManager.appendMessage(sessionKey, {
        role: 'user',
        content: message.cleanText,
        time: Date.now()
      });
    } catch (error) {
      logger.error({ err: error, messageId: message.messageId }, 'Single message dispatch failed');
    }
  }
}
