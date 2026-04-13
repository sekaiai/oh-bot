import type { SendMessageParams } from '../../types/bot.js';
import type { NapcatWsClient } from './ws-client.js';
import { logger } from '../../utils/logger.js';

export class NapcatSender {
  constructor(private readonly wsClient: NapcatWsClient) {}

  async sendText(params: SendMessageParams): Promise<void> {
    if (params.chatType === 'group') {
      if (!params.groupId) {
        throw new Error('groupId is required for group message');
      }

      await this.wsClient.sendAction({
        action: 'send_group_msg',
        params: {
          group_id: Number(params.groupId),
          message: params.message
        }
      });

      logger.info({ groupId: params.groupId, message: params.message }, 'Sent group message');
      return;
    }

    if (!params.userId) {
      throw new Error('userId is required for private message');
    }

    await this.wsClient.sendAction({
      action: 'send_private_msg',
      params: {
        user_id: Number(params.userId),
        message: params.message
      }
    });

    logger.info({ userId: params.userId, message: params.message }, 'Sent private message');
  }
}
