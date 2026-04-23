import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  loadPersonas,
  loadPluginConfig,
  loadPluginConfigs,
  loadRules,
  loadScheduledTasks,
  loadSessionsData,
  savePersonas,
  savePluginConfig,
  saveRules,
  saveScheduledTasks,
} from '../services/data-repository.js';
import { config } from '../config/index.js';
import type {
  ChatSession,
  Ds2ApiPluginConfig,
  PersonaRegistry,
  PluginConfig,
  PluginKind,
  QingmengPluginConfig,
  QWeatherPluginConfig,
  RuleConfig,
  SessionMessage
} from '../types/bot.js';
import { logger } from '../utils/logger.js';
import { AiClient } from '../services/ai-client.js';
import { QingmengClient } from '../services/qingmeng-client.js';
import { QWeatherClient } from '../services/qweather-client.js';
import type { NapcatSender } from '../adapters/napcat/sender.js';
import { executeScheduledTask, persistTaskExecution } from '../services/task-center.js';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  getSessionCookieName,
  parseCookieValue,
  verifySessionToken
} from './auth.js';
import {
  loginSchema,
  personaRegistrySchema,
  pluginConfigSchema,
  pluginTestSchema,
  ruleConfigSchema,
  scheduledTasksSchema,
  sessionSettingsSchema
} from './validators.js';

interface JsonResponse {
  message: string;
  details?: unknown;
}

interface PluginTestResponse {
  ok: boolean;
  message: string;
  elapsedMs: number;
  details?: unknown;
}

type SessionStatus = 'available' | 'banned';

interface SessionSummaryItem {
  chatKey: string;
  chatType: 'group' | 'private';
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

interface ParsedChatKey {
  chatType: 'group' | 'private';
  targetId: string;
}

interface TaskTargetOption {
  chatKey: string;
  chatType: 'group' | 'private';
  targetId: string;
  displayName: string;
  status: SessionStatus;
  source: 'session' | 'napcat';
}

interface NapcatSearchCache {
  friends: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  updatedAt: number;
}

const NAPCAT_TARGET_CACHE_TTL_MS = 60 * 1000;

function writeJson(response: ServerResponse, statusCode: number, payload: unknown, origin?: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  response.end(JSON.stringify(payload));
}

function getRequestOrigin(request: IncomingMessage): string | undefined {
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) {
    return undefined;
  }

  return requestOrigin === config.ADMIN_WEB_ORIGIN ? requestOrigin : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw);
}

function isAuthorized(request: IncomingMessage): boolean {
  const token = parseCookieValue(request.headers.cookie, getSessionCookieName());
  const nowSeconds = Math.floor(Date.now() / 1000);
  return verifySessionToken(token, nowSeconds);
}

function toError(message: string, details?: unknown): JsonResponse {
  return { message, details };
}

function sanitizeConfigSummary(plugins: PluginConfig[]) {
  const qweatherPlugin = plugins.find((item) => item.kind === 'qweather');
  const ds2apiPlugin = plugins.find((item) => item.kind === 'ds2api');

  return {
    napcatWsUrl: config.NAPCAT_WS_URL,
    aiBaseUrl: config.AI_BASE_URL,
    aiModel: config.AI_MODEL,
    aiTimeoutMs: config.AI_TIMEOUT_MS,
    pluginCount: plugins.length,
    enabledPluginCount: plugins.filter((item) => item.enabled).length,
    ds2apiEnabled: Boolean(ds2apiPlugin?.enabled),
    ds2apiRouteCount: ds2apiPlugin?.kind === 'ds2api' ? ds2apiPlugin.routes.length : 0,
    qweatherApiHost: qweatherPlugin?.kind === 'qweather' ? qweatherPlugin.apiHost : config.QWEATHER_API_HOST,
    qweatherEnabled: Boolean(qweatherPlugin?.kind === 'qweather' && qweatherPlugin.enabled && qweatherPlugin.apiKey),
    maxContextMessages: config.MAX_CONTEXT_MESSAGES,
    dataDir: config.DATA_DIR,
    logLevel: config.LOG_LEVEL,
    adminPort: config.ADMIN_PORT,
    adminSessionTtlSeconds: config.ADMIN_SESSION_TTL_SECONDS
  };
}

function isPluginKind(value: string): value is PluginKind {
  return value === 'ds2api' || value === 'qweather' || value === 'qingmeng';
}

async function testDs2ApiPlugin(plugin: Ds2ApiPluginConfig, input: string, routeId?: string): Promise<PluginTestResponse> {
  const startTime = Date.now();
  const aiClient = new AiClient();
  const route = plugin.routes.find((item) => item.id === routeId) ?? plugin.routes.find((item) => item.enabled) ?? plugin.routes[0];
  if (!route) {
    throw new Error('DS2API 还没有可用路由');
  }

  const prompt = input.trim() || '这是一条接口测试消息，请只回复“DS2API 测试成功”。';
  const result = await aiClient.testChatCompletion(
    {
      baseUrl: plugin.baseUrl,
      apiKey: plugin.apiKey,
      model: route.model,
      timeoutMs: plugin.timeoutMs
    },
    `${route.systemPrompt ? `${route.systemPrompt}\n\n` : ''}${prompt}`
  );

  return {
    ok: true,
    message: 'DS2API 接口调用成功',
    elapsedMs: Date.now() - startTime,
    details: {
      routeId: route.id,
      routeName: route.name,
      model: route.model,
      endpoint: plugin.baseUrl,
      prompt,
      replyPreview: result.reply.slice(0, 400),
      raw: result.raw
    }
  };
}

async function testQWeatherPlugin(plugin: QWeatherPluginConfig, input: string): Promise<PluginTestResponse> {
  const startTime = Date.now();
  const client = new QWeatherClient(plugin);
  const location = input.trim() || '北京';
  const result = await client.probeLocation(location);

  return {
    ok: Boolean(result.selectedLocation),
    message: result.selectedLocation ? '和风天气接口调用成功' : '接口可达，但未找到测试城市',
    elapsedMs: Date.now() - startTime,
    details: {
      requestLocation: location,
      selectedLocation: result.selectedLocation,
      lookup: result.lookup,
      weatherNow: result.weatherNow
    }
  };
}

async function testQingmengPlugin(
  plugin: QingmengPluginConfig,
  endpointId: string | undefined,
  input: string,
  imageUrl: string
): Promise<PluginTestResponse> {
  const startTime = Date.now();
  const endpoint = plugin.endpoints.find((item) => item.id === endpointId);
  if (!endpoint) {
    throw new Error('未找到要测试的倾梦接口');
  }

  const client = new QingmengClient(plugin);
  const params = client.buildRequestParams(endpoint, {}, [], input.trim() || endpoint.sampleInput, imageUrl.trim() || endpoint.sampleImageUrl || '');
  const result = await client.executeEndpoint(endpoint, params);

  return {
    ok: true,
    message: `倾梦接口「${endpoint.name}」调用成功`,
    elapsedMs: Date.now() - startTime,
    details: {
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      params,
      replySummary: result.replySummary,
      outboundMessage: result.outboundMessage,
      diagnostics: result.diagnostics
    }
  };
}

async function runPluginTest(
  plugin: PluginConfig,
  input: string,
  endpointId?: string,
  routeId?: string,
  imageUrl = ''
): Promise<PluginTestResponse> {
  if (plugin.kind === 'ds2api') {
    return testDs2ApiPlugin(plugin, input, routeId);
  }

  if (plugin.kind === 'qingmeng') {
    return testQingmengPlugin(plugin, endpointId, input, imageUrl);
  }

  return testQWeatherPlugin(plugin, input);
}

function parseChatKey(chatKey: string): ParsedChatKey | null {
  if (chatKey.startsWith('group:')) {
    return {
      chatType: 'group',
      targetId: chatKey.slice('group:'.length)
    };
  }

  if (chatKey.startsWith('private:')) {
    return {
      chatType: 'private',
      targetId: chatKey.slice('private:'.length)
    };
  }

  return null;
}

function getLatestActivityAt(session: ChatSession): number | null {
  const lastMessage = session.messages[session.messages.length - 1];
  const latestValue = Math.max(lastMessage?.time ?? 0, session.lastReplyAt ?? 0);
  return latestValue > 0 ? latestValue : null;
}

function resolvePrivateDisplayName(session: ChatSession, fallbackId: string): string {
  const latestUserMessage = [...session.messages]
    .reverse()
    .find((message) => message.role === 'user' && (message.senderNickname || message.userId));

  return latestUserMessage?.senderNickname?.trim() || latestUserMessage?.userId || fallbackId;
}

function resolveGroupDisplayName(session: ChatSession, fallbackId: string): string {
  const latestGroupMessage = [...session.messages]
    .reverse()
    .find((message) => message.chatType === 'group' && message.groupName?.trim());

  return latestGroupMessage?.groupName?.trim() || `群聊 ${fallbackId}`;
}

function resolveDisplayName(parsedChatKey: ParsedChatKey, session: ChatSession): string {
  if (parsedChatKey.chatType === 'group') {
    return resolveGroupDisplayName(session, parsedChatKey.targetId);
  }

  return resolvePrivateDisplayName(session, parsedChatKey.targetId);
}

function resolveSessionStatus(parsedChatKey: ParsedChatKey, rules: RuleConfig): SessionStatus {
  if (parsedChatKey.chatType === 'group') {
    return rules.groupBlacklist.includes(parsedChatKey.targetId) ? 'banned' : 'available';
  }

  return rules.privateBlacklist.includes(parsedChatKey.targetId) ? 'banned' : 'available';
}

function buildSessionSummary(
  chatKey: string,
  session: ChatSession,
  personas: PersonaRegistry,
  rules: RuleConfig
): SessionSummaryItem | null {
  const parsedChatKey = parseChatKey(chatKey);
  if (!parsedChatKey) {
    return null;
  }

  const usesDefaultPersona = !personas.bindings[chatKey];
  const personaId = personas.bindings[chatKey] ?? personas.defaultPersonaId;
  const persona = personas.personas.find((item) => item.id === personaId);
  const lastMessage = session.messages[session.messages.length - 1] ?? null;

  return {
    chatKey,
    chatType: parsedChatKey.chatType,
    targetId: parsedChatKey.targetId,
    displayName: resolveDisplayName(parsedChatKey, session),
    usesDefaultPersona,
    personaId,
    personaName: persona?.name ?? personaId,
    status: resolveSessionStatus(parsedChatKey, rules),
    messageCount: session.messages.length,
    handledCount: session.handledMessageIds.length,
    lastReplyAt: session.lastReplyAt ?? null,
    latestActivityAt: getLatestActivityAt(session),
    lastMessage
  };
}

function createEmptySession(): ChatSession {
  return {
    messages: [],
    handledMessageIds: []
  };
}

function updateBlacklist(list: string[], targetId: string, shouldInclude: boolean): string[] {
  if (shouldInclude) {
    if (list.includes(targetId)) {
      return list;
    }

    return [...list, targetId];
  }

  return list.filter((item) => item !== targetId);
}

async function loadAdminSessionContext() {
  const [sessionsData, rules, personas] = await Promise.all([loadSessionsData(), loadRules(), loadPersonas()]);
  return { sessionsData, rules, personas };
}

function buildSessionList(
  sessions: Record<string, ChatSession>,
  personas: PersonaRegistry,
  rules: RuleConfig
): SessionSummaryItem[] {
  return Object.entries(sessions)
    .map(([chatKey, session]) => buildSessionSummary(chatKey, session, personas, rules))
    .filter((item): item is SessionSummaryItem => Boolean(item))
    .sort((a, b) => (b.latestActivityAt ?? 0) - (a.latestActivityAt ?? 0));
}

function buildTaskTargetOptions(
  sessions: Record<string, ChatSession>,
  personas: PersonaRegistry,
  rules: RuleConfig
): TaskTargetOption[] {
  return buildSessionList(sessions, personas, rules).map((item) => ({
    chatKey: item.chatKey,
    chatType: item.chatType,
    targetId: item.targetId,
    displayName: item.displayName,
    status: item.status,
    source: 'session'
  }));
}

function normalizeNapcatFriendTarget(raw: Record<string, unknown>): TaskTargetOption | null {
  const targetId = String(raw.user_id ?? raw.userId ?? raw.uin ?? raw.uid ?? '').trim();
  if (!targetId) {
    return null;
  }

  const displayName = String(raw.remark ?? raw.nickname ?? raw.nick ?? targetId).trim() || targetId;
  return {
    chatKey: `private:${targetId}`,
    chatType: 'private',
    targetId,
    displayName,
    status: 'available',
    source: 'napcat'
  };
}

function normalizeNapcatGroupTarget(raw: Record<string, unknown>): TaskTargetOption | null {
  const targetId = String(raw.group_id ?? raw.groupId ?? '').trim();
  if (!targetId) {
    return null;
  }

  const displayName = String(raw.group_name ?? raw.groupName ?? raw.group_remark ?? raw.groupRemark ?? `群聊 ${targetId}`).trim();
  return {
    chatKey: `group:${targetId}`,
    chatType: 'group',
    targetId,
    displayName: displayName || `群聊 ${targetId}`,
    status: 'available',
    source: 'napcat'
  };
}

function filterTaskTargets(targets: TaskTargetOption[], keyword: string, type: 'all' | 'group' | 'private', limit: number): TaskTargetOption[] {
  const normalizedKeyword = keyword.trim().toLowerCase();

  return targets
    .filter((target) => {
      if (type !== 'all' && target.chatType !== type) {
        return false;
      }

      if (!normalizedKeyword) {
        return true;
      }

      return `${target.displayName} ${target.targetId} ${target.chatKey}`.toLowerCase().includes(normalizedKeyword);
    })
    .slice(0, limit);
}

async function loadNapcatSearchCache(sender: NapcatSender, cache: NapcatSearchCache): Promise<NapcatSearchCache> {
  const now = Date.now();
  if (cache.updatedAt > 0 && now - cache.updatedAt < NAPCAT_TARGET_CACHE_TTL_MS) {
    return cache;
  }

  const [friends, groups] = await Promise.all([
    sender.getFriendList(),
    sender.getGroupList()
  ]);

  cache.friends = friends.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  cache.groups = groups.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  cache.updatedAt = now;
  return cache;
}

function allowCorsPreflight(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = getRequestOrigin(request);
  if (request.method !== 'OPTIONS') {
    return false;
  }

  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
  }

  response.statusCode = 204;
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.end();
  return true;
}

export function createAdminServer(sender: NapcatSender | null): Server {
  const napcatSearchCache: NapcatSearchCache = {
    friends: [],
    groups: [],
    updatedAt: 0
  };

  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;
    const origin = getRequestOrigin(request);

    if (allowCorsPreflight(request, response)) {
      return;
    }

    try {
      if (pathname === '/admin/login' && method === 'POST') {
        const body = await readJsonBody(request);
        const parsed = loginSchema.safeParse(body);
        if (!parsed.success) {
          writeJson(response, 400, toError('请求参数不合法', parsed.error.flatten()), origin);
          return;
        }

        if (parsed.data.password !== config.ADMIN_PASSWORD) {
          writeJson(response, 401, toError('密码错误'), origin);
          return;
        }

        const nowSeconds = Math.floor(Date.now() / 1000);
        const token = createSessionToken(nowSeconds);
        response.setHeader('Set-Cookie', buildSessionCookie(token));
        writeJson(response, 200, { ok: true }, origin);
        return;
      }

      if (pathname === '/admin/logout' && method === 'POST') {
        response.setHeader('Set-Cookie', buildClearSessionCookie());
        writeJson(response, 200, { ok: true }, origin);
        return;
      }

      if (!isAuthorized(request)) {
        writeJson(response, 401, toError('未登录或登录已过期'), origin);
        return;
      }

      if (pathname === '/admin/config-summary' && method === 'GET') {
        const plugins = await loadPluginConfigs();
        writeJson(response, 200, sanitizeConfigSummary(plugins), origin);
        return;
      }

      if (pathname === '/admin/task-targets' && method === 'GET') {
        const { sessionsData, rules, personas } = await loadAdminSessionContext();
        writeJson(response, 200, buildTaskTargetOptions(sessionsData.sessions, personas, rules), origin);
        return;
      }

      if (pathname === '/admin/napcat-targets' && method === 'GET') {
        if (!sender) {
          writeJson(response, 503, toError('当前发送通道不可用，无法拉取 NapCat 目标列表'), origin);
          return;
        }

        const keyword = String(url.searchParams.get('keyword') ?? '').trim();
        const typeParam = String(url.searchParams.get('type') ?? 'all');
        const type = typeParam === 'group' || typeParam === 'private' ? typeParam : 'all';
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '40') || 40));
        const forceRefresh = url.searchParams.get('refresh') === '1';
        if (forceRefresh) {
          napcatSearchCache.updatedAt = 0;
        }

        const cache = await loadNapcatSearchCache(sender, napcatSearchCache);
        const targets = [
          ...cache.friends.map(normalizeNapcatFriendTarget).filter((item): item is TaskTargetOption => Boolean(item)),
          ...cache.groups.map(normalizeNapcatGroupTarget).filter((item): item is TaskTargetOption => Boolean(item))
        ];

        writeJson(
          response,
          200,
          {
            targets: filterTaskTargets(targets, keyword, type, limit)
          },
          origin
        );
        return;
      }

      if (pathname === '/admin/tasks') {
        if (method === 'GET') {
          const tasks = await loadScheduledTasks();
          writeJson(response, 200, { tasks }, origin);
          return;
        }

        if (method === 'PUT') {
          const body = await readJsonBody(request);
          const parsed = scheduledTasksSchema.safeParse(body);
          if (!parsed.success) {
            writeJson(response, 400, toError('任务配置不合法', parsed.error.flatten()), origin);
            return;
          }

          await saveScheduledTasks(parsed.data.tasks);
          writeJson(response, 200, { ok: true }, origin);
          return;
        }
      }

      if (pathname.startsWith('/admin/tasks/') && pathname.endsWith('/run') && method === 'POST') {
        if (!sender) {
          writeJson(response, 503, toError('当前发送通道不可用，无法执行任务'), origin);
          return;
        }

        const taskId = pathname.slice('/admin/tasks/'.length, -'/run'.length);
        const tasks = await loadScheduledTasks();
        const task = tasks.find((item) => item.id === taskId);
        if (!task) {
          writeJson(response, 404, toError('任务不存在'), origin);
          return;
        }

        const log = await executeScheduledTask(task, sender);
        const nextLog = {
          ...log,
          scheduledFor: `manual:${new Date().toISOString()}`
        };
        await persistTaskExecution(task.id, nextLog, nextLog.scheduledFor);
        writeJson(response, 200, nextLog, origin);
        return;
      }

      if (pathname === '/admin/plugins' && method === 'GET') {
        const plugins = await loadPluginConfigs();
        writeJson(response, 200, plugins, origin);
        return;
      }

      if (pathname.startsWith('/admin/plugins/')) {
        const pluginSubPath = pathname.slice('/admin/plugins/'.length);
        const [pluginId, action] = pluginSubPath.split('/');
        if (!isPluginKind(pluginId)) {
          writeJson(response, 404, toError('插件不存在'), origin);
          return;
        }

        if (action === 'test' && method === 'POST') {
          const body = await readJsonBody(request);
          const parsed = pluginTestSchema.safeParse(body);
          if (!parsed.success) {
            writeJson(response, 400, toError('测试参数不合法', parsed.error.flatten()), origin);
            return;
          }

          if (parsed.data.plugin.id !== pluginId || parsed.data.plugin.kind !== pluginId) {
            writeJson(response, 400, toError('插件 ID 与请求路径不一致'), origin);
            return;
          }

          const result = await runPluginTest(
            parsed.data.plugin,
            parsed.data.input,
            parsed.data.endpointId,
            parsed.data.routeId,
            parsed.data.imageUrl ?? ''
          );
          writeJson(response, 200, result, origin);
          return;
        }

        if (!action && method === 'GET') {
          const plugin = await loadPluginConfig(pluginId);
          writeJson(response, 200, plugin, origin);
          return;
        }

        if (!action && method === 'PUT') {
          const body = await readJsonBody(request);
          const parsed = pluginConfigSchema.safeParse(body);
          if (!parsed.success) {
            writeJson(response, 400, toError('插件配置不合法', parsed.error.flatten()), origin);
            return;
          }

          if (parsed.data.id !== pluginId || parsed.data.kind !== pluginId) {
            writeJson(response, 400, toError('插件 ID 与请求路径不一致'), origin);
            return;
          }

          await savePluginConfig(parsed.data);
          writeJson(response, 200, { ok: true }, origin);
          return;
        }
      }

      if (pathname === '/admin/rules') {
        if (method === 'GET') {
          const rules = await loadRules();
          writeJson(response, 200, rules, origin);
          return;
        }

        if (method === 'PUT') {
          const body = await readJsonBody(request);
          const parsed = ruleConfigSchema.safeParse(body);
          if (!parsed.success) {
            writeJson(response, 400, toError('规则配置不合法', parsed.error.flatten()), origin);
            return;
          }

          await saveRules(parsed.data);
          writeJson(response, 200, { ok: true }, origin);
          return;
        }
      }

      if (pathname === '/admin/personas') {
        if (method === 'GET') {
          const personas = await loadPersonas();
          writeJson(response, 200, personas, origin);
          return;
        }

        if (method === 'PUT') {
          const body = await readJsonBody(request);
          const parsed = personaRegistrySchema.safeParse(body);
          if (!parsed.success) {
            writeJson(response, 400, toError('人设配置不合法', parsed.error.flatten()), origin);
            return;
          }

          await savePersonas(parsed.data);
          writeJson(response, 200, { ok: true }, origin);
          return;
        }
      }

      if (pathname === '/admin/sessions' && method === 'GET') {
        const { sessionsData, rules, personas } = await loadAdminSessionContext();
        const chatKey = url.searchParams.get('chatKey');
        if (chatKey) {
          const session = sessionsData.sessions[chatKey] ?? null;
          const summary = buildSessionSummary(chatKey, session ?? createEmptySession(), personas, rules);
          if (!summary) {
            writeJson(response, 400, toError('chatKey 不合法'), origin);
            return;
          }

          writeJson(response, 200, {
            chatKey,
            summary,
            session: session ?? null
          }, origin);
          return;
        }

        const entries = buildSessionList(sessionsData.sessions, personas, rules);

        writeJson(response, 200, {
          total: entries.length,
          sessions: entries
        }, origin);
        return;
      }

      if (pathname === '/admin/sessions/settings' && method === 'PUT') {
        const body = await readJsonBody(request);
        const parsed = sessionSettingsSchema.safeParse(body);
        if (!parsed.success) {
          writeJson(response, 400, toError('会话设置参数不合法', parsed.error.flatten()), origin);
          return;
        }

        const { sessionsData, rules, personas } = await loadAdminSessionContext();
        const chatKey = parsed.data.chatKey;
        const parsedChatKey = parseChatKey(chatKey);
        if (!parsedChatKey) {
          writeJson(response, 400, toError('chatKey 不合法'), origin);
          return;
        }

        if (parsed.data.personaId && !personas.personas.some((item) => item.id === parsed.data.personaId)) {
          writeJson(response, 400, toError('目标人格不存在'), origin);
          return;
        }

        const nextBindings = { ...personas.bindings };
        if (!parsed.data.personaId || parsed.data.personaId === personas.defaultPersonaId) {
          delete nextBindings[chatKey];
        } else {
          nextBindings[chatKey] = parsed.data.personaId;
        }

        const isBanned = parsed.data.status === 'banned';
        if (parsedChatKey.chatType === 'group') {
          rules.groupBlacklist = updateBlacklist(rules.groupBlacklist, parsedChatKey.targetId, isBanned);
        } else {
          rules.privateBlacklist = updateBlacklist(rules.privateBlacklist, parsedChatKey.targetId, isBanned);
          rules.blacklistUsers = [...rules.privateBlacklist];
        }

        personas.bindings = nextBindings;

        await Promise.all([saveRules(rules), savePersonas(personas)]);

        const session = sessionsData.sessions[chatKey] ?? createEmptySession();
        const summary = buildSessionSummary(chatKey, session, personas, rules);
        if (!summary) {
          writeJson(response, 400, toError('chatKey 不合法'), origin);
          return;
        }

        writeJson(response, 200, { ok: true, summary }, origin);
        return;
      }

      writeJson(response, 404, toError('接口不存在'), origin);
    } catch (error) {
      logger.error({ err: error, method, pathname }, 'Admin API request failed');
      writeJson(response, 500, toError('服务器内部错误'), origin);
    }
  });

  return server;
}

export async function startAdminServer(sender: NapcatSender | null): Promise<Server | null> {
  if (!config.ADMIN_PASSWORD) {
    logger.warn('Admin server disabled because ADMIN_PASSWORD is not configured');
    return null;
  }

  const server = createAdminServer(sender);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.ADMIN_PORT, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info({ port: config.ADMIN_PORT, origin: config.ADMIN_WEB_ORIGIN }, 'Admin server started');
  return server;
}
