/**
 * NapCat 发送适配层。
 *
 * 该类负责把项目内部的统一发送参数转换成 NapCat OneBot 动作请求。
 * 入口层只需要表达“往哪里发什么”，不需要知道具体 action 名称和字段格式。
 */
import type { OutboundMessageSegment, SendMessageParams } from '../../types/bot.js';
import type { NapcatWsClient } from './ws-client.js';
import { logger } from '../../utils/logger.js';

export interface SendMediaParams {
  chatType: SendMessageParams['chatType'];
  userId?: string;
  groupId?: string;
  /**
   * 媒体资源地址。
   *
   * 当前直接透传给 NapCat 的 `file` 字段，不在这一层区分 URL / 本地路径 / base64。
   * 这样做是为了让发送层保持“协议透传”角色，具体可接受的资源来源由 NapCat 决定。
   */
  file: string;
}

/**
 * 基于已连接的 WebSocket 客户端发送消息。
 *
 * 隐含约束：它不管理连接状态，只假设 `NapcatWsClient` 已经连接或会在未连接时抛错。
 * 这让发送层保持同步职责边界，不与重连逻辑耦合。
 */
export class NapcatSender {
  constructor(private readonly wsClient: NapcatWsClient) {}

  /**
   * 通用消息发送入口。
   *
   * 这是后续所有富媒体能力的基础能力：
   * - 传字符串时，行为与原来的纯文本发送一致；
   * - 传消息段数组时，可组合图文、语音、视频等内容。
   *
   * 把这一层抽出来，而不是继续给每种媒体单独拼 action，
   * 是因为在 OneBot 语义里它们本质上都是同一个 `message` 字段的不同段结构。
   */
  async sendMessage(params: SendMessageParams): Promise<void> {
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

  /**
   * 发送纯文本消息。
   *
   * 输入：统一的发送参数，必须带上目标会话所需的 ID。
   * 输出：Promise<void>；发送请求成功写入 WS 即返回，不等待业务级回执。
   *
   * 这个方法保留的意义主要是兼容现有调用点，
   * 让旧代码不需要感知“字符串其实也是统一消息发送的一种特例”。
   */
  async sendText(params: SendMessageParams): Promise<void> {
    await this.sendMessage(params);
  }

  /**
   * 发送图文等组合消息。
   *
   * 调用方可以显式传入消息段数组，例如：
   * - `text + image` 组成图文消息
   * - `text + video` 做带说明的视频消息
   */
  async sendRichMessage(params: Omit<SendMessageParams, 'message'> & { message: OutboundMessageSegment[] }): Promise<void> {
    await this.sendMessage(params);
  }

  /**
   * 发送图片。
   *
   * 这里用快捷方法只是为了上层调用更直观；
   * 底层依然统一走 `sendMessage`，避免图文、图片、语音、视频分裂成多套发送逻辑。
   */
  async sendImage(params: SendMediaParams): Promise<void> {
    await this.sendMessage({
      chatType: params.chatType,
      userId: params.userId,
      groupId: params.groupId,
      message: [{ type: 'image', data: { file: params.file } }]
    });
  }

  /**
   * 发送语音。
   *
   * OneBot 常见段类型是 `record` 而不是 `voice`，
   * 在这一层固定下来，可以减少上层业务对协议细节的感知。
   */
  async sendRecord(params: SendMediaParams): Promise<void> {
    await this.sendMessage({
      chatType: params.chatType,
      userId: params.userId,
      groupId: params.groupId,
      message: [{ type: 'record', data: { file: params.file } }]
    });
  }

  /**
   * 发送视频。
   */
  async sendVideo(params: SendMediaParams): Promise<void> {
    await this.sendMessage({
      chatType: params.chatType,
      userId: params.userId,
      groupId: params.groupId,
      message: [{ type: 'video', data: { file: params.file } }]
    });
  }
}
