/**
 * NapCat 消息解析适配层。
 *
 * 该模块负责把 NapCat 原始事件转换为项目内部统一的 `BotMessage`。
 * 设计重点不是“完整保留协议细节”，而是筛出当前业务真正需要且稳定的字段，
 * 从而把外部协议变化的影响控制在适配层内。
 */
import type { BotMessage } from '../../types/bot.js';
import type { NapcatMessageEvent, NapcatMessageSegment } from '../../types/napcat.js';
import { toStringId } from '../../utils/helpers.js';

/**
 * 从 NapCat 的消息体中提取纯文本内容。
 *
 * 输入：
 * - `message`：可能是字符串，也可能是分段数组；
 * - `rawMessage`：NapCat 提供的原始消息回退值。
 *
 * 输出：一个尽量可用于文本指令判断的字符串。
 *
 * 这里故意只拼接 `text` 段，不尝试还原 `at`、图片、回复等复合语义。
 * 原因是当前业务只依赖纯文本命令；如果未来需要完整消息语义，应在统一模型上扩展字段，
 * 而不是在 `cleanText` 中混入协议细节。
 */
function extractText(message: NapcatMessageEvent['message'], rawMessage?: string): string {
  if (typeof message === 'string') {
    return message;
  }

  if (Array.isArray(message)) {
    const segments = message as NapcatMessageSegment[];
    return segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => String(segment.data?.text ?? ''))
      .join('')
      .trim();
  }

  // 某些异常上报可能没有结构化 message，此时尽量保留原始文本，避免消息被完全吞掉。
  return rawMessage ?? '';
}

/**
 * 判断群消息中是否显式 @ 了当前机器人。
 *
 * 该判断依赖 NapCat 的数组消息结构；如果消息已经退化为纯字符串，
 * 就无法可靠判断 @ 目标，只能保守地返回 false。
 */
function hasAtSelf(message: NapcatMessageEvent['message'], selfId: string): boolean {
  if (!selfId || !Array.isArray(message)) {
    return false;
  }

  return message.some(
    (segment) =>
      segment?.type === 'at' &&
      String((segment.data?.qq as string | number | undefined) ?? '') === selfId
  );
}

/**
 * 将 NapCat 原始事件解析为统一消息模型。
 *
 * 输入：未知来源的事件对象。
 * 输出：若是当前可处理的消息事件，则返回 `BotMessage`；否则返回 `null`。
 *
 * 主要流程：
 * 1. 做最外层类型守卫，避免对未知结构直接取字段；
 * 2. 过滤掉非 message 事件和非私聊/群聊消息；
 * 3. 规范化关键 ID；
 * 4. 校验当前业务最小必需字段；
 * 5. 生成统一消息对象供上层处理。
 */
export function parseNapcatMessage(event: unknown): BotMessage | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const payload = event as NapcatMessageEvent;

  // 当前入口只消费消息事件；通知、请求、元事件都交给调用方直接忽略。
  if (payload.post_type !== 'message') {
    return null;
  }

  if (payload.message_type !== 'private' && payload.message_type !== 'group') {
    return null;
  }

  const selfId = toStringId(payload.self_id);
  const userId = toStringId(payload.user_id);
  const groupId = toStringId(payload.group_id);
  const messageId = toStringId(payload.message_id);

  /**
   * 这些字段是内部统一消息模型成立的最小前提。
   * 如果缺失，继续往下传会让后续日志、去重、回复目标判断都处于不确定状态。
   */
  if (!selfId || !userId || !messageId) {
    return null;
  }

  // 群消息没有 groupId 时无法确定回复目标，直接视为无效事件。
  if (payload.message_type === 'group' && !groupId) {
    return null;
  }

  const rawText = extractText(payload.message, payload.raw_message).trim();
  const isAtBot = hasAtSelf(payload.message, selfId);

  /**
   * 当前 `cleanText` 与 `rawText` 保持一致，等价于“尚未做命令清洗”。
   * 这里保留两个字段，是为了给未来的前处理流程预留稳定接口，
   * 例如去除前缀、去除 @、标准化空白字符等。
   */
  return {
    messageId,
    userId,
    groupId: payload.message_type === 'group' ? groupId : undefined,
    chatType: payload.message_type,
    rawText,
    cleanText: rawText,
    isAtBot,
    selfId,
    senderNickname: payload.sender?.card || payload.sender?.nickname,
    // 协议未提供时间时使用当前时间兜底，保证下游记录/排序逻辑始终拿到数值。
    time: typeof payload.time === 'number' ? payload.time : Math.floor(Date.now() / 1000),
    // 原始事件保留在统一模型中，便于未来扩展协议特有能力时回溯上下文。
    rawEvent: event
  };
}
