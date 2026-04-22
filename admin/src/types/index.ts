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

export interface AiEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export type PluginKind = 'ds2api' | 'qweather';

export interface PluginConfigBase {
  id: string;
  kind: PluginKind;
  name: string;
  enabled: boolean;
}

export interface Ds2ApiPluginConfig extends PluginConfigBase, AiEndpointConfig {
  kind: 'ds2api';
  triggerKeywords: string[];
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface QWeatherPluginConfig extends PluginConfigBase {
  kind: 'qweather';
  apiHost: string;
  apiKey: string;
  lang: string;
}

export type PluginConfig = Ds2ApiPluginConfig | QWeatherPluginConfig;

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  time: number;
  messageId?: string;
  userId?: string;
  senderNickname?: string;
  chatType?: 'private' | 'group';
  isAtBot?: boolean;
  reason?: string;
}

export type SessionStatus = 'available' | 'banned';

export interface SessionItemSummary {
  chatKey: string;
  chatType: 'private' | 'group';
  targetId: string;
  displayName: string;
  usesDefaultPersona: boolean;
  personaId: string;
  personaName: string;
  status: SessionStatus;
  messageCount: number;
  handledCount: number;
  lastReplyAt: number | null;
  latestActivityAt: number | null;
  lastMessage: SessionMessage | null;
}

export interface SessionsResponse {
  total: number;
  sessions: SessionItemSummary[];
}

export interface SessionDetailResponse {
  chatKey: string;
  summary: SessionItemSummary;
  session: {
    messages: SessionMessage[];
    handledMessageIds: string[];
    lastReplyAt?: number;
  } | null;
}

export interface UpdateSessionSettingsPayload {
  chatKey: string;
  personaId: string | null;
  status: SessionStatus;
}

export interface UpdateSessionSettingsResponse {
  ok: boolean;
  summary: SessionItemSummary;
}

export interface ConfigSummary {
  napcatWsUrl: string;
  aiBaseUrl: string;
  aiModel: string;
  aiTimeoutMs: number;
  pluginCount: number;
  enabledPluginCount: number;
  ds2apiEnabled: boolean;
  qweatherApiHost: string;
  qweatherEnabled: boolean;
  maxContextMessages: number;
  dataDir: string;
  logLevel: string;
  adminPort: number;
  adminSessionTtlSeconds: number;
}

export interface PluginTestResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
  details?: unknown;
}
