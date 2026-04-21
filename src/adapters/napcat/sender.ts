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

      const groupId = Number(params.groupId);
      if (!Number.isFinite(groupId)) {
        throw new Error(`Invalid groupId: ${params.groupId}`);
      }

      await this.wsClient.sendAction({
        action: 'send_group_msg',
        params: {
          group_id: groupId,
          message: params.message
        }
      });

      logger.info({ groupId: params.groupId }, 'Sent group message');
      return;
    }

    if (!params.userId) {
      throw new Error('userId is required for private message');
    }

    const userId = Number(params.userId);
    if (!Number.isFinite(userId)) {
      throw new Error(`Invalid userId: ${params.userId}`);
    }

    await this.wsClient.sendAction({
      action: 'send_private_msg',
      params: {
        user_id: userId,
        message: params.message
      }
    });

    logger.info({ userId: params.userId }, 'Sent private message');
  }
}
