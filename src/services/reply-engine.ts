/**
 * 回复引擎。
 *
 * 这是“消息回复模块”的核心编排层，负责把：
 * - 黑名单规则
 * - 群聊触发判断
 * - 价值评分
 * - 冷却/去重
 * - 南枝基础人格与情绪状态
 * - AI 生成
 *
 * 串成一个稳定的 `ReplyDecision` 输出。
 */
import { config } from '../config/index.js';
import type {
  BotMessage,
  ReplyProfile,
  ReplyDecision,
  ReplyReason,
  RuleConfig,
  SessionMessage
} from '../types/bot.js';
import { logger } from '../utils/logger.js';
import { AffectionEngine } from './affection-engine.js';
import { AiClient } from './ai-client.js';
import { loadPluginConfigs, loadRules } from './data-repository.js';
import { NANZHI_REPLY_PROFILE } from './reply-profile.js';
import { SessionStore } from './session-store.js';
import { ToolRouter } from './tool-router.js';

// 群聊上下文窗口按需求固定在 10~20 条范围内，并复用现有 MAX_CONTEXT_MESSAGES 配置。
const GROUP_CONTEXT_WINDOW = Math.min(Math.max(config.MAX_CONTEXT_MESSAGES, 10), 20);
const MODEL_CONTEXT_WINDOW = 4;
const GROUP_REPLY_SCORE_THRESHOLD = 0.6;
const LOW_INFORMATION_REPLY_PATTERNS = [
  /^(哈)+[哈呵嘿]*[~!！。.?？]*$/i,
  /^(嗯+|哦+|啊+|欸+)[~!！。.?？]*$/i,
  /^(在的|来了|收到|知道了|懂了|明白了|好的|ok|okk|yes)[~!！。.?？]*$/i,
  /^(确实|也是|对啊|对呢|是啊|有道理|没毛病|6+)[~!！。.?？]*$/i,
  /^(有点意思|有点东西|这就对了|笑死|绷不住了)[~!！。.?？]*$/i
];

/**
 * 统一生成会话 key。
 */
function getChatKey(message: BotMessage): string {
  return message.chatType === 'group' ? `group:${message.groupId}` : `private:${message.userId}`;
}

/**
 * 文本标准化，用于机器人名称匹配。
 *
 * 当前只做最保守的小写与 trim；
 * 如果未来需要更强的召回，可以在这里集中加同义词、全半角归一化等逻辑。
 */
function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 判断消息是否显式提到机器人名字。
 *
 * 这是对“未 @ 但明显在找机器人”的补充触发信号。
 */
function mentionsBotName(text: string, botNames: string[]): boolean {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return false;
  }

  return botNames.some((name) => {
    const normalizedName = normalizeText(name);
    return normalizedName ? normalizedText.includes(normalizedName) : false;
  });
}

/**
 * 将模型 score 收敛到 0~1。
 *
 * 即使模型偶尔越界，也不把异常值直接传给上层决策。
 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

/**
 * 获取最近 N 条上下文。
 */
function getRecentContext(messages: SessionMessage[], limit: number): SessionMessage[] {
  return messages.slice(-limit);
}

/**
 * 判断最后一条上下文是否已经是机器人回复。
 *
 * 这是一个非常简单的“防连续插话”保护：
 * 如果机器人刚回过一句，而群里下一条又不是显式触发，就先收敛一下，避免刷屏。
 */
function hasRecentAssistantReply(messages: SessionMessage[]): boolean {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.role === 'assistant';
}

function findLastUserMessage(messages: SessionMessage[]): SessionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return message;
    }
  }

  return undefined;
}

function looksLikeFollowUpQuestion(text: string): boolean {
  const normalized = normalizeText(text).replace(/\s+/g, '');
  if (!normalized || normalized.length < 3) {
    return false;
  }

  if (LOW_INFORMATION_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return [
    '?',
    '？',
    '吗',
    '么',
    '呢',
    '哪个',
    '什么',
    '为啥',
    '为什么',
    '怎么',
    '是不是',
    '用的是',
    '接的是',
    '模型',
    'ai',
    'api',
    '插件',
    '这个',
    '那个',
    '刚才'
  ].some((keyword) => normalized.includes(keyword));
}

function isFollowUpToRecentAssistantReply(messages: SessionMessage[], message: BotMessage, now: number): boolean {
  const lastMessage = messages[messages.length - 1];
  if (message.chatType !== 'group' || lastMessage?.role !== 'assistant') {
    return false;
  }

  if (now - lastMessage.time > 180) {
    return false;
  }

  const previousUserMessage = findLastUserMessage(messages.slice(0, -1));
  if (previousUserMessage?.userId && previousUserMessage.userId !== message.userId) {
    return false;
  }

  return looksLikeFollowUpQuestion(message.cleanText);
}

function shouldDiscardGeneratedGroupReply(reply: string): boolean {
  const compact = reply.trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) {
    return true;
  }

  return compact.length <= 16 && LOW_INFORMATION_REPLY_PATTERNS.some((pattern) => pattern.test(compact));
}

/**
 * 回复决策与生成编排器。
 */
export class ReplyEngine {
  private readonly aiClient = new AiClient();
  private readonly sessionStore = new SessionStore();
  private readonly affectionEngine = new AffectionEngine();
  // ToolRouter 挂在 ReplyEngine，而不是直接塞进 AiClient，
  // 是为了保持“业务编排”和“模型调用”职责分离：一个决定要不要查工具，一个只负责和模型通信。
  private readonly toolRouter = new ToolRouter();

  /**
   * 基于单条消息产出最终回复决策。
   *
   * 主流程：
   * 1. 读取规则、会话状态和插件配置；
   * 2. 做黑名单、开关、去重等硬规则过滤；
   * 3. 群聊按 @ / 名字提及 / 价值评分决定是否进入可回复候选；
   * 4. 需要回复时调用模型生成文本；
   * 5. 将入站消息和回复结果写入会话存储。
   */
  async decideAndGenerate(message: BotMessage): Promise<ReplyDecision> {
    const chatKey = getChatKey(message);
    const [rules, session, plugins] = await Promise.all([
      loadRules(),
      this.sessionStore.getSession(chatKey),
      loadPluginConfigs()
    ]);

    // AI 总开关关闭时仍记录入站消息，便于后续重新开启后保留上下文连续性。
    if (!rules.aiEnabled) {
      await this.sessionStore.recordInboundMessage(chatKey, message);
      return {
        shouldReply: false,
        reason: 'ai_disabled'
      };
    }

    if (await this.sessionStore.hasHandledMessage(chatKey, message.messageId)) {
      return {
        shouldReply: false,
        reason: 'duplicate'
      };
    }

    // 私聊黑名单只作用于 private，避免与群黑名单语义混淆。
    if (message.chatType === 'private' && rules.privateBlacklist.includes(message.userId)) {
      await this.sessionStore.recordInboundMessage(chatKey, message);
      return {
        shouldReply: false,
        reason: 'private_blacklist'
      };
    }

    if (message.chatType === 'group' && message.groupId && rules.groupBlacklist.includes(message.groupId)) {
      await this.sessionStore.recordInboundMessage(chatKey, message);
      return {
        shouldReply: false,
        reason: 'group_blacklist'
      };
    }

    const commandReply = await this.affectionEngine.handleCommand(message, rules);
    if (commandReply) {
      await this.sessionStore.recordInboundMessage(chatKey, message);
      await this.sessionStore.recordAssistantReply(chatKey, commandReply, message.time, 'private_default');
      return {
        shouldReply: true,
        reason: 'private_default',
        reply: commandReply,
        outboundMessage: commandReply
      };
    }

    const contextMessages = getRecentContext(session.messages, GROUP_CONTEXT_WINDOW);
    const promptContextMessages = getRecentContext(session.messages, MODEL_CONTEXT_WINDOW);
    const recentReplyAt = session.lastReplyAt ?? 0;
    const now = message.time;
    const isNameMention = message.chatType === 'group' && mentionsBotName(message.cleanText, rules.botNames);
    const affectionPrompt = await this.affectionEngine.buildPrompt(message);
    const profile: ReplyProfile = {
      ...NANZHI_REPLY_PROFILE,
      systemPrompt: affectionPrompt
        ? `${NANZHI_REPLY_PROFILE.systemPrompt}\n\n${affectionPrompt}`
        : NANZHI_REPLY_PROFILE.systemPrompt
    };
    const isAssistantFollowUp = isFollowUpToRecentAssistantReply(contextMessages, message, now);
    let draftedReply: string | undefined;

    let shouldReply = false;
    let reason: ReplyReason = 'group_low_value';
    let score: number | undefined;

    // 私聊默认直接进入可回复路径。
    if (message.chatType === 'private') {
      shouldReply = true;
      reason = 'private_default';
    // 群聊中 @ 机器人是最高优先级显式触发，按确认需求默认一定回复。
    } else if (message.isAtBot) {
      shouldReply = true;
      reason = 'group_at';
    // 明确提到机器人名字也视作显式触发。
    } else if (isNameMention) {
      shouldReply = true;
      reason = 'group_name_mention';
    } else if (isAssistantFollowUp) {
      shouldReply = true;
      reason = 'group_context_related';
    } else {
      /**
       * 群聊非显式触发时先做两层保护：
       * 1. 冷却，避免短时间内连续响应；
       * 2. 连续插话保护，避免机器人上一句刚说完又主动插一句。
       */
      if (rules.cooldownSeconds > 0 && now - recentReplyAt < rules.cooldownSeconds) {
        await this.sessionStore.recordInboundMessage(chatKey, message);
        return {
          shouldReply: false,
          reason: 'cooldown'
        };
      }

      if (hasRecentAssistantReply(contextMessages)) {
        await this.sessionStore.recordInboundMessage(chatKey, message);
        return {
          shouldReply: false,
          reason: 'group_consecutive_reply_guard'
        };
      }

      try {
        // 群聊非显式触发时，把“是否回复”和“普通回复草稿”合并成一次调用。
        const decision = await this.aiClient.scoreAndDraftGroupReply(
          message,
          promptContextMessages,
          rules.botNames,
          profile,
          {
            baseUrl: config.AI_BASE_URL,
            apiKey: config.AI_API_KEY,
            model: config.AI_MODEL,
            timeoutMs: config.AI_TIMEOUT_MS
          },
          session.contextSummary
        );
        score = clampScore(decision.score);

        if (score >= GROUP_REPLY_SCORE_THRESHOLD && decision.isContextuallyRelevant) {
          shouldReply = true;
          reason = 'group_context_high_value';
          draftedReply = decision.reply.trim() || undefined;
        } else {
          reason = 'group_low_value';
        }
      } catch (error) {
        logger.error({ err: error, messageId: message.messageId }, 'Reply scoring failed');
        await this.sessionStore.recordInboundMessage(chatKey, message);
        return {
          shouldReply: false,
          reason: 'model_error'
        };
      }
    }

    // 无论最终回不回，只要进入正常判断流程，都会把入站消息写入上下文。
    await this.sessionStore.recordInboundMessage(chatKey, message);

    if (!shouldReply) {
      return {
        shouldReply: false,
        reason,
        score
      };
    }

    /**
     * 生成回复时把当前消息附加到最近上下文尾部。
     * 由于入站消息已写入 store，这里不复用 store 中的新快照，而是直接在内存中补上当前消息，
     * 可以避免再走一次读盘，同时让 prompt 明确包含“当前正在回答哪条消息”。
     */
    const generationContext = getRecentContext(
      [...promptContextMessages, { role: 'user', content: message.cleanText, time: message.time }],
      MODEL_CONTEXT_WINDOW + 1
    );

    void this.affectionEngine.updateAfterMessage(message, generationContext).catch((error) => {
      logger.warn({ err: error, messageId: message.messageId }, 'Affection update failed');
    });

    try {
      // 工具调用放在“确定要回复”之后，而不是每条消息都先查天气，
      // 这样可以复用现有的触发/冷却/去重机制，避免群聊里无意义地消耗外部 API 配额。
      const toolResolution = await this.toolRouter.resolve(message, plugins, generationContext, profile, session.contextSummary);

      if (toolResolution.handled && toolResolution.reply && toolResolution.reason) {
        await this.sessionStore.recordAssistantReply(chatKey, toolResolution.reply, now, toolResolution.reason);
        return {
          shouldReply: true,
          reason: toolResolution.reason,
          reply: toolResolution.reply,
          outboundMessage: toolResolution.outboundMessage ?? toolResolution.reply
        };
      }

      const finalReason = toolResolution.reason ?? reason;
      // 有工具上下文时，仍需要补一次基于工具结果的生成；否则优先复用前一步已经产出的群聊草稿。
      const reply =
        !toolResolution.toolContext && draftedReply
          ? draftedReply
          : await this.aiClient.generateReply(
            message,
            generationContext,
            profile,
            finalReason,
            {
              baseUrl: config.AI_BASE_URL,
              apiKey: config.AI_API_KEY,
              model: config.AI_MODEL,
              timeoutMs: config.AI_TIMEOUT_MS
            },
            toolResolution.toolContext,
            session.contextSummary
          );

      if (message.chatType === 'group' && shouldDiscardGeneratedGroupReply(reply)) {
        return {
          shouldReply: false,
          reason: 'group_low_value',
          score
        };
      }

      await this.sessionStore.recordAssistantReply(chatKey, reply, now, finalReason);
      return {
        shouldReply: true,
        reason: finalReason,
        score,
        reply,
        outboundMessage: reply
      };
    } catch (error) {
      logger.error({ err: error, reason }, 'Reply generation failed');
      return {
        shouldReply: false,
        reason: 'model_error',
        score
      };
    }
  }
}
