import type { BotMessage } from '../types/bot.js';
import type { RuleConfig } from '../types/bot.js';

export interface RuleCheckResult {
  allowed: boolean;
  reason?: string;
}

export class RuleEngine {
  private readonly cooldownMap = new Map<string, number>();

  checkMessage(message: BotMessage, rules: RuleConfig): RuleCheckResult {
    if (rules.blacklistUsers.includes(message.userId)) {
      return { allowed: false, reason: '你已被加入黑名单。' };
    }

    if (
      message.chatType === 'group' &&
      rules.whitelistGroups.length > 0 &&
      message.groupId &&
      !rules.whitelistGroups.includes(message.groupId)
    ) {
      return { allowed: false, reason: '当前群不在白名单内。' };
    }

    return { allowed: true };
  }

  checkAiAllowed(message: BotMessage, rules: RuleConfig): RuleCheckResult {
    if (!rules.aiEnabled) {
      return { allowed: false, reason: 'AI 功能当前已关闭。' };
    }

    if (message.chatType === 'group' && rules.requireAtInGroup && !message.isAtBot) {
      return { allowed: false, reason: '群聊需 @ 机器人才触发 AI。' };
    }

    const now = Date.now();
    const cooldownMs = rules.cooldownSeconds * 1000;
    const key = message.chatType === 'group' ? `group:${message.groupId}` : `private:${message.userId}`;
    const last = this.cooldownMap.get(key) ?? 0;

    if (cooldownMs > 0 && now - last < cooldownMs) {
      return { allowed: false, reason: '触发过于频繁，请稍后再试。' };
    }

    this.cooldownMap.set(key, now);
    return { allowed: true };
  }
}
