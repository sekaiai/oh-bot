import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import type { AiEndpointConfig, BotMessage, RuleConfig, SessionMessage } from '../types/bot.js';
import { logger } from '../utils/logger.js';
import { AiClient, type AffectionDeltas } from './ai-client.js';

interface AffectionConfig {
  enabled: boolean;
  modifySensitivity: number;
  initialAffection: number;
  initialLibidoOther: number;
  initialAggressionOther: number;
  initialLibidoSelf: number;
  initialAggressionSelf: number;
  decayDurationHours: number;
}

interface UserAffectionState {
  baseLibidoOther: number;
  baseAggressionOther: number;
  affection: number;
  currentLibidoOther: number;
  currentAggressionOther: number;
  turnCount: number;
  lastInteraction: number;
  lastUpdate: number;
}

interface SelfAffectionState {
  baseLibidoSelf: number;
  baseAggressionSelf: number;
  currentLibidoSelf: number;
  currentAggressionSelf: number;
  lastUpdate: number;
}

const DEFAULT_AFFECTION_CONFIG: AffectionConfig = {
  enabled: true,
  modifySensitivity: 30,
  initialAffection: 50,
  initialLibidoOther: 25,
  initialAggressionOther: 25,
  initialLibidoSelf: 25,
  initialAggressionSelf: 25,
  decayDurationHours: 2
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getBotId(message: BotMessage): string {
  return message.selfId || 'default_bot';
}

function getUserKey(message: BotMessage): string {
  return message.userId || 'unknown';
}

function formatContext(contextMessages: SessionMessage[]): string {
  return contextMessages
    .slice(-6)
    .map((item) => {
      const name = item.senderNickname || item.userId || item.role;
      return `[${item.role}] ${name}: ${item.content}`;
    })
    .join('\n') || '无最近上下文';
}

function computeDecay(elapsedHours: number, deviation: number, durationHours: number): number {
  if (durationHours <= 0 || elapsedHours >= durationHours) {
    return -deviation;
  }

  return -deviation * ((elapsedHours / durationHours) ** 2);
}

function createUserState(now: number, configValue: AffectionConfig): UserAffectionState {
  return {
    baseLibidoOther: configValue.initialLibidoOther,
    baseAggressionOther: configValue.initialAggressionOther,
    affection: configValue.initialAffection,
    currentLibidoOther: configValue.initialLibidoOther,
    currentAggressionOther: configValue.initialAggressionOther,
    turnCount: 0,
    lastInteraction: now,
    lastUpdate: now
  };
}

function createSelfState(now: number, configValue: AffectionConfig): SelfAffectionState {
  return {
    baseLibidoSelf: configValue.initialLibidoSelf,
    baseAggressionSelf: configValue.initialAggressionSelf,
    currentLibidoSelf: configValue.initialLibidoSelf,
    currentAggressionSelf: configValue.initialAggressionSelf,
    lastUpdate: now
  };
}

function getTowardsUserLabel(user: UserAffectionState): string {
  if (user.affection >= 75 && user.currentAggressionOther >= 32) {
    return '有点吃醋或小别扭';
  }
  if (user.affection >= 65 && user.currentLibidoOther >= 32) {
    return '亲近、信任、愿意陪着';
  }
  if (user.affection <= 30 && user.currentAggressionOther >= 28) {
    return '疏离、警惕、不太想靠近';
  }
  if (user.currentAggressionOther >= 38) {
    return '明显烦躁，但仍保持分寸';
  }
  if (user.currentLibidoOther <= 14) {
    return '有点冷淡和回避';
  }
  return '平稳、自然、像熟悉的朋友';
}

function getSelfLabel(self: SelfAffectionState): string {
  if (self.currentAggressionSelf >= 37 && self.currentLibidoSelf <= 14) {
    return '低落、自责，需要克制表达，不要失控';
  }
  if (self.currentLibidoSelf >= 35 && self.currentAggressionSelf <= 18) {
    return '稳定、自洽、温柔';
  }
  if (self.currentAggressionSelf >= 34) {
    return '有些不安或自责';
  }
  return '平静、稳定';
}

export class AffectionEngine {
  private readonly aiClient = new AiClient();
  private readonly dataRoot = path.resolve(process.cwd(), config.DATA_DIR, 'affection');

  async buildPrompt(message: BotMessage): Promise<string> {
    const affectionConfig = await this.loadConfig();
    if (!affectionConfig.enabled) {
      return '';
    }

    const now = message.time || Math.floor(Date.now() / 1000);
    const botData = await this.loadBotData(getBotId(message), affectionConfig, now);
    const userKey = getUserKey(message);
    const user = botData.users[userKey] ?? createUserState(now, affectionConfig);
    const { user: decayedUser, self } = this.applyDecay(user, botData.self, now, affectionConfig);

    botData.users[userKey] = decayedUser;
    botData.self = self;
    await this.saveBotData(getBotId(message), botData);

    return [
      '【当前情绪状态】',
      `对用户的情感：${getTowardsUserLabel(decayedUser)}`,
      `自身状态：${getSelfLabel(self)}`,
      `好感倾向：${decayedUser.affection.toFixed(1)}/100`,
      `他力比多：${decayedUser.currentLibidoOther.toFixed(1)}/50；他攻击性：${decayedUser.currentAggressionOther.toFixed(1)}/50`,
      `自力比多：${self.currentLibidoSelf.toFixed(1)}/50；自攻击性：${self.currentAggressionSelf.toFixed(1)}/50`,
      '请只把这些数值当作语气参考：自然演绎亲近、疏离、别扭或稳定感，不要提到数值、面板、插件或内部状态。',
      '即使攻击性较高，也只能表现为轻微别扭、简短吐槽或有分寸的冷淡，不能辱骂、威胁、PUA、诱导依赖或输出自毁内容。'
    ].join('\n');
  }

  async updateAfterMessage(message: BotMessage, contextMessages: SessionMessage[]): Promise<void> {
    const affectionConfig = await this.loadConfig();
    if (!affectionConfig.enabled || !message.cleanText.trim()) {
      return;
    }

    const now = message.time || Math.floor(Date.now() / 1000);
    const botId = getBotId(message);
    const userKey = getUserKey(message);
    const botData = await this.loadBotData(botId, affectionConfig, now);
    const user = botData.users[userKey] ?? createUserState(now, affectionConfig);
    const { user: decayedUser, self } = this.applyDecay(user, botData.self, now, affectionConfig);

    const service: AiEndpointConfig = {
      baseUrl: config.AI_BASE_URL,
      apiKey: config.AI_API_KEY,
      model: config.AI_MODEL,
      timeoutMs: config.AI_TIMEOUT_MS
    };

    let deltas: AffectionDeltas;
    try {
      deltas = await this.aiClient.analyzeAffectionDeltas(service, this.buildAnalysisPrompt(decayedUser, self, message, contextMessages));
    } catch (error) {
      logger.warn({ err: error, messageId: message.messageId }, 'Affection analysis failed; using small fallback delta');
      deltas = {
        libidoOtherDelta: 0.05,
        aggressionOtherDelta: 0.02,
        libidoSelfDelta: 0,
        aggressionSelfDelta: 0,
        affectionDelta: 0,
        baseLibidoOtherDelta: 0,
        baseAggressionOtherDelta: 0,
        baseLibidoSelfDelta: 0,
        baseAggressionSelfDelta: 0,
        intensity: 1
      };
    }

    const sensitivity = (affectionConfig.modifySensitivity / 100) * deltas.intensity;
    const baseOtherFactor = decayedUser.turnCount <= 10 ? 1 : 0.2;

    const nextUser: UserAffectionState = {
      ...decayedUser,
      currentLibidoOther: clamp(decayedUser.currentLibidoOther + deltas.libidoOtherDelta * sensitivity, 0, 50),
      currentAggressionOther: clamp(decayedUser.currentAggressionOther + deltas.aggressionOtherDelta * sensitivity, 0, 50),
      affection: clamp(decayedUser.affection + deltas.affectionDelta * sensitivity, 0, 100),
      baseLibidoOther: clamp(decayedUser.baseLibidoOther + deltas.baseLibidoOtherDelta * baseOtherFactor, 0, 50),
      baseAggressionOther: clamp(decayedUser.baseAggressionOther + deltas.baseAggressionOtherDelta * baseOtherFactor, 0, 50),
      turnCount: decayedUser.turnCount + 1,
      lastInteraction: now,
      lastUpdate: now
    };

    const nextSelf: SelfAffectionState = {
      ...self,
      currentLibidoSelf: clamp(self.currentLibidoSelf + deltas.libidoSelfDelta * sensitivity, 0, 50),
      currentAggressionSelf: clamp(self.currentAggressionSelf + deltas.aggressionSelfDelta * sensitivity, 0, 50),
      baseLibidoSelf: clamp(self.baseLibidoSelf + deltas.baseLibidoSelfDelta * 0.2, 0, 50),
      baseAggressionSelf: clamp(self.baseAggressionSelf + deltas.baseAggressionSelfDelta * 0.2, 0, 50),
      lastUpdate: now
    };

    botData.users[userKey] = nextUser;
    botData.self = nextSelf;
    await this.saveBotData(botId, botData);
  }

  async handleCommand(message: BotMessage, rules: RuleConfig): Promise<string | null> {
    const text = message.cleanText.trim();
    if (!text.startsWith(rules.commandPrefix)) {
      return null;
    }

    const [command, ...args] = text.slice(rules.commandPrefix.length).trim().split(/\s+/);
    if (!['mystatus', 'reset_emotion', 'reset_all_emotions'].includes(command)) {
      return null;
    }

    const affectionConfig = await this.loadConfig();
    const botId = getBotId(message);
    const userKey = getUserKey(message);
    const now = message.time || Math.floor(Date.now() / 1000);
    const botData = await this.loadBotData(botId, affectionConfig, now);
    const isAdmin = rules.admins.includes(message.userId);

    if (command === 'mystatus') {
      const user = botData.users[userKey] ?? createUserState(now, affectionConfig);
      const { user: decayedUser, self } = this.applyDecay(user, botData.self, now, affectionConfig);
      botData.users[userKey] = decayedUser;
      botData.self = self;
      await this.saveBotData(botId, botData);
      return [
        '南枝：现在的状态大概是这样。',
        `好感度：${decayedUser.affection.toFixed(1)}/100`,
        `对你：${getTowardsUserLabel(decayedUser)}（亲近 ${decayedUser.currentLibidoOther.toFixed(1)} / 别扭 ${decayedUser.currentAggressionOther.toFixed(1)}）`,
        `自身：${getSelfLabel(self)}（稳定 ${self.currentLibidoSelf.toFixed(1)} / 自责 ${self.currentAggressionSelf.toFixed(1)}）`
      ].join('\n');
    }

    if (!isAdmin) {
      return '南枝：这个指令要管理员才能用。';
    }

    if (command === 'reset_emotion') {
      const targetUser = args[0] || userKey;
      botData.users[targetUser] = createUserState(now, affectionConfig);
      await this.saveBotData(botId, botData);
      return `南枝：已重置 ${targetUser} 的情绪档案。`;
    }

    botData.users = {};
    botData.self = createSelfState(now, affectionConfig);
    await this.saveBotData(botId, botData);
    return '南枝：已重置全部情绪档案。';
  }

  private buildAnalysisPrompt(
    user: UserAffectionState,
    self: SelfAffectionState,
    message: BotMessage,
    contextMessages: SessionMessage[]
  ): string {
    return [
      '你是南枝这个角色的潜意识情绪调节器。根据最新消息和最近上下文，输出情绪数值变化 JSON。',
      '只分析用户对南枝的影响，不要生成聊天回复。',
      '用户表达关心、感谢、信任、认真交流：亲近上升、攻击性下降、好感微升。',
      '用户表达敷衍、冷漠、否定、命令式催促：亲近下降、攻击性上升。',
      '用户情绪低落但没有攻击南枝：亲近和陪伴欲可小幅上升。',
      '轻松玩笑：允许小幅波动，不要剧烈变化。',
      '输出 JSON 字段：libidoOtherDelta, aggressionOtherDelta, libidoSelfDelta, aggressionSelfDelta, affectionDelta, baseLibidoOtherDelta, baseAggressionOtherDelta, baseLibidoSelfDelta, baseAggressionSelfDelta, intensity。',
      '当前状态：',
      `好感 ${user.affection.toFixed(1)}/100，对他基线 ${user.baseLibidoOther.toFixed(1)}/${user.baseAggressionOther.toFixed(1)}，对他当前 ${user.currentLibidoOther.toFixed(1)}/${user.currentAggressionOther.toFixed(1)}`,
      `自身基线 ${self.baseLibidoSelf.toFixed(1)}/${self.baseAggressionSelf.toFixed(1)}，自身当前 ${self.currentLibidoSelf.toFixed(1)}/${self.currentAggressionSelf.toFixed(1)}`,
      `对话轮次：${user.turnCount}`,
      `最近上下文：\n${formatContext(contextMessages)}`,
      `用户最新消息：${message.cleanText}`,
      '增量范围：当前值 -2 到 2，好感 -0.5 到 0.5，基线 -0.2 到 0.2，intensity 0.5/1/2。只输出 JSON。'
    ].join('\n');
  }

  private applyDecay(
    user: UserAffectionState,
    self: SelfAffectionState,
    now: number,
    affectionConfig: AffectionConfig
  ): { user: UserAffectionState; self: SelfAffectionState } {
    const userElapsedHours = Math.max(0, now - user.lastUpdate) / 3600;
    const selfElapsedHours = Math.max(0, now - self.lastUpdate) / 3600;

    const nextUser = { ...user };
    nextUser.currentLibidoOther = clamp(
      user.currentLibidoOther + computeDecay(userElapsedHours, user.currentLibidoOther - user.baseLibidoOther, affectionConfig.decayDurationHours),
      0,
      50
    );
    nextUser.currentAggressionOther = clamp(
      user.currentAggressionOther + computeDecay(userElapsedHours, user.currentAggressionOther - user.baseAggressionOther, affectionConfig.decayDurationHours),
      0,
      50
    );
    nextUser.lastUpdate = now;

    const nextSelf = { ...self };
    nextSelf.currentLibidoSelf = clamp(
      self.currentLibidoSelf + computeDecay(selfElapsedHours, self.currentLibidoSelf - self.baseLibidoSelf, affectionConfig.decayDurationHours),
      0,
      50
    );
    nextSelf.currentAggressionSelf = clamp(
      self.currentAggressionSelf + computeDecay(selfElapsedHours, self.currentAggressionSelf - self.baseAggressionSelf, affectionConfig.decayDurationHours),
      0,
      50
    );
    nextSelf.lastUpdate = now;

    return { user: nextUser, self: nextSelf };
  }

  private async loadConfig(): Promise<AffectionConfig> {
    const filePath = path.join(this.dataRoot, 'config.json');
    const raw = await this.readJsonFile<Partial<AffectionConfig>>(filePath, {});
    return {
      ...DEFAULT_AFFECTION_CONFIG,
      ...raw
    };
  }

  private async loadBotData(
    botId: string,
    affectionConfig: AffectionConfig,
    now: number
  ): Promise<{ users: Record<string, UserAffectionState>; self: SelfAffectionState }> {
    const botDir = path.join(this.dataRoot, botId);
    const [users, self] = await Promise.all([
      this.readJsonFile<Record<string, UserAffectionState>>(path.join(botDir, 'users.json'), {}),
      this.readJsonFile<SelfAffectionState>(path.join(botDir, 'self.json'), createSelfState(now, affectionConfig))
    ]);

    return { users, self };
  }

  private async saveBotData(botId: string, data: { users: Record<string, UserAffectionState>; self: SelfAffectionState }): Promise<void> {
    const botDir = path.join(this.dataRoot, botId);
    await mkdir(botDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(botDir, 'users.json'), JSON.stringify(data.users, null, 2), 'utf-8'),
      writeFile(path.join(botDir, 'self.json'), JSON.stringify(data.self, null, 2), 'utf-8')
    ]);
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}
