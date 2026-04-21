export type ChatType = 'private' | 'group';

export interface BotMessage {
  messageId: string;
  userId: string;
  groupId?: string;
  chatType: ChatType;
  rawText: string;
  cleanText: string;
  isAtBot: boolean;
  selfId: string;
  senderNickname?: string;
  time: number;
  rawEvent: unknown;
}

export interface SendMessageParams {
  chatType: ChatType;
  userId?: string;
  groupId?: string;
  message: string;
}

export type SessionRole = 'system' | 'user' | 'assistant';

export interface SessionMessage {
  role: SessionRole;
  content: string;
  time: number;
}

export interface PersonaConfig {
  id: string;
  name: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface RuleConfig {
  admins: string[];
  whitelistGroups: string[];
  blacklistUsers: string[];
  requireAtInGroup: boolean;
  aiEnabled: boolean;
  commandPrefix: string;
  cooldownSeconds: number;
}
