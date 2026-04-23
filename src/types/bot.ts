/**
 * 项目内部统一消息模型。
 *
 * 这些类型的目标是隔离外部协议差异，让业务代码尽量只依赖本项目自己的语义字段。
 * 如果未来接入新的平台，优先扩展适配层把外部事件映射到这些类型，而不是直接把平台字段暴露给业务。
 */
export type ChatType = 'private' | 'group';

/**
 * 业务层可直接消费的统一消息对象。
 *
 * 与 NapCat 原始事件相比，这个结构已经做过最小规范化：
 * - 关键 ID 统一为 string；
 * - 群聊/私聊目标被收敛为 `chatType + userId/groupId`；
 * - 同时保留 `rawEvent` 供协议特性扩展时兜底使用。
 */
export interface BotMessage {
  /** 协议侧消息唯一标识，后续做去重或关联回复时会依赖它。 */
  messageId: string;
  /** 发送者 ID，内部统一为 string，避免不同协议整数精度问题。 */
  userId: string;
  /** 群聊场景下的群 ID；私聊中留空。 */
  groupId?: string;
  /** 群聊场景下的群名称；私聊中留空。 */
  groupName?: string;
  chatType: ChatType;
  /** 从协议事件中提取出的原始文本视图。 */
  rawText: string;
  /** 预留给文本清洗后的结果，当前与 `rawText` 一致。 */
  cleanText: string;
  /** 消息里提取出的图片链接，供看图、OCR、图片插件等能力使用。 */
  imageUrls: string[];
  /** 是否显式 @ 到机器人；主要用于群聊触发策略。 */
  isAtBot: boolean;
  /** 机器人自身账号 ID，用于判断 @ 和消息归属。 */
  selfId: string;
  senderNickname?: string;
  /** 统一的 Unix 时间戳秒值；协议缺失时会由适配层回填当前时间。 */
  time: number;
  /** 原始协议事件；仅在需要协议特性时使用，避免上层丢失上下文。 */
  rawEvent: unknown;
}

/**
 * 统一发送参数。
 *
 * 该类型只表达“发送意图”，不直接暴露协议动作名称。
 * 目标是让发送层拥有唯一的协议转换入口。
 */
export interface OutboundMessageSegment {
  /**
   * NapCat / OneBot 消息段类型。
   *
   * 这里不做更细的字面量枚举，是为了给后续扩展留空间：
   * 当前先支持 text / image / record / video，
   * 以后如果要发 reply、face、at、file，不需要再修改基础类型。
   */
  type: string;
  /**
   * 消息段负载。
   *
   * 常见场景：
   * - text: `{ text: '...' }`
   * - image/record/video: `{ file: 'https://...' }`
   */
  data?: Record<string, unknown>;
}

/**
 * 统一的发送内容。
 *
 * 这里允许同时接受：
 * - 纯字符串：兼容当前全部文本发送链路；
 * - 消息段数组：支持图文、语音、视频等富消息。
 */
export type OutboundMessageContent = string | OutboundMessageSegment[];

export interface SendMessageParams {
  chatType: ChatType;
  userId?: string;
  groupId?: string;
  message: OutboundMessageContent;
}

// `tool` 角色是为联网工具结果预留的语义位。
// 当前实现里工具结果还没有落到完整会话消息中，但先把类型边界补齐，后面扩展搜索/地图等工具时不用再改基础模型。
export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 回复决策原因枚举。
 *
 * 这里刻意使用稳定字符串，而不是让模型自由产出原因文本，
 * 目的是方便后续做日志统计、行为分析和规则排查。
 */
export type ReplyReason =
  | 'private_blacklist'
  | 'group_blacklist'
  | 'private_default'
  | 'group_at'
  | 'group_name_mention'
  | 'group_context_high_value'
  | 'group_context_related'
  | 'group_low_value'
  | 'cooldown'
  | 'duplicate'
  | 'group_consecutive_reply_guard'
  | 'ai_disabled'
  | 'model_error'
  | 'tool_weather'
  | 'tool_ds2api'
  | 'tool_qingmeng'
  | 'tool_missing_location'
  | 'tool_error';

/**
 * 回复引擎的统一输出。
 *
 * 上层调用方只依赖这个结构：
 * - `shouldReply` 决定是否继续发送；
 * - `reason` 解释触发路径；
 * - `score` 仅在价值判断场景下出现；
 * - `reply` 仅在最终确定要回复时存在。
 */
export interface ReplyDecision {
  shouldReply: boolean;
  reason: ReplyReason;
  score?: number;
  reply?: string;
  outboundMessage?: OutboundMessageContent;
}

/**
 * 会话消息结构。
 *
 * 当前代码尚未用到完整会话链路，但这些类型已经定义了后续 AI 对话状态的最小数据模型。
 */
export interface SessionMessage {
  role: SessionRole;
  content: string;
  time: number;
  messageId?: string;
  userId?: string;
  senderNickname?: string;
  groupName?: string;
  chatType?: ChatType;
  isAtBot?: boolean;
  reason?: ReplyReason;
}

/**
 * 人设配置。
 *
 * 这里的字段设计明显面向后续 LLM 接入；
 * 如果继续开发，应尽量在配置层扩展，而不是把 prompt 参数硬编码进业务逻辑。
 */
export interface PersonaConfig {
  id: string;
  name: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface PersonaRegistry {
  defaultPersonaId: string;
  personas: PersonaConfig[];
  bindings: Record<string, string>;
}

/**
 * 单个聊天会话的持久化状态。
 *
 * 当前只保存回复引擎最需要的状态：
 * - 最近消息，用于构造上下文；
 * - 已处理消息 ID，用于去重；
 * - 最近一次回复时间，用于冷却控制。
 */
export interface ChatSession {
  messages: SessionMessage[];
  handledMessageIds: string[];
  lastReplyAt?: number;
  contextSummary?: string;
}

/**
 * 所有会话的持久化快照。
 */
export interface SessionsData {
  sessions: Record<string, ChatSession>;
}

export interface ScheduledTaskTarget {
  chatType: ChatType;
  targetId: string;
  displayName: string;
}

export type ScheduledTaskRunStatus = 'success' | 'partial' | 'failed';

export interface ScheduledTaskExecutionTargetResult {
  chatType: ChatType;
  targetId: string;
  displayName: string;
  ok: boolean;
  error?: string;
}

export interface ScheduledTaskExecutionLog {
  id: string;
  scheduledFor: string;
  executedAt: number;
  status: ScheduledTaskRunStatus;
  message: string;
  results: ScheduledTaskExecutionTargetResult[];
}

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  jitterSeconds: number;
  messageTemplate: string;
  pluginId?: PluginKind | '';
  pluginPayload?: Record<string, unknown>;
  targets: ScheduledTaskTarget[];
  lastRunAt?: number;
  lastRunScheduledFor?: string;
  lastRunStatus?: ScheduledTaskRunStatus;
  lastRunMessage?: string;
  logs: ScheduledTaskExecutionLog[];
}

export type TaskTargetSource = 'session' | 'napcat';

export interface TaskTargetOption {
  chatKey: string;
  chatType: ChatType;
  targetId: string;
  displayName: string;
  status: 'available' | 'banned';
  source: TaskTargetSource;
}

/**
 * 运行规则配置。
 *
 * 这类字段通常决定“消息是否应该继续进入业务处理”，
 * 因此后续接入时建议在入口或路由早期统一判断，避免各功能模块各自重复校验。
 */
export interface RuleConfig {
  admins: string[];
  whitelistGroups: string[];
  blacklistUsers: string[];
  privateBlacklist: string[];
  groupBlacklist: string[];
  botNames: string[];
  requireAtInGroup: boolean;
  aiEnabled: boolean;
  commandPrefix: string;
  cooldownSeconds: number;
}

export interface AiEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export type PluginKind = 'ds2api' | 'qweather' | 'qingmeng';

export interface PluginConfigBase {
  id: string;
  kind: PluginKind;
  name: string;
  enabled: boolean;
}

export interface Ds2ApiRouteConfig {
  id: string;
  name: string;
  enabled: boolean;
  model: string;
  intentPrompt: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface Ds2ApiPluginConfig extends PluginConfigBase {
  kind: 'ds2api';
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  routes: Ds2ApiRouteConfig[];
}

export interface QWeatherPluginConfig extends PluginConfigBase {
  kind: 'qweather';
  apiHost: string;
  apiKey: string;
  lang: string;
}

export type QingmengEndpointGroup = 'image' | 'video' | 'audio' | 'text' | 'tool' | 'analysis';

export type QingmengParameterSource = 'fixed' | 'intent' | 'image_url';

export type QingmengResponseMode = 'json_value' | 'json_list' | 'openai_text' | 'redirect_media';

export type QingmengDisplayMode = 'none' | 'fixed';

export interface QingmengEndpointParameter {
  id: string;
  name: string;
  label: string;
  description: string;
  source: QingmengParameterSource;
  required: boolean;
  defaultValue: string;
}

export interface QingmengEndpointConfig {
  id: string;
  name: string;
  enabled: boolean;
  group: QingmengEndpointGroup;
  description: string;
  intentAliases: string[];
  fallbackEligible: boolean;
  method: 'GET';
  url: string;
  intentPrompt: string;
  parameters: QingmengEndpointParameter[];
  responseMode: QingmengResponseMode;
  responsePath?: string;
  listPath?: string;
  itemTitlePath?: string;
  itemUrlPath?: string;
  displayMode?: QingmengDisplayMode;
  displayText?: string;
  captionTemplate?: string;
  sampleInput: string;
  sampleImageUrl?: string;
}

export interface QingmengPluginConfig extends PluginConfigBase {
  kind: 'qingmeng';
  ckey: string;
  classifierPrompt: string;
  endpoints: QingmengEndpointConfig[];
}

export type PluginConfig = Ds2ApiPluginConfig | QWeatherPluginConfig | QingmengPluginConfig;
