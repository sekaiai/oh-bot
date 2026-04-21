/**
 * NapCat 发送适配层。
 *
 * 该类负责把项目内部的统一发送参数转换成 NapCat OneBot 动作请求。
 * 入口层只需要表达“往哪里发什么”，不需要知道具体 action 名称和字段格式。
 */
import type { SendMessageParams } from '../../types/bot.js';
import type { NapcatWsClient } from './ws-client.js';
import { logger } from '../../utils/logger.js';

/**
 * 基于已连接的 WebSocket 客户端发送消息。
 *
 * 隐含约束：它不管理连接状态，只假设 `NapcatWsClient` 已经连接或会在未连接时抛错。
 * 这让发送层保持同步职责边界，不与重连逻辑耦合。
 */
export class NapcatSender {
  constructor(private readonly wsClient: NapcatWsClient) {}

  /**
   * 发送纯文本消息。
   *
   * 输入：统一的发送参数，必须带上目标会话所需的 ID。
   * 输出：Promise<void>；发送请求成功写入 WS 即返回，不等待业务级回执。
   *
   * 这里通过 `chatType` 分流私聊和群聊，是因为两类 OneBot action 的参数结构不同。
   */
  async sendText(params: SendMessageParams): Promise<void> {
    if (params.chatType === 'group') {
      if (!params.groupId) {
        throw new Error('groupId is required for group message');
      }

      /**
       * NapCat / OneBot 动作层使用数值 ID。
       * 当前内部模型统一保存为 string，是为了规避不同来源 ID 类型不一致的问题；
       * 在协议边界处再做一次显式转换，类型责任更清晰。
       */
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
