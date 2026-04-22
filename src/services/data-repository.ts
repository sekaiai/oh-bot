/**
 * 数据仓储层。
 *
 * 该模块负责把 `data/` 目录中的 JSON 文件统一读取为内存结构，
 * 避免业务层到处散落文件路径和默认值逻辑。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import type {
  Ds2ApiPluginConfig,
  PersonaRegistry,
  PluginConfig,
  PluginKind,
  QWeatherPluginConfig,
  RuleConfig,
  SessionsData
} from '../types/bot.js';

const dataDir = path.resolve(process.cwd(), config.DATA_DIR);
const rulesPath = path.join(dataDir, 'rules.json');
const personasPath = path.join(dataDir, 'personas.json');
const sessionsPath = path.join(dataDir, 'sessions.json');
const runtimeSettingsPath = path.join(dataDir, 'runtime-settings.json');
const pluginsDir = path.join(dataDir, 'plugins');

/**
 * 读取 JSON 文件并在失败时回退到给定默认值。
 *
 * 这里故意把“文件不存在”和“JSON 解析失败”都视为同一种降级场景，
 * 原因是当前项目仍以本地开发为主，保证可启动比区分错误细节更重要。
 * 如果以后需要更严格的数据治理，再在这一层拆分错误类型即可。
 */
async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await ensureDataDir();
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * 确保数据目录存在。
 *
 * 写入会话状态前统一调用，避免由各个写入点分别判断目录。
 */
export async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
}

/**
 * 读取运行规则。
 *
 * 这里会兼容旧字段 `blacklistUsers`，并把它回填到 `privateBlacklist`，
 * 这样老数据文件不需要一次性迁移也能继续工作。
 */
export async function loadRules(): Promise<RuleConfig> {
  const raw = await readJsonFile<Partial<RuleConfig>>(rulesPath, {});
  return {
    admins: raw.admins ?? [],
    whitelistGroups: raw.whitelistGroups ?? [],
    blacklistUsers: raw.blacklistUsers ?? [],
    privateBlacklist: raw.privateBlacklist ?? raw.blacklistUsers ?? [],
    groupBlacklist: raw.groupBlacklist ?? [],
    botNames: raw.botNames ?? ['oh-bot'],
    requireAtInGroup: raw.requireAtInGroup ?? true,
    aiEnabled: raw.aiEnabled ?? true,
    commandPrefix: raw.commandPrefix ?? '/',
    cooldownSeconds: raw.cooldownSeconds ?? 3
  };
}

export async function saveRules(rules: RuleConfig): Promise<void> {
  await writeJsonFile(rulesPath, rules);
}

/**
 * 读取 persona 配置。
 *
 * 即使 `personas.json` 不存在，也保证返回一套最小可用的默认 persona，
 * 避免回复链路因为缺配置而整体不可用。
 */
export async function loadPersonas(): Promise<PersonaRegistry> {
  return readJsonFile<PersonaRegistry>(personasPath, {
    defaultPersonaId: 'assistant',
    personas: [
      {
        id: 'assistant',
        name: 'Assistant',
        systemPrompt: '你是一个可靠、简洁、友好的 QQ 助手。',
        temperature: 0.7,
        maxTokens: 512
      }
    ],
    bindings: {}
  });
}

export async function savePersonas(personas: PersonaRegistry): Promise<void> {
  await writeJsonFile(personasPath, personas);
}

function getPluginFilePath(id: string): string {
  return path.join(pluginsDir, `${id}.json`);
}

function getDefaultDs2ApiPlugin(): Ds2ApiPluginConfig {
  return {
    id: 'ds2api',
    kind: 'ds2api',
    name: 'DS2API',
    enabled: false,
    baseUrl: 'http://127.0.0.1:6011/v1',
    apiKey: '',
    model: 'gpt-4o',
    timeoutMs: config.AI_TIMEOUT_MS,
    triggerKeywords: [],
    systemPrompt: '你是一个专注于深度推理和复杂问题处理的 QQ 助手。',
    temperature: 0.3,
    maxTokens: 1024
  };
}

function getDefaultQWeatherPlugin(): QWeatherPluginConfig {
  return {
    id: 'qweather',
    kind: 'qweather',
    name: '和风天气',
    enabled: true,
    apiHost: config.QWEATHER_API_HOST,
    apiKey: config.QWEATHER_API_KEY,
    lang: config.QWEATHER_LANG
  };
}

type LegacyRuntimeSettings = {
  routedAis?: Array<Partial<Ds2ApiPluginConfig>>;
  qweather?: Partial<QWeatherPluginConfig>;
};

async function loadLegacyRuntimeSettings(): Promise<LegacyRuntimeSettings | null> {
  return readJsonFile<LegacyRuntimeSettings | null>(runtimeSettingsPath, null);
}

async function loadDefaultPluginConfig(kind: PluginKind): Promise<PluginConfig> {
  const legacy = await loadLegacyRuntimeSettings();

  if (kind === 'ds2api') {
    const fallback = getDefaultDs2ApiPlugin();
    const legacyDs2Api = legacy?.routedAis?.find((item) => item.id === 'ds2api') ?? legacy?.routedAis?.[0];
    return {
      ...fallback,
      ...legacyDs2Api,
      id: 'ds2api',
      kind: 'ds2api',
      name: legacyDs2Api?.name || fallback.name
    };
  }

  const fallback = getDefaultQWeatherPlugin();
  return {
    ...fallback,
    ...legacy?.qweather,
    id: 'qweather',
    kind: 'qweather',
    name: fallback.name
  };
}

export async function loadPluginConfig(kind: PluginKind): Promise<PluginConfig> {
  const fallback = await loadDefaultPluginConfig(kind);
  return readJsonFile<PluginConfig>(getPluginFilePath(kind), fallback);
}

export async function loadPluginConfigs(): Promise<PluginConfig[]> {
  const defaults = await Promise.all([loadPluginConfig('ds2api'), loadPluginConfig('qweather')]);

  try {
    const existingFiles = await readdir(pluginsDir);
    const extraPluginFiles = existingFiles.filter((file) => file.endsWith('.json') && !['ds2api.json', 'qweather.json'].includes(file));
    const extras = await Promise.all(
      extraPluginFiles.map((file) => readJsonFile<PluginConfig | null>(path.join(pluginsDir, file), null))
    );

    return [...defaults, ...extras.filter((item): item is PluginConfig => Boolean(item))];
  } catch {
    return defaults;
  }
}

export async function savePluginConfig(plugin: PluginConfig): Promise<void> {
  await writeJsonFile(getPluginFilePath(plugin.id), plugin);
}

/**
 * 读取所有会话状态。
 */
export async function loadSessionsData(): Promise<SessionsData> {
  return readJsonFile<SessionsData>(sessionsPath, {
    sessions: {}
  });
}

/** 会话状态文件路径，供 store 层统一写回。 */
export { sessionsPath, rulesPath, personasPath, runtimeSettingsPath, pluginsDir };
