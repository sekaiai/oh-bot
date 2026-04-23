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
  Ds2ApiRouteConfig,
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

const pluginRoutingSchema = z.object({
  target: z.enum(['none', 'qweather', 'qingmeng', 'ds2api']),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(''),
  ds2apiRouteId: z.string().nullable().default(null)
});

const GROUP_REPLY_TEMPERATURE_CAP = 0.35;
const PRIVATE_REPLY_TEMPERATURE_CAP = 0.55;
const ROUTED_REPLY_TEMPERATURE_CAP = 0.4;

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

function createDs2ApiService(plugin: Ds2ApiPluginConfig, route: Ds2ApiRouteConfig): AiEndpointConfig {
  return {
    baseUrl: plugin.baseUrl,
    apiKey: plugin.apiKey,
    model: route.model,
    timeoutMs: plugin.timeoutMs
  };
}

function clampTemperature(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getReplyTemperature(chatType: BotMessage['chatType'], value: number): number {
  const cap = chatType === 'group' ? GROUP_REPLY_TEMPERATURE_CAP : PRIVATE_REPLY_TEMPERATURE_CAP;
  return clampTemperature(Math.min(value, cap));
}

function getRoutedReplyTemperature(value: number): number {
  return clampTemperature(Math.min(value, ROUTED_REPLY_TEMPERATURE_CAP));
}

export interface PluginRoutingCandidateSummary {
  qweather: {
    enabled: boolean;
    intentPrompt: string;
  };
  qingmeng: {
    enabled: boolean;
    intentPrompt: string;
  };
  ds2api: {
    enabled: boolean;
    routes: Array<{
      id: string;
      name: string;
      intentPrompt: string;
    }>;
  };
}

export interface PluginRoutingDecision {
  target: 'none' | 'qweather' | 'qingmeng' | 'ds2api';
  confidence: number;
  reason: string;
  ds2apiRouteId: string | null;
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
            '判断标准以“机器人回复后是否能提供明显新增信息、结论、建议或执行帮助”为核心。',
            'score 高价值信号：明确问题、求助、任务请求、决策请求、纠错、追问、总结、翻译、分析、排查、要求给方案、明显在寻求机器人能力。',
            'score 中低价值信号：寒暄、接梗、附和、情绪表达、纯表情、单字灌水、哈哈哈、6、？、。 、在吗、重复刷屏、无上下文噪声。',
            '如果机器人就算回复，也大概率只是附和、接话、复述、玩梗、寒暄，没有信息增量，则 score 必须压低。',
            '只有当消息与上下文强相关，且机器人回复能带来明确信息增量，或明显是在寻求机器人能力时，isContextuallyRelevant 才能为 true。',
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
            '回复要求：简洁、自然、克制，优先提供结论、事实、建议或下一步动作。',
            '不要寒暄，不要卖萌，不要玩梗，不要附和式复述，不要用“哈哈”“确实”“懂你”“有点东西”这类低信息填充。',
            '如果没有足够信息，就只做必要澄清；不要为了显得像人在聊天而硬接话。',
            '私聊优先直接帮助用户；若需求不清，可以先用一句话澄清，再给可执行建议。',
            '群聊避免冗长，默认控制在 1 到 2 句，优先回答最关键的信息。',
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
        temperature: getReplyTemperature(message.chatType, persona.temperature),
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
    plugin: Ds2ApiPluginConfig,
    route: Ds2ApiRouteConfig,
    options?: {
      fallbackContext?: string;
    }
  ): Promise<string> {
    const raw = await this.createChatCompletion(
      createDs2ApiService(plugin, route),
      [
        {
          role: 'system',
          content: [
            persona.systemPrompt,
            route.systemPrompt,
            '你是被路由调用的专用 QQ 助手。',
            '当消息命中你的路由条件时，直接给出最终回复。',
            '回复要求：简洁、自然、准确，优先给结论和可执行信息。',
            '不要寒暄，不要接梗，不要附和式复述，不要提及内部路由、模型切换或配置细节。',
            '只输出 JSON，格式为 {"reply":"..."}。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `路由名称: ${route.name}`,
            `路由模型: ${route.model}`,
            `消息类型: ${message.chatType}`,
            `发送者: ${message.senderNickname || message.userId}`,
            `当前消息: ${message.cleanText || '(空文本)'}`,
            `消息图片数量: ${message.imageUrls.length}`,
            message.imageUrls.length > 0 ? `消息图片链接:\n${message.imageUrls.join('\n')}` : '消息图片链接: 无',
            `最近上下文:\n${formatContextMessages(contextMessages)}`,
            options?.fallbackContext ? `回退上下文:\n${options.fallbackContext}` : '回退上下文: 无'
          ].join('\n')
        }
      ],
      {
        temperature: getRoutedReplyTemperature(route.temperature),
        maxTokens: route.maxTokens
      }
    );

    const parsed = replySchema.parse(JSON.parse(extractJsonPayload(raw)));
    return parsed.reply.trim();
  }

  async generateScheduledTaskText(
    plugin: Ds2ApiPluginConfig,
    route: Ds2ApiRouteConfig,
    prompt: string
  ): Promise<string> {
    const raw = await this.createChatCompletion(
      createDs2ApiService(plugin, route),
      [
        {
          role: 'system',
          content: [
            route.systemPrompt,
            '你正在为一个定时任务生成将要直接发送给 QQ 群或私聊的内容。',
            '输出必须自然、明确、可直接发送。',
            '不要解释内部配置，不要提及模型、路由或系统提示词。',
            '如果用户给的是固定播报任务，就直接生成最终文案。',
            '只输出纯文本。'
          ].join('\n')
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      {
        temperature: getRoutedReplyTemperature(route.temperature),
        maxTokens: route.maxTokens
      }
    );

    return raw.trim();
  }

  async classifyPluginRoute(
    message: BotMessage,
    contextMessages: SessionMessage[],
    candidates: PluginRoutingCandidateSummary,
    service: AiEndpointConfig
  ): Promise<PluginRoutingDecision> {
    const raw = await this.createChatCompletion(
      service,
      [
        {
          role: 'system',
          content: [
            '你是 QQ 机器人的主路由器，只负责判断当前消息应该交给哪个插件处理。',
            '优先级原则：',
            '1. 天气、空气质量、预警、日出日落等实时天气请求走 qweather。',
            '2. 图片/视频/语音/新闻/图片分析等外部接口能力走 qingmeng。',
            '3. 其他普通问答、闲聊、技术问题、复杂分析默认走 ds2api，并为 ds2apiRouteId 选择最合适的路由。',
            '4. 只有在当前消息明显不适合任何插件，且 ds2api 也未启用时，才返回 none。',
            '如果 target=ds2api，必须返回一个可用的 ds2apiRouteId。',
            '你不生成最终回复，只输出 JSON。',
            '格式固定为 {"target":"ds2api","confidence":0.9,"reason":"...","ds2apiRouteId":"chat"}。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `当前消息: ${message.cleanText || '(空文本)'}`,
            `消息图片数量: ${message.imageUrls.length}`,
            message.imageUrls.length > 0 ? `消息图片链接:\n${message.imageUrls.join('\n')}` : '消息图片链接: 无',
            `最近上下文:\n${formatContextMessages(contextMessages)}`,
            `可用插件摘要:\n${JSON.stringify(candidates, null, 2)}`
          ].join('\n')
        }
      ],
      {
        temperature: 0.1,
        maxTokens: 500
      }
    );

    return pluginRoutingSchema.parse(JSON.parse(extractJsonPayload(raw)));
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
