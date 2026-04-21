import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadPersonas, loadRules, loadSessionsData, savePersonas, saveRules } from '../services/data-repository.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  getSessionCookieName,
  parseCookieValue,
  verifySessionToken
} from './auth.js';
import { loginSchema, personaRegistrySchema, ruleConfigSchema } from './validators.js';

interface JsonResponse {
  message: string;
  details?: unknown;
}

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

function sanitizeConfigSummary() {
  return {
    napcatWsUrl: config.NAPCAT_WS_URL,
    aiBaseUrl: config.AI_BASE_URL,
    aiModel: config.AI_MODEL,
    aiTimeoutMs: config.AI_TIMEOUT_MS,
    qweatherApiHost: config.QWEATHER_API_HOST,
    qweatherEnabled: Boolean(config.QWEATHER_API_KEY),
    maxContextMessages: config.MAX_CONTEXT_MESSAGES,
    dataDir: config.DATA_DIR,
    logLevel: config.LOG_LEVEL,
    adminPort: config.ADMIN_PORT,
    adminSessionTtlSeconds: config.ADMIN_SESSION_TTL_SECONDS
  };
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

export function createAdminServer(): Server {
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
        writeJson(response, 200, sanitizeConfigSummary(), origin);
        return;
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
        const sessionsData = await loadSessionsData();
        const chatKey = url.searchParams.get('chatKey');
        if (chatKey) {
          const session = sessionsData.sessions[chatKey];
          writeJson(response, 200, {
            chatKey,
            session: session ?? null
          }, origin);
          return;
        }

        const entries = Object.entries(sessionsData.sessions).map(([key, value]) => ({
          chatKey: key,
          messageCount: value.messages.length,
          handledCount: value.handledMessageIds.length,
          lastReplyAt: value.lastReplyAt ?? null,
          lastMessage: value.messages[value.messages.length - 1] ?? null
        }));

        entries.sort((a, b) => (b.lastReplyAt ?? 0) - (a.lastReplyAt ?? 0));

        writeJson(response, 200, {
          total: entries.length,
          sessions: entries
        }, origin);
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

export async function startAdminServer(): Promise<Server> {
  const server = createAdminServer();

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
