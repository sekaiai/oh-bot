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

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  time: number;
  reason?: string;
}

export interface SessionItemSummary {
  chatKey: string;
  messageCount: number;
  handledCount: number;
  lastReplyAt: number | null;
  lastMessage: SessionMessage | null;
}

export interface SessionsResponse {
  total: number;
  sessions: SessionItemSummary[];
}

export interface SessionDetailResponse {
  chatKey: string;
  session: {
    messages: SessionMessage[];
    handledMessageIds: string[];
    lastReplyAt?: number;
  } | null;
}

export interface ConfigSummary {
  napcatWsUrl: string;
  aiBaseUrl: string;
  aiModel: string;
  aiTimeoutMs: number;
  qweatherApiHost: string;
  qweatherEnabled: boolean;
  maxContextMessages: number;
  dataDir: string;
  logLevel: string;
  adminPort: number;
  adminSessionTtlSeconds: number;
}
