import { config } from './config/index.js';
import { parseNapcatMessage } from './adapters/napcat/parser.js';
import { NapcatSender } from './adapters/napcat/sender.js';
import { NapcatWsClient } from './adapters/napcat/ws-client.js';
import { logger } from './utils/logger.js';

async function bootstrap(): Promise<void> {
  logger.info('QQ bot service starting');

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

      if (message.cleanText === '/ping') {
        const sender = new NapcatSender(wsClient);
        await sender.sendText({
          chatType: message.chatType,
          userId: message.userId,
          groupId: message.groupId,
          message: 'pong'
        });
      }
    }
  });

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
