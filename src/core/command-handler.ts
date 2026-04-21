import type { BotMessage } from '../types/bot.js';
import { NapcatSender } from '../adapters/napcat/sender.js';
import { PersonaService } from '../services/persona-service.js';
import { RuleService } from '../services/rule-service.js';
import { SessionManager } from './session-manager.js';
import { logger } from '../utils/logger.js';

export interface CommandResult {
  handled: boolean;
}

export class CommandHandler {
  constructor(
    private readonly sender: NapcatSender,
    private readonly personaService: PersonaService,
    private readonly ruleService: RuleService,
    private readonly sessionManager: SessionManager
  ) {}

  async handle(message: BotMessage): Promise<CommandResult> {
    const rules = await this.ruleService.getRules();
    const text = message.cleanText.trim();

    if (!text.startsWith(rules.commandPrefix)) {
      return { handled: false };
    }

    const body = text.slice(rules.commandPrefix.length).trim();
    if (!body) {
      return { handled: false };
    }

    const [name, sub, ...rest] = body.split(/\s+/);
    const command = name.toLowerCase();
    const sessionKey = this.personaService.resolveSessionKey(message);

    logger.info({ command: body, userId: message.userId }, 'Command matched');

    if (command === 'help') {
      await this.reply(
        message,
        [
          '可用命令：',
          '/help',
          '/ping',
          '/session clear',
          '/persona',
          '/persona list (admin)',
          '/persona set <id> (admin)',
          '/ai on|off (admin)'
        ].join('\n')
      );
      return { handled: true };
    }

    if (command === 'ping') {
      await this.reply(message, 'pong');
      return { handled: true };
    }

    if (command === 'session' && sub?.toLowerCase() === 'clear') {
      await this.sessionManager.clearSession(sessionKey);
      await this.reply(message, '当前会话上下文已清空。');
      return { handled: true };
    }

    if (command === 'persona' && !sub) {
      const persona = await this.personaService.getCurrentPersona(sessionKey);
      await this.reply(message, `当前人格：${persona.id} (${persona.name})`);
      return { handled: true };
    }

    if (command === 'persona' && sub?.toLowerCase() === 'list') {
      if (!(await this.ruleService.isAdmin(message.userId))) {
        await this.reply(message, '你没有权限执行该管理员命令。');
        return { handled: true };
      }

      const personas = await this.personaService.listPersonas();
      const textReply = personas.map((item) => `- ${item.id}: ${item.name}`).join('\n');
      await this.reply(message, `人格列表：\n${textReply}`);
      return { handled: true };
    }

    if (command === 'persona' && sub?.toLowerCase() === 'set') {
      if (!(await this.ruleService.isAdmin(message.userId))) {
        await this.reply(message, '你没有权限执行该管理员命令。');
        return { handled: true };
      }

      const targetId = rest[0];
      if (!targetId) {
        await this.reply(message, '参数错误：用法 /persona set <id>');
        return { handled: true };
      }

      try {
        const persona = await this.personaService.setSessionPersona(sessionKey, targetId);
        await this.reply(message, `已切换当前会话人格为：${persona.id} (${persona.name})`);
      } catch (error) {
        await this.reply(message, `人格切换失败：${(error as Error).message}`);
      }
      return { handled: true };
    }

    if (command === 'ai' && (sub?.toLowerCase() === 'on' || sub?.toLowerCase() === 'off')) {
      if (!(await this.ruleService.isAdmin(message.userId))) {
        await this.reply(message, '你没有权限执行该管理员命令。');
        return { handled: true };
      }

      const enabled = sub.toLowerCase() === 'on';
      await this.ruleService.updateRules({ aiEnabled: enabled });
      await this.reply(message, enabled ? 'AI 已开启。' : 'AI 已关闭。');
      return { handled: true };
    }

    await this.reply(message, `未知命令：${body}\n输入 /help 查看帮助。`);
    return { handled: true };
  }

  private async reply(message: BotMessage, text: string): Promise<void> {
    await this.sender.sendText({
      chatType: message.chatType,
      userId: message.userId,
      groupId: message.groupId,
      message: text
    });
  }
}
