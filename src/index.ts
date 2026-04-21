import { config } from './config/index.js';
import { parseNapcatMessage } from './adapters/napcat/parser.js';
import { NapcatSender } from './adapters/napcat/sender.js';
import { NapcatWsClient } from './adapters/napcat/ws-client.js';
import { logger } from './utils/logger.js';
import { SessionsStore } from './storage/sessions-store.js';
import { PersonasStore } from './storage/personas-store.js';
import { RulesStore } from './storage/rules-store.js';
import { SessionManager } from './core/session-manager.js';
import { PersonaService } from './services/persona-service.js';
import { RuleService } from './services/rule-service.js';
import { AiService } from './services/ai-service.js';
import { RuleEngine } from './core/rule-engine.js';
import { CommandHandler } from './core/command-handler.js';
import { AiHandler } from './core/ai-handler.js';
import { Dispatcher } from './core/dispatcher.js';

async function bootstrap(): Promise<void> {
  logger.info('QQ bot service starting');

  const sessionsStore = new SessionsStore();
  const personasStore = new PersonasStore();
  const rulesStore = new RulesStore();

  const sessionManager = new SessionManager(sessionsStore, config.MAX_CONTEXT_MESSAGES);
  const personaService = new PersonaService(personasStore);
  const ruleService = new RuleService(rulesStore);
  const ruleEngine = new RuleEngine();
  const aiService = new AiService({
    baseURL: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    timeout: config.AI_TIMEOUT_MS
  });

  let sender: NapcatSender;
  let dispatcher: Dispatcher;

  const wsClient = new NapcatWsClient({
    url: config.NAPCAT_WS_URL,
    accessToken: config.NAPCAT_ACCESS_TOKEN,
    onEvent: async (event) => {
      const message = parseNapcatMessage(event);
      if (!message) {
        return;
      }

      logger.info(
        {
          messageId: message.messageId,
          userId: message.userId,
          groupId: message.groupId,
          chatType: message.chatType,
          text: message.cleanText,
          isAtBot: message.isAtBot
        },
        'Received bot message'
      );

      await dispatcher.dispatch(message);
    }
  });

  sender = new NapcatSender(wsClient);
  const commandHandler = new CommandHandler(sender, personaService, ruleService, sessionManager);
  const aiHandler = new AiHandler(sender, personaService, aiService, sessionManager, ruleService, ruleEngine);
  dispatcher = new Dispatcher(commandHandler, aiHandler, ruleEngine, ruleService, sessionManager, personaService);

  wsClient.connect();

  const shutdown = (): void => {
    logger.info('QQ bot service shutting down');
    wsClient.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  logger.error({ err: error }, 'Service bootstrap failed');
  process.exit(1);
});
