/**
 * NapCat / OneBot 相关类型定义。
 *
 * 这些类型不是对官方协议的完整建模，而是当前项目实际会读写字段的最小子集。
 * 如果未来需要接入更多事件或动作，应优先在这里扩展类型，再更新适配层。
 */
export interface NapcatMessageSegment {
  /** 分段类型，如 text、at、image。当前解析层主要依赖 text/at。 */
  type: string;
  /** 具体字段结构由 segment.type 决定，因此这里保守使用宽类型。 */
  data?: Record<string, unknown>;
}

/**
 * NapCat 事件中的发送者信息。
 */
export interface NapcatSender {
  user_id?: number;
  nickname?: string;
  card?: string;
}

/**
 * NapCat 消息事件的最小字段集合。
 *
 * 注意这里大量字段都是可选的，因为实际接收到的事件并不总是完整。
 * 适配层需要在运行时再次做字段完整性校验，不能仅依赖 TypeScript 静态类型。
 */
export interface NapcatMessageEvent {
  post_type?: string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  self_id?: number;
  time?: number;
  user_id?: number;
  group_id?: number;
  group_name?: string;
  message_id?: number;
  raw_message?: string;
  message?: string | NapcatMessageSegment[];
  sender?: NapcatSender;
  [key: string]: unknown;
}

/**
 * 发往 NapCat 的动作请求。
 *
 * `params` 结构与具体 action 强相关，当前项目没有做 action 级别的精细建模，
 * 这是为了保持发送层足够轻量；如果动作种类增多，再考虑细化。
 */
export interface NapcatActionRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: string;
}

/**
 * NapCat 动作响应的通用外形。
 *
 * 当前代码尚未消费该类型，但预留它可以帮助后续扩展请求-响应匹配逻辑。
 */
export interface NapcatActionResponse {
  status?: 'ok' | 'failed';
  retcode?: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: string;
}

export interface NapcatFriendListItem {
  user_id?: number;
  userId?: number;
  uin?: string | number;
  uid?: string | number;
  nickname?: string;
  nick?: string;
  remark?: string;
}

export interface NapcatGroupListItem {
  group_id?: number;
  groupId?: number;
  group_name?: string;
  groupName?: string;
  group_remark?: string;
  groupRemark?: string;
}
