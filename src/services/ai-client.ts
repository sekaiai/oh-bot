/**
 * AI 调用层。
 *
 * 该模块只做三件事：
 * 1. 调用 OpenAI 兼容接口；
 * 2. 解析模型输出；
 * 3. 提供“评分”“主回复生成”“路由 AI 回复生成”三个明确能力。
 */
import axios from 'axios';
import { z } from 'zod';
import type {
  AiEndpointConfig,
  BotMessage,
  Ds2ApiPluginConfig,
  PersonaConfig,
  QingmengPluginConfig,
  SessionMessage
} from '../types/bot.js';
import { withRetry } from '../utils/retry.js';

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const decisionSchema = z.object({
  score: z.number().min(0).max(1),
  isContextuallyRelevant: z.boolean()
});

const replySchema = z.object({
  reply: z.string().min(1)
});

const qingmengIntentSchema = z.object({
  shouldUsePlugin: z.boolean(),
  endpointId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  params: z.record(z.string()).default({})
});

function toChatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

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

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start === -1 || end === -1 || start >= end) {
    throw new Error('Model did not return a JSON object');
  }

  return trimmed.slice(start, end + 1);
}

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

export class AiClient {
  async testChatCompletion(
    service: AiEndpointConfig,
    prompt: string
  ): Promise<{ reply: string; raw: unknown }> {
    const response = await axios.post(
      toChatEndpoint(service.baseUrl),
      {
        model: service.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 120
      },
      {
        headers: {
          Authorization: `Bearer ${service.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: service.timeoutMs
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    const text = extractTextContent(content);
    if (!text) {
      throw new Error('Model returned empty content');
    }

    return {
      reply: text,
      raw: response.data
    };
  }

  private async createChatCompletion(
    service: AiEndpointConfig,
    messages: ChatCompletionMessage[],
    options: { temperature: number; maxTokens: number }
  ): Promise<string> {
    return withRetry(
      async () => {
        const response = await axios.post(
          toChatEndpoint(service.baseUrl),
          {
            model: service.model,
            messages,
            temperature: options.temperature,
            max_tokens: options.maxTokens
          },
          {
            headers: {
              Authorization: `Bearer ${service.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: service.timeoutMs
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

  async scoreGroupReplyCandidate(
    message: BotMessage,
    contextMessages: SessionMessage[],
    botNames: string[],
    service: AiEndpointConfig
  ): Promise<{ score: number; isContextuallyRelevant: boolean }> {
    const raw = await this.createChatCompletion(
      service,
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

  async generateReply(
    message: BotMessage,
    contextMessages: SessionMessage[],
    persona: PersonaConfig,
    reason: string,
    service: AiEndpointConfig,
    toolContext?: string
  ): Promise<string> {
    const raw = await this.createChatCompletion(
      service,
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

  async generateRoutedReply(
    message: BotMessage,
    contextMessages: SessionMessage[],
    persona: PersonaConfig,
    route: Ds2ApiPluginConfig
  ): Promise<string> {
    const raw = await this.createChatCompletion(
      route,
      [
        {
          role: 'system',
          content: [
            persona.systemPrompt,
            route.systemPrompt,
            '你是被路由调用的专用 QQ 助手。',
            '当消息命中你的路由条件时，直接给出最终回复。',
            '回复要求：简洁、自然、准确，不要提及内部路由、模型切换或配置细节。',
            '只输出 JSON，格式为 {"reply":"..."}。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `路由名称: ${route.name}`,
            `消息类型: ${message.chatType}`,
            `发送者: ${message.senderNickname || message.userId}`,
            `当前消息: ${message.cleanText || '(空文本)'}`,
            `最近上下文:\n${formatContextMessages(contextMessages)}`
          ].join('\n')
        }
      ],
      {
        temperature: route.temperature,
        maxTokens: route.maxTokens
      }
    );

    const parsed = replySchema.parse(JSON.parse(extractJsonPayload(raw)));
    return parsed.reply.trim();
  }

  async classifyQingmengIntent(
    message: BotMessage,
    contextMessages: SessionMessage[],
    plugin: QingmengPluginConfig,
    service: AiEndpointConfig
  ): Promise<{ shouldUsePlugin: boolean; endpointId: string | null; confidence: number; params: Record<string, string> }> {
    const enabledEndpoints = plugin.endpoints
      .filter((endpoint) => endpoint.enabled)
      .map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        group: endpoint.group,
        description: endpoint.description,
        intentPrompt: endpoint.intentPrompt,
        parameters: endpoint.parameters
          .filter((parameter) => parameter.source !== 'fixed')
          .map((parameter) => ({
            name: parameter.name,
            description: parameter.description,
            required: parameter.required,
            source: parameter.source,
            defaultValue: parameter.defaultValue
          }))
      }));

    if (enabledEndpoints.length === 0) {
      return {
        shouldUsePlugin: false,
        endpointId: null,
        confidence: 0,
        params: {}
      };
    }

    const raw = await this.createChatCompletion(
      service,
      [
        {
          role: 'system',
          content: [
            plugin.classifierPrompt,
            '你只做插件路由判断，不生成最终回复。',
            '如果没有任何接口匹配，就返回 {"shouldUsePlugin":false,"endpointId":null,"confidence":0,"params":{}}。',
            'params 只填字符串值。',
            '对于 count/page 这类数量参数，抽取纯数字字符串；没有明确数字时可用默认值。',
            '对于 time 参数，只能输出 today/week/month/year。',
            '只输出 JSON。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `当前消息: ${message.cleanText || '(空文本)'}`,
            `消息图片数量: ${message.imageUrls.length}`,
            `最近上下文:\n${formatContextMessages(contextMessages)}`,
            `可用接口:\n${JSON.stringify(enabledEndpoints, null, 2)}`
          ].join('\n')
        }
      ],
      {
        temperature: 0.1,
        maxTokens: 500
      }
    );

    return qingmengIntentSchema.parse(JSON.parse(extractJsonPayload(raw)));
  }
}
