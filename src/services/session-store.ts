/**
 * 会话状态存储层。
 *
 * 这个模块的职责不是做业务判断，而是为回复引擎提供“可持久化的最小记忆”：
 * 保存最近消息、去重 ID 和冷却时间。
 *
 * 当前实现使用本地 JSON 文件，优点是简单透明，缺点是并发能力有限，
 * 所以内部用串行 mutationQueue 保证同进程内不会把文件写乱。
 */
import { writeFile } from 'node:fs/promises';
import type { BotMessage, ChatSession, ReplyReason, SessionMessage, SessionsData } from '../types/bot.js';
import { ensureDataDir, loadSessionsData, sessionsPath } from './data-repository.js';

const MAX_SESSION_MESSAGES = 60;
const MAX_HANDLED_MESSAGE_IDS = 200;
const SUMMARY_SOURCE_WINDOW = 18;
const SUMMARY_ITEM_LIMIT = 6;
const SUMMARY_CONTENT_LIMIT = 48;
const LOW_INFORMATION_SUMMARY_PATTERNS = [
  /^(哈)+[哈呵嘿]*[~!！。.?？]*$/i,
  /^(嗯+|哦+|啊+|欸+)[~!！。.?？]*$/i,
  /^(收到|好的|知道了|懂了|明白了|ok|okk|yes)[~!！。.?？]*$/i,
  /^(6+|？+|!+|。+|在吗)[~!！。.?？]*$/i
];

function normalizeSummaryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function shouldSkipSummaryMessage(message: SessionMessage): boolean {
  if (message.role === 'system') {
    return true;
  }

  const compact = normalizeSummaryContent(message.content);
  if (!compact) {
    return true;
  }

  if (compact.length <= 12 && LOW_INFORMATION_SUMMARY_PATTERNS.some((pattern) => pattern.test(compact))) {
    return true;
  }

  return false;
}

function summarizeSessionMessages(messages: SessionMessage[]): string {
  const recentMessages = messages.slice(-SUMMARY_SOURCE_WINDOW);
  const lines = recentMessages
    .filter((message) => !shouldSkipSummaryMessage(message))
    .slice(-SUMMARY_ITEM_LIMIT)
    .map((message) => {
      const roleLabel = message.role === 'assistant'
        ? '机器人'
        : message.role === 'tool'
          ? '工具'
          : '用户';
      const normalized = normalizeSummaryContent(message.content);
      const clipped = normalized.length > SUMMARY_CONTENT_LIMIT
        ? `${normalized.slice(0, SUMMARY_CONTENT_LIMIT)}...`
        : normalized;
      return `${roleLabel}: ${clipped}`;
    });

  return lines.join('\n');
}

export class SessionStore {
  private data: SessionsData | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  /**
   * 延迟加载会话数据。
   *
   * 只在首次使用时读盘，后续都复用内存快照，
   * 以减少每条消息都重复读取整个 `sessions.json`。
   */
  private async ensureLoaded(): Promise<SessionsData> {
    if (!this.data) {
      this.data = await loadSessionsData();
    }
    return this.data;
  }

  /**
   * 将当前内存快照刷回磁盘。
   */
  private async flush(): Promise<void> {
    await ensureDataDir();
    await writeFile(sessionsPath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  /**
   * 获取指定会话的可写引用；不存在时自动初始化。
   *
   * 会话 key 在上层统一按 `group:<id>` / `private:<id>` 生成，
   * 这样群聊和私聊能共用一套存储结构。
   */
  private getSessionRef(data: SessionsData, chatKey: string): ChatSession {
    if (!data.sessions[chatKey]) {
      data.sessions[chatKey] = {
        messages: [],
        handledMessageIds: []
      };
    }

    return data.sessions[chatKey];
  }

  /**
   * 串行执行一次带持久化的状态修改。
   *
   * 这里用 promise 链做最轻量的进程内互斥，避免多个异步消息同时写盘时互相覆盖。
   */
  private async mutate<T>(task: (data: SessionsData) => T | Promise<T>): Promise<T> {
    let result: T;

    const run = async (): Promise<void> => {
      const data = await this.ensureLoaded();
      result = await task(data);
      await this.flush();
    };

    this.mutationQueue = this.mutationQueue.then(run, run);
    await this.mutationQueue;
    return result!;
  }

  /**
   * 获取会话快照。
   *
   * 返回的是副本而不是原始引用，避免调用方无意中绕过持久化层直接修改内存状态。
   */
  async getSession(chatKey: string): Promise<ChatSession> {
    await this.mutationQueue;
    const data = await this.ensureLoaded();
    const session = this.getSessionRef(data, chatKey);
    return {
      messages: [...session.messages],
      handledMessageIds: [...session.handledMessageIds],
      lastReplyAt: session.lastReplyAt,
      contextSummary: session.contextSummary ?? summarizeSessionMessages(session.messages)
    };
  }

  /**
   * 判断某条消息是否已经处理过。
   */
  async hasHandledMessage(chatKey: string, messageId: string): Promise<boolean> {
    const session = await this.getSession(chatKey);
    return session.handledMessageIds.includes(messageId);
  }

  /**
   * 记录一条用户输入消息。
   *
   * 这里先写会话消息，再写 handledMessageIds，
   * 这样即便后续调试只看 `messages`，上下文也不会缺失。
   */
  async recordInboundMessage(chatKey: string, message: BotMessage): Promise<void> {
    await this.mutate((data) => {
      const session = this.getSessionRef(data, chatKey);
      const sessionMessage: SessionMessage = {
        role: 'user',
        content: message.cleanText,
        time: message.time,
        messageId: message.messageId,
        userId: message.userId,
        senderNickname: message.senderNickname,
        groupName: message.groupName,
        chatType: message.chatType,
        isAtBot: message.isAtBot
      };

      session.messages.push(sessionMessage);
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
      session.contextSummary = summarizeSessionMessages(session.messages);

      if (!session.handledMessageIds.includes(message.messageId)) {
        session.handledMessageIds.push(message.messageId);
        session.handledMessageIds = session.handledMessageIds.slice(-MAX_HANDLED_MESSAGE_IDS);
      }
    });
  }

  /**
   * 记录一条机器人回复。
   *
   * `reason` 会一起持久化，方便后续排查“这条回复是因为 @、高价值评分还是私聊默认触发”。
   */
  async recordAssistantReply(
    chatKey: string,
    reply: string,
    time: number,
    reason: ReplyReason
  ): Promise<void> {
    await this.mutate((data) => {
      const session = this.getSessionRef(data, chatKey);
      const sessionMessage: SessionMessage = {
        role: 'assistant',
        content: reply,
        time,
        reason
      };

      session.messages.push(sessionMessage);
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
      session.contextSummary = summarizeSessionMessages(session.messages);
      session.lastReplyAt = time;
    });
  }
}
