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
  chatType: ChatType;
  /** 从协议事件中提取出的原始文本视图。 */
  rawText: string;
  /** 预留给文本清洗后的结果，当前与 `rawText` 一致。 */
  cleanText: string;
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
export interface SendMessageParams {
  chatType: ChatType;
  userId?: string;
  groupId?: string;
  message: string;
}

export type SessionRole = 'system' | 'user' | 'assistant';

/**
 * 会话消息结构。
 *
 * 当前代码尚未用到完整会话链路，但这些类型已经定义了后续 AI 对话状态的最小数据模型。
 */
export interface SessionMessage {
  role: SessionRole;
  content: string;
  time: number;
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
  requireAtInGroup: boolean;
  aiEnabled: boolean;
  commandPrefix: string;
  cooldownSeconds: number;
}
