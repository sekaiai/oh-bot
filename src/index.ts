/**
 * 应用入口。
 *
 * 当前职责非常单一：装配 NapCat WebSocket 客户端、把原始事件解析成统一消息模型，
 * 再把少量演示逻辑挂到解析结果上。
 *
 * 这里刻意把“连接层”“解析层”“发送层”拆开，后续扩展 AI、命令分发、会话状态时，
 * 可以继续沿着这个边界扩展，而不是把外部协议细节散落到业务逻辑里。
 */
import type { Server } from 'node:http';
import { config } from './config/index.js';
import { parseNapcatMessage } from './adapters/napcat/parser.js';
import { NapcatSender } from './adapters/napcat/sender.js';
import { NapcatWsClient } from './adapters/napcat/ws-client.js';
import { startAdminServer } from './admin/server.js';
import { ReplyEngine } from './services/reply-engine.js';
import type { BotMessage, OutboundMessageContent, OutboundMessageSegment } from './types/bot.js';
import { logger } from './utils/logger.js';

function withGroupMention(message: BotMessage, outboundMessage: OutboundMessageContent): OutboundMessageContent {
  if (message.chatType !== 'group' || !message.isAtBot) {
    return outboundMessage;
  }

  const mentionSegments: OutboundMessageSegment[] = [
    {
      type: 'at',
      data: {
        qq: message.userId
      }
    },
    {
      type: 'text',
      data: {
        text: '\n'
      }
    }
  ];

  if (typeof outboundMessage === 'string') {
    return [
      ...mentionSegments,
      {
        type: 'text',
        data: {
          text: outboundMessage
        }
      }
    ];
  }

  return [...mentionSegments, ...outboundMessage];
}

/**
 * 初始化并启动整个 Bot 进程。
 *
 * 输入：无，依赖全局配置模块 `config`。
 * 输出：无；成功时建立 WS 连接并注册进程退出钩子，失败时抛出异常交给入口兜底。
 *
 * 主要流程：
 * 1. 创建 NapCat WS 客户端并注册事件回调；
 * 2. 将原始 NapCat 事件收敛为统一 `BotMessage`；
 * 3. 仅对可识别的消息执行后续逻辑；
 * 4. 注册优雅退出，避免进程退出时留下悬挂连接。
 */
async function bootstrap(): Promise<void> {
  logger.info('QQ bot service starting');
  const replyEngine = new ReplyEngine();
  let sender: NapcatSender | null = null;

  const adminServer = await startAdminServer();

  const wsClient = new NapcatWsClient({
    url: config.NAPCAT_WS_URL,
    accessToken: config.NAPCAT_ACCESS_TOKEN,
    onEvent: async (event) => {
      /**
       * 入口层只接受已经被适配层“去协议化”的消息。
       * 解析失败或非消息事件在这里直接丢弃，可以避免业务层到处判断 NapCat 字段是否存在。
       */
      const message = parseNapcatMessage(event);
      if (!message) {
        return;
      }

      /**
       * 这里只记录统一消息模型，而不是直接打原始事件。
       * 这样日志字段更稳定，后续替换协议端或补充不同来源时，排查视角也能保持一致。
       */
      logger.info(
        {
          messageId: message.messageId,
          userId: message.userId,
          groupId: message.groupId,
          chatType: message.chatType,
          text: message.cleanText,
          isAtBot: message.isAtBot,
          imageCount: message.imageUrls.length,
          imageUrls: message.imageUrls
        },
        'Received bot message'
      );

      if (!sender) {
        sender = new NapcatSender(wsClient);
      }

      const decision = await replyEngine.decideAndGenerate(message);

      logger.info(
        {
          messageId: message.messageId,
          shouldReply: decision.shouldReply,
          reason: decision.reason,
          score: decision.score
        },
        'Reply decision generated'
      );

      const outboundMessage = decision.outboundMessage ?? decision.reply;
      if (!decision.shouldReply || !outboundMessage) {
        return;
      }

      await sender.sendMessage({
        chatType: message.chatType,
        userId: message.userId,
        groupId: message.groupId,
        message: withGroupMention(message, outboundMessage)
      });
    }
  });

  // 连接建立后由客户端自身维护重连；入口层只负责触发首次启动。
  wsClient.connect();

  /**
   * 统一处理退出信号。
   *
   * 这里显式关闭 WS 客户端，是为了阻止其内部自动重连逻辑在退出阶段再次建连，
   * 否则会出现“进程正在退出但还在调度重连”的状态错乱。
   */
  const shutdown = (): void => {
    logger.info('QQ bot service shutting down');
    wsClient.shutdown();
    closeAdminServer(adminServer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function closeAdminServer(server: Server | null): void {
  if (!server) {
    return;
  }

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'Admin server close failed');
      return;
    }

    logger.info('Admin server stopped');
  });
}

/**
 * 启动失败时直接终止进程。
 *
 * 当前服务没有“半启动可用”的状态：如果初始化失败，继续保活只会制造一个表面存活、
 * 实际不可用的空进程，因此这里选择快速失败。
 */
bootstrap().catch((error) => {
  logger.error({ err: error }, 'Service bootstrap failed');
  process.exit(1);
});
