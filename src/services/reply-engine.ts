/**
 * 回复引擎。
 *
 * 这是“消息回复模块”的核心编排层，负责把：
 * - 黑名单规则
 * - 群聊触发判断
 * - 价值评分
 * - 冷却/去重
 * - persona 选择
 * - AI 生成
 *
 * 串成一个稳定的 `ReplyDecision` 输出。
 */
import { config } from '../config/index.js';
import type {
  BotMessage,
  PersonaConfig,
  PersonaRegistry,
  ReplyDecision,
  ReplyReason,
  RuleConfig,
  SessionMessage
} from '../types/bot.js';
import { logger } from '../utils/logger.js';
import { AiClient } from './ai-client.js';
import { loadPersonas, loadRules } from './data-repository.js';
import { SessionStore } from './session-store.js';

// 群聊上下文窗口按需求固定在 10~20 条范围内，并复用现有 MAX_CONTEXT_MESSAGES 配置。
const GROUP_CONTEXT_WINDOW = Math.min(Math.max(config.MAX_CONTEXT_MESSAGES, 10), 20);

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
 * 选择当前消息对应的人设。
 *
 * 优先按会话绑定查找，找不到时回退到默认 persona，
 * 最后再回退到代码内置的最小 persona，保证回复链路不会因配置缺失中断。
 */
function selectPersona(message: BotMessage, registry: PersonaRegistry): PersonaConfig {
  const chatKey = getChatKey(message);
  const personaId = registry.bindings[chatKey] ?? registry.defaultPersonaId;
  return (
    registry.personas.find((persona) => persona.id === personaId) ??
    registry.personas[0] ?? {
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: '你是一个可靠、简洁、友好的 QQ 助手。',
      temperature: 0.7,
      maxTokens: 512
    }
  );
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

/**
 * 回复决策与生成编排器。
 */
export class ReplyEngine {
  private readonly aiClient = new AiClient();
  private readonly sessionStore = new SessionStore();

  /**
   * 基于单条消息产出最终回复决策。
   *
   * 主流程：
   * 1. 读取规则、persona 和会话状态；
   * 2. 做黑名单、开关、去重等硬规则过滤；
   * 3. 群聊按 @ / 名字提及 / 价值评分决定是否进入可回复候选；
   * 4. 需要回复时调用模型生成文本；
   * 5. 将入站消息和回复结果写入会话存储。
   */
  async decideAndGenerate(message: BotMessage): Promise<ReplyDecision> {
    const chatKey = getChatKey(message);
    const [rules, personas, session] = await Promise.all([
      loadRules(),
      loadPersonas(),
      this.sessionStore.getSession(chatKey)
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

    const contextMessages = getRecentContext(session.messages, GROUP_CONTEXT_WINDOW);
    const recentReplyAt = session.lastReplyAt ?? 0;
    const now = message.time;
    const isNameMention = message.chatType === 'group' && mentionsBotName(message.cleanText, rules.botNames);

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
        // 只有在通过硬规则后，才值得消耗一次模型调用做价值评分。
        const decision = await this.aiClient.scoreGroupReplyCandidate(message, contextMessages, rules.botNames);
        score = clampScore(decision.score);

        if (score >= 0.75) {
          shouldReply = true;
          reason = 'group_context_high_value';
        } else if (score >= 0.5 && decision.isContextuallyRelevant) {
          shouldReply = true;
          reason = 'group_context_related';
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

    const persona = selectPersona(message, personas);
    /**
     * 生成回复时把当前消息附加到最近上下文尾部。
     * 由于入站消息已写入 store，这里不复用 store 中的新快照，而是直接在内存中补上当前消息，
     * 可以避免再走一次读盘，同时让 prompt 明确包含“当前正在回答哪条消息”。
     */
    const generationContext = getRecentContext(
      [...contextMessages, { role: 'user', content: message.cleanText, time: message.time }],
      GROUP_CONTEXT_WINDOW
    );

    try {
      const reply = await this.aiClient.generateReply(message, generationContext, persona, reason);
      await this.sessionStore.recordAssistantReply(chatKey, reply, now, reason);
      return {
        shouldReply: true,
        reason,
        score,
        reply
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
