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

export type PluginKind = 'ds2api' | 'qweather' | 'qingmeng';

export interface PluginConfigBase {
  id: string;
  kind: PluginKind;
  name: string;
  enabled: boolean;
}

export interface Ds2ApiRouteConfig {
  id: string;
  name: string;
  enabled: boolean;
  model: string;
  intentPrompt: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface Ds2ApiPluginConfig extends PluginConfigBase {
  kind: 'ds2api';
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  routes: Ds2ApiRouteConfig[];
}

export interface QWeatherPluginConfig extends PluginConfigBase {
  kind: 'qweather';
  apiHost: string;
  apiKey: string;
  lang: string;
}

export type QingmengEndpointGroup = 'image' | 'video' | 'audio' | 'text' | 'tool' | 'analysis';

export type QingmengParameterSource = 'fixed' | 'intent' | 'image_url';

export type QingmengResponseMode = 'json_value' | 'json_list' | 'openai_text' | 'redirect_media';

export type QingmengDisplayMode = 'none' | 'fixed';

export interface QingmengEndpointParameter {
  id: string;
  name: string;
  label: string;
  description: string;
  source: QingmengParameterSource;
  required: boolean;
  defaultValue: string;
}

export interface QingmengEndpointConfig {
  id: string;
  name: string;
  enabled: boolean;
  group: QingmengEndpointGroup;
  description: string;
  intentAliases: string[];
  fallbackEligible: boolean;
  method: 'GET';
  url: string;
  intentPrompt: string;
  parameters: QingmengEndpointParameter[];
  responseMode: QingmengResponseMode;
  responsePath?: string;
  listPath?: string;
  itemTitlePath?: string;
  itemUrlPath?: string;
  displayMode?: QingmengDisplayMode;
  displayText?: string;
  captionTemplate?: string;
  sampleInput: string;
  sampleImageUrl?: string;
}

export interface QingmengPluginConfig extends PluginConfigBase {
  kind: 'qingmeng';
  ckey: string;
  classifierPrompt: string;
  endpoints: QingmengEndpointConfig[];
}

export type PluginConfig = Ds2ApiPluginConfig | QWeatherPluginConfig | QingmengPluginConfig;

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  time: number;
  messageId?: string;
  userId?: string;
  senderNickname?: string;
  groupName?: string;
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

export interface ScheduledTaskTarget {
  chatType: 'group' | 'private';
  targetId: string;
  displayName: string;
}

export type ScheduledTaskRunStatus = 'success' | 'partial' | 'failed';

export interface ScheduledTaskExecutionTargetResult {
  chatType: 'group' | 'private';
  targetId: string;
  displayName: string;
  ok: boolean;
  error?: string;
}

export interface ScheduledTaskExecutionLog {
  id: string;
  scheduledFor: string;
  executedAt: number;
  status: ScheduledTaskRunStatus;
  message: string;
  results: ScheduledTaskExecutionTargetResult[];
}

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  jitterSeconds: number;
  messageTemplate: string;
  pluginId?: PluginKind | '';
  pluginPayload?: Record<string, unknown>;
  targets: ScheduledTaskTarget[];
  lastRunAt?: number;
  lastRunScheduledFor?: string;
  lastRunStatus?: ScheduledTaskRunStatus;
  lastRunMessage?: string;
  logs: ScheduledTaskExecutionLog[];
}

export interface TaskTargetOption {
  chatKey: string;
  chatType: 'group' | 'private';
  targetId: string;
  displayName: string;
  status: SessionStatus;
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

export interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
}

export interface ConfigSummary {
  napcatWsUrl: string;
  aiBaseUrl: string;
  aiModel: string;
  aiTimeoutMs: number;
  pluginCount: number;
  enabledPluginCount: number;
  ds2apiEnabled: boolean;
  ds2apiRouteCount: number;
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

export interface PluginTestPayload {
  input?: string;
  endpointId?: string;
  routeId?: string;
  imageUrl?: string;
}
