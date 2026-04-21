/**
 * AI 调用层。
 *
 * 该模块只做三件事：
 * 1. 调用 OpenAI 兼容接口；
 * 2. 解析模型输出；
 * 3. 提供“评分”和“生成回复”两个明确能力。
 *
 * 决策规则本身不放在这里，避免 prompt 策略和业务状态判断混在一起。
 */
import axios from 'axios';
import { z } from 'zod';
import { config } from '../config/index.js';
import type { BotMessage, PersonaConfig, SessionMessage } from '../types/bot.js';
import { withRetry } from '../utils/retry.js';

/**
 * 发送给 chat completions 的消息结构最小子集。
 */
interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 用 schema 约束模型必须返回稳定 JSON，避免把“模型自然语言解释”直接喂给业务逻辑。
const decisionSchema = z.object({
  score: z.number().min(0).max(1),
  isContextuallyRelevant: z.boolean()
});

const replySchema = z.object({
  reply: z.string().min(1)
});

/**
 * 兼容不同 `AI_BASE_URL` 是否带尾部 `/` 的情况，统一拼接 chat 接口路径。
 */
function toChatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

/**
 * 从兼容 OpenAI 风格响应中提取文本内容。
 *
 * 有些网关返回 string，有些会返回分段数组；
 * 这里统一折叠成纯文本，减少下游对供应商差异的感知。
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('');
  }

  return '';
}

/**
 * 从模型输出中截取 JSON 对象。
 *
 * 实际运行中模型偶尔会在 JSON 前后带解释文本，
 * 这里做一个保守截取，尽量提升结构化解析成功率。
 */
function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start === -1 || end === -1 || start >= end) {
    throw new Error('Model did not return a JSON object');
  }

  return trimmed.slice(start, end + 1);
}

/**
 * 将最近会话上下文格式化为 prompt 文本。
 *
 * 当前使用线性文本而不是复杂消息对象，是为了让不同模型兼容性更高，
 * 同时便于后续直接打印日志或复制调试。
 */
function formatContextMessages(contextMessages: SessionMessage[]): string {
  if (contextMessages.length === 0) {
    return '无最近上下文';
  }

  return contextMessages
    .map((message, index) => {
      const name = message.senderNickname || message.userId || message.role;
      return `${index + 1}. [${message.role}] ${name}: ${message.content}`;
    })
    .join('\n');
}

/**
 * 面向回复引擎的 AI 客户端。
 */
export class AiClient {
  private readonly endpoint = toChatEndpoint(config.AI_BASE_URL);

  /**
   * 执行一次 chat completion，并带统一重试。
   *
   * 这里只返回模型原始文本，不在这一层绑定业务 schema，
   * 这样“评分”和“生成”可以共享同一套网络调用逻辑。
   */
  private async createChatCompletion(
    messages: ChatCompletionMessage[],
    options: { temperature: number; maxTokens: number }
  ): Promise<string> {
    return withRetry(
      async () => {
        const response = await axios.post(
          this.endpoint,
          {
            model: config.AI_MODEL,
            messages,
            temperature: options.temperature,
            max_tokens: options.maxTokens
          },
          {
            headers: {
              Authorization: `Bearer ${config.AI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        const content = response.data?.choices?.[0]?.message?.content;
        const text = extractTextContent(content);
        if (!text) {
          throw new Error('Model returned empty content');
        }

        return text;
      },
      {
        retries: 2,
        delayMs: 1000,
        factor: 2
      }
    );
  }

  /**
   * 对群聊中“未显式触发”的消息做价值评分。
   *
   * 输入：当前消息、最近上下文、机器人名字候选。
   * 输出：模型判断的 `score` 与 `isContextuallyRelevant`。
   *
   * 注意这里的 prompt 只负责“值不值得回复”，不负责写回复内容，
   * 这样评分行为更稳定，也更容易调阈值。
   */
  async scoreGroupReplyCandidate(
    message: BotMessage,
    contextMessages: SessionMessage[],
    botNames: string[]
  ): Promise<{ score: number; isContextuallyRelevant: boolean }> {
    const raw = await this.createChatCompletion(
      [
        {
          role: 'system',
          content: [
            '你是 QQ 群聊机器人“是否应该回复”的决策器。',
            '你的任务不是生成回答，而是只输出 JSON。',
            '你必须根据当前消息和最近上下文，给出 score(0~1) 和 isContextuallyRelevant(boolean)。',
            'score 高价值信号：明确问题、求助、任务请求、决策请求、追问、纠错、总结、翻译、分析、执行建议、明显在寻求机器人能力。',
            'score 低价值信号：纯表情、单字灌水、哈哈哈、6、？、。 、在吗、重复刷屏、无上下文噪声。',
            '只有当消息与上下文强相关，或明显是在寻求机器人能力时，isContextuallyRelevant 才能为 true。',
            '只输出 JSON，格式为 {"score":0.0,"isContextuallyRelevant":false}。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `机器人名称候选: ${botNames.join(', ') || '无'}`,
            `消息类型: ${message.chatType}`,
            `发送者: ${message.senderNickname || message.userId}`,
            `当前消息: ${message.cleanText || '(空文本)'}`,
            `最近上下文:\n${formatContextMessages(contextMessages)}`
          ].join('\n')
        }
      ],
      {
        temperature: 0.1,
        maxTokens: 200
      }
    );

    const parsed = decisionSchema.parse(JSON.parse(extractJsonPayload(raw)));
    return parsed;
  }

  /**
   * 生成最终发送给用户的回复文本。
   *
   * 输入：当前消息、上下文、人设和触发原因。
   * 输出：已经清洗过的最终回复内容。
   *
   * 这里仍然强制模型输出 JSON，而不是裸文本，
   * 目的是让上层在未来扩展更多字段时保持协议稳定。
   */
  async generateReply(
    message: BotMessage,
    contextMessages: SessionMessage[],
    persona: PersonaConfig,
    reason: string,
    // `toolContext` 允许外部工具把事实数据注入生成阶段。
    // 这样保留了原有的“模型负责措辞和人设”的优势，同时避免模型凭记忆瞎答实时信息。
    toolContext?: string
  ): Promise<string> {
    const raw = await this.createChatCompletion(
      [
        {
          role: 'system',
          content: [
            persona.systemPrompt,
            '你是 QQ 机器人消息回复引擎。',
            '你必须直接生成适合发送给用户的自然中文回复。',
            '回复要求：简洁、自然、像真人聊天，不要机械模板，不要解释系统规则。',
            '私聊优先直接帮助用户；若需求不清，可以先用一句话澄清，再给可执行建议。',
            '群聊避免冗长，优先回答最关键的信息。',
            // 这一段是工具接入后的关键约束：
            // 模型的职责从“自己知道答案”变成“基于工具结果组织答案”，这样事实边界更清晰。
            '如果提供了工具查询结果，必须优先依据工具结果回答，不要编造实时信息。',
            '如果工具结果里有天气、空气质量、预警、日出日落或天气指数，请整合成自然回答。',
            '如果用户请求危险、违法、恶意内容，由你自行决定如何拒绝或转向更安全的回答。',
            '只输出 JSON，格式为 {"reply":"..."}。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `触发原因: ${reason}`,
            `消息类型: ${message.chatType}`,
            `发送者: ${message.senderNickname || message.userId}`,
            `当前消息: ${message.cleanText || '(空文本)'}`,
            `最近上下文:\n${formatContextMessages(contextMessages)}`,
            toolContext ? `工具结果:\n${toolContext}` : '工具结果: 无'
          ].join('\n')
        }
      ],
      {
        temperature: persona.temperature,
        maxTokens: persona.maxTokens
      }
    );

    const parsed = replySchema.parse(JSON.parse(extractJsonPayload(raw)));
    return parsed.reply.trim();
  }
}
