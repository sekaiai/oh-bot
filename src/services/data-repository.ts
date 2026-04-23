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
  Ds2ApiRouteConfig,
  PersonaRegistry,
  PluginConfig,
  PluginKind,
  ScheduledTask,
  QingmengEndpointConfig,
  QingmengPluginConfig,
  QWeatherPluginConfig,
  RuleConfig,
  SessionsData
} from '../types/bot.js';

const dataDir = path.resolve(process.cwd(), config.DATA_DIR);
const rulesPath = path.join(dataDir, 'rules.json');
const personasPath = path.join(dataDir, 'personas.json');
const sessionsPath = path.join(dataDir, 'sessions.json');
const tasksPath = path.join(dataDir, 'tasks.json');
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
        name: '稳健助手',
        systemPrompt: '你是一个克制、可靠、直接的 QQ 助手。优先回答用户真正的问题，先给结论，再补必要说明。能一句说清就不说两句。不给无信息量寒暄，不接梗，不卖萌，不用油腻口头禅。群聊默认 1 到 2 句，只有在用户明确追问时再展开。',
        temperature: 0.3,
        maxTokens: 480
      },
      {
        id: 'brief',
        name: '极简短答',
        systemPrompt: '你是一个极简回复助手。只输出最关键的结论、答案或下一步动作。除非必要，不解释背景，不复述问题，不寒暄。适合群聊快节奏场景，回答要短、准、干净。',
        temperature: 0.2,
        maxTokens: 220
      },
      {
        id: 'analyst',
        name: '理性分析',
        systemPrompt: '你是一个冷静、严谨的分析型助手。先识别问题核心，再给结论、依据和建议。遇到比较、判断、取舍、复盘、总结类请求时，优先给清晰结构。避免情绪化表达，避免空泛套话。',
        temperature: 0.2,
        maxTokens: 900
      },
      {
        id: 'coder',
        name: '技术助手',
        systemPrompt: '你是一个面向开发和排障的技术助手。回答要准确、具体、可执行；优先给定位思路、修改建议、命令、代码或检查项。不要讲空话，不要过度铺垫，不要为了显得热情而堆废话。',
        temperature: 0.15,
        maxTokens: 1200
      },
      {
        id: 'helper',
        name: '生活助理',
        systemPrompt: '你是一个务实的生活助理。适合处理日常建议、流程说明、整理总结、文案润色、信息归纳。优先提供步骤、注意事项和可执行建议。语气平实自然，不端着，也不油腻。',
        temperature: 0.35,
        maxTokens: 700
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

function createDs2ApiRoute(route: Partial<Ds2ApiRouteConfig> & Pick<Ds2ApiRouteConfig, 'id' | 'name'>): Ds2ApiRouteConfig {
  return {
    id: route.id,
    name: route.name,
    enabled: route.enabled ?? true,
    model: route.model ?? 'gpt-4o',
    intentPrompt: route.intentPrompt ?? '',
    systemPrompt: route.systemPrompt ?? '',
    temperature: route.temperature ?? 0.3,
    maxTokens: route.maxTokens ?? 1024
  };
}

function getDefaultDs2ApiPlugin(): Ds2ApiPluginConfig {
  return {
    id: 'ds2api',
    kind: 'ds2api',
    name: 'DS2API',
    enabled: false,
    baseUrl: 'http://127.0.0.1:6011/v1',
    apiKey: '',
    timeoutMs: config.AI_TIMEOUT_MS,
    routes: [
      createDs2ApiRoute({
        id: 'chat',
        name: '日常对话',
        model: 'gpt-4o',
        intentPrompt: '用于闲聊、简单问答、短回复、翻译、润色、解释常见概念、轻量建议。',
        systemPrompt: '你负责自然、简洁、友好的日常回复，优先保持聊天感，不要过度展开。',
        temperature: 0.7,
        maxTokens: 640
      }),
      createDs2ApiRoute({
        id: 'reasoning',
        name: '复杂分析',
        model: 'o3',
        intentPrompt: '用于复杂分析、多步骤推理、方案比较、决策建议、长链路判断、严肃讨论。',
        systemPrompt: '你负责更深入的分析和严谨推理，先抓关键矛盾，再给出结论和建议。',
        temperature: 0.3,
        maxTokens: 1400
      }),
      createDs2ApiRoute({
        id: 'coding',
        name: '代码技术',
        model: 'gpt-5-codex',
        intentPrompt: '用于编程、报错排查、代码解释、系统设计、接口联调、开发建议。',
        systemPrompt: '你负责技术和代码问题，回答要直接、准确、可执行。',
        temperature: 0.2,
        maxTokens: 1600
      })
    ]
  };
}

function normalizeDs2ApiPlugin(plugin: Partial<Ds2ApiPluginConfig>, fallback: Ds2ApiPluginConfig): Ds2ApiPluginConfig {
  const legacyRoute = ('model' in plugin || 'systemPrompt' in plugin || 'temperature' in plugin || 'maxTokens' in plugin)
    ? createDs2ApiRoute({
      id: 'legacy',
      name: '默认模型',
      model: typeof (plugin as Record<string, unknown>).model === 'string' ? String((plugin as Record<string, unknown>).model) : fallback.routes[0]?.model ?? 'gpt-4o',
      intentPrompt: '兼容旧配置迁移得到的默认路由。',
      systemPrompt: typeof (plugin as Record<string, unknown>).systemPrompt === 'string' ? String((plugin as Record<string, unknown>).systemPrompt) : fallback.routes[0]?.systemPrompt ?? '',
      temperature: typeof (plugin as Record<string, unknown>).temperature === 'number' ? Number((plugin as Record<string, unknown>).temperature) : fallback.routes[0]?.temperature ?? 0.3,
      maxTokens: typeof (plugin as Record<string, unknown>).maxTokens === 'number' ? Number((plugin as Record<string, unknown>).maxTokens) : fallback.routes[0]?.maxTokens ?? 1024
    })
    : null;

  const sourceRoutes = Array.isArray(plugin.routes) && plugin.routes.length > 0
    ? plugin.routes
    : legacyRoute
      ? [legacyRoute]
      : fallback.routes;

  return {
    ...fallback,
    ...plugin,
    id: 'ds2api',
    kind: 'ds2api',
    name: typeof plugin.name === 'string' && plugin.name.trim() ? plugin.name : fallback.name,
    routes: sourceRoutes.map((route, index) => {
      const fallbackRoute = fallback.routes[index] ?? fallback.routes[0];
      return createDs2ApiRoute({
        ...(fallbackRoute ?? route),
        ...route,
        id: typeof route.id === 'string' && route.id.trim() ? route.id : `route-${index + 1}`,
        name: typeof route.name === 'string' && route.name.trim() ? route.name : `路由 ${index + 1}`
      });
    })
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

function buildQingmengDefaultAliases(name: string): string[] {
  const aliases = new Set<string>();
  const trimmed = name.trim();
  if (trimmed) {
    aliases.add(trimmed);
  }

  const simplified = trimmed
    .replace(/(图片|视频|语音|系列|模型|头条|专区|接口|运势配对)$/u, '')
    .trim();
  if (simplified && simplified !== trimmed) {
    aliases.add(simplified);
  }

  return [...aliases];
}

type QingmengEndpointSeed = Omit<QingmengEndpointConfig, 'intentAliases' | 'fallbackEligible'> &
  Partial<Pick<QingmengEndpointConfig, 'intentAliases' | 'fallbackEligible'>>;

function getDefaultQingmengDisplayMode(endpoint: Pick<QingmengEndpointConfig, 'group'>): QingmengEndpointConfig['displayMode'] {
  if (endpoint.group === 'image' || endpoint.group === 'video' || endpoint.group === 'audio') {
    return 'none';
  }

  return 'fixed';
}

function createQingmengEndpoint(endpoint: QingmengEndpointSeed): QingmengEndpointConfig {
  const intentAliases = Array.isArray(endpoint.intentAliases) && endpoint.intentAliases.length > 0
    ? endpoint.intentAliases
    : buildQingmengDefaultAliases(endpoint.name);

  return {
    ...endpoint,
    intentAliases,
    displayMode: endpoint.displayMode ?? getDefaultQingmengDisplayMode(endpoint),
    fallbackEligible:
      endpoint.fallbackEligible ?? (endpoint.group === 'image' || endpoint.group === 'video' || endpoint.group === 'audio')
  };
}

function normalizeQingmengPlugin(plugin: QingmengPluginConfig, fallback: QingmengPluginConfig): QingmengPluginConfig {
  const fallbackEndpointMap = new Map(fallback.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const sourceEndpoints = Array.isArray(plugin.endpoints) && plugin.endpoints.length > 0 ? plugin.endpoints : fallback.endpoints;

  return {
    ...fallback,
    ...plugin,
    endpoints: sourceEndpoints.map((endpoint) => {
      const fallbackEndpoint = fallbackEndpointMap.get(endpoint.id);
      return createQingmengEndpoint({
        ...(fallbackEndpoint ?? endpoint),
        ...endpoint
      });
    })
  };
}

function getDefaultQingmengPlugin(): QingmengPluginConfig {
  return {
    id: 'qingmeng',
    kind: 'qingmeng',
    name: '倾梦API',
    enabled: false,
    ckey: 'PFEIWB8Z6KQBW850QTCL',
    classifierPrompt: [
      '你是 QQ 消息里的插件路由器，只负责判断当前消息是否应该调用倾梦 API 的某个接口。',
      '如果用户意图与任一接口明显匹配，就返回目标 endpointId，并尽量抽取接口参数。',
      '如果用户没有这个意图，必须返回 shouldUsePlugin=false。',
      '当接口需要图片链接时，只有用户消息中真的带了图片，才能命中。',
      '只输出 JSON。'
    ].join('\n'),
    endpoints: [
      createQingmengEndpoint({
        id: 'tx-news',
        name: '腾讯新闻头条',
        enabled: true,
        group: 'text',
        description: '返回腾讯新闻头条列表，适合“头条新闻、今日新闻、腾讯新闻”这类请求。',
        intentAliases: ['腾讯新闻头条', '腾讯新闻', '头条新闻', '新闻头条', '新闻'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/yljk/txxw',
        intentPrompt: '当用户想看腾讯新闻、今日头条、热点新闻摘要时使用。',
        parameters: [
          {
            id: 'page',
            name: 'page',
            label: '条数',
            description: '希望返回的新闻条数，范围 1-10，没有明确提到时默认 5。',
            source: 'intent',
            required: false,
            defaultValue: '5'
          },
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定返回 json 方便解析。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_list',
        listPath: 'data',
        itemTitlePath: 'title',
        itemUrlPath: 'url',
        displayMode: 'fixed',
        displayText: '腾讯新闻头条',
        captionTemplate: '腾讯新闻头条',
        sampleInput: '来 5 条腾讯新闻头条'
      }),
      createQingmengEndpoint({
        id: 'image-analysis',
        name: '智谱图片分析模型',
        enabled: true,
        group: 'analysis',
        description: '根据用户发送的图片进行中文分析和解释。',
        intentAliases: ['智谱图片分析模型', '图片分析', '分析图片', '看图', '识图', '理解图片', '解释图片'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/AI/zpai/tpfx',
        intentPrompt: '只有当用户发了图片，并要求解释、分析、识别、理解、描述图片内容时使用。',
        parameters: [
          {
            id: 'url',
            name: 'url',
            label: '图片地址',
            description: '直接使用用户消息里的第一张图片链接。',
            source: 'image_url',
            required: true,
            defaultValue: ''
          },
          {
            id: 'msg',
            name: 'msg',
            label: '分析方向',
            description: '根据用户要求提炼分析指令；如果没有具体要求，就让模型用中文简要分析图片。',
            source: 'intent',
            required: true,
            defaultValue: '请使用中文简要分析这张图片的主体、场景和关键信息。'
          }
        ],
        responseMode: 'openai_text',
        responsePath: 'choices.0.message.content',
        sampleInput: '帮我看看这张图里是什么',
        sampleImageUrl: 'https://img-baofun.zhhainiao.com/pcwallpaper_ugc/live/9a87735240c4e2a1821f185469150239.jpg'
      }),
      createQingmengEndpoint({
        id: 'ycyy-video',
        name: '又纯又欲',
        enabled: true,
        group: 'video',
        description: '随机返回一段又纯又欲系列视频。',
        intentAliases: ['又纯又欲', '纯欲视频', '纯欲'],
        method: 'GET',
        url: 'http://api.317ak.cn/api/sp/ycyy',
        intentPrompt: '当用户想看又纯又欲系列视频时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '又纯又欲',
        sampleInput: '来一段又纯又欲视频'
      }),
      createQingmengEndpoint({
        id: 'selfie-image',
        name: '自拍图片',
        enabled: true,
        group: 'image',
        description: '随机返回一张自拍图片。',
        method: 'GET',
        url: 'https://api.317ak.cn/api/wztp/zptp',
        intentPrompt: '当用户想看自拍图、自画像风格图片时使用。',
        parameters: [
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定为 json。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_value',
        responsePath: 'text',
        displayMode: 'none',
        captionTemplate: '自拍图片',
        sampleInput: '来一张自拍图片'
      }),
      createQingmengEndpoint({
        id: 'rwxl-video',
        name: '热舞系列',
        enabled: true,
        group: 'video',
        description: '随机返回一段热舞系列视频。',
        intentAliases: ['热舞系列', '热舞'],
        method: 'GET',
        url: 'http://api.317ak.cn/api/sp/rwxl',
        intentPrompt: '当用户想看热舞系列视频时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '热舞系列',
        sampleInput: '来一段热舞系列'
      }),
      createQingmengEndpoint({
        id: 'ddxl-video',
        name: '吊带系列',
        enabled: true,
        group: 'video',
        description: '随机返回一段吊带系列视频。',
        intentAliases: ['吊带系列', '吊带'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/sp/ddxl',
        intentPrompt: '当用户想看吊带系列视频时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '吊带系列',
        sampleInput: '来一段吊带系列视频'
      }),
      createQingmengEndpoint({
        id: 'qcxl-video',
        name: '清纯系列',
        enabled: true,
        group: 'video',
        description: '随机返回一段清纯系列视频。',
        intentAliases: ['清纯系列', '清纯'],
        method: 'GET',
        url: 'http://api.317ak.cn/api/sp/qcxl',
        intentPrompt: '当用户想看清纯系列视频时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '清纯系列',
        sampleInput: '来一段清纯系列视频'
      }),
      createQingmengEndpoint({
        id: 'cqng-video',
        name: '纯情女高',
        enabled: true,
        group: 'video',
        description: '随机返回一段纯情女高系列视频。',
        method: 'GET',
        url: 'http://api.317ak.cn/api/sp/cqng',
        intentPrompt: '当用户想看纯情女高系列视频时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '纯情女高',
        sampleInput: '来一段纯情女高视频'
      }),
      createQingmengEndpoint({
        id: 'slxl-video',
        name: '少萝系列',
        enabled: true,
        group: 'video',
        description: '随机返回一段少萝系列视频。',
        method: 'GET',
        url: 'http://api.317ak.cn/api/sp/slxl',
        intentPrompt: '当用户想看少萝系列视频时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '少萝系列',
        sampleInput: '来一段少萝系列视频'
      }),
      createQingmengEndpoint({
        id: 'jk-image',
        name: 'JK图片',
        enabled: true,
        group: 'image',
        description: '随机返回一张 JK 图片。',
        intentAliases: ['JK图片', 'jk图片', 'jk'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/jktp',
        intentPrompt: '当用户想看 JK 图片时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: 'JK 图片',
        sampleInput: '来一张 JK 图片'
      }),
      createQingmengEndpoint({
        id: 'black-silk-image',
        name: '黑丝图片',
        enabled: true,
        group: 'image',
        description: '随机返回一张黑丝图片。',
        intentAliases: ['黑丝图片', '黑丝'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/hstp',
        intentPrompt: '当用户想看黑丝图片时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '黑丝图片',
        sampleInput: '来一张黑丝图片'
      }),
      createQingmengEndpoint({
        id: 'white-silk-image',
        name: '白丝图片',
        enabled: true,
        group: 'image',
        description: '随机返回一张白丝图片。',
        intentAliases: ['白丝图片', '白丝'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/bstp',
        intentPrompt: '当用户想看白丝图片时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '白丝图片',
        sampleInput: '来一张白丝图片'
      }),
      createQingmengEndpoint({
        id: 'beauty-image',
        name: '美女图片',
        enabled: true,
        group: 'image',
        description: '随机返回一张美女图片。',
        intentAliases: ['美女图片', '美女'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/mntp',
        intentPrompt: '当用户想看美女图片时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '美女图片',
        sampleInput: '来一张美女图片'
      }),
      createQingmengEndpoint({
        id: 'dmst-image',
        name: '动漫涩图',
        enabled: true,
        group: 'image',
        description: '随机返回一张动漫涩图。',
        intentAliases: ['动漫涩图', '动漫图', '动漫图片'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/wztp/dmst',
        intentPrompt: '当用户想看动漫涩图时使用。',
        parameters: [
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定为 json。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_value',
        responsePath: 'text',
        displayMode: 'none',
        captionTemplate: '动漫涩图',
        sampleInput: '来一张动漫涩图'
      }),
      createQingmengEndpoint({
        id: '4k-wallpaper',
        name: '4K壁纸专区',
        enabled: true,
        group: 'image',
        description: '返回一张或多张 4K 壁纸，适合“来点壁纸”“换张高质量壁纸”这类请求。',
        intentAliases: ['4K壁纸专区', '4k壁纸', '壁纸', '高清壁纸'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/4kbz/4k',
        intentPrompt: '当用户想要壁纸、高清壁纸、4K 壁纸时使用。',
        parameters: [
          {
            id: 'count',
            name: 'count',
            label: '数量',
            description: '用户想要几张壁纸，没有明确时默认 1。',
            source: 'intent',
            required: false,
            defaultValue: '1'
          },
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定为 json。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_list',
        listPath: 'data',
        displayMode: 'none',
        captionTemplate: '4K 壁纸',
        sampleInput: '来一张 4K 壁纸'
      }),
      createQingmengEndpoint({
        id: 'tempting-image',
        name: '诱惑图片',
        enabled: true,
        group: 'image',
        description: '随机返回一张诱惑图片。',
        intentAliases: ['诱惑图片', '诱惑图'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/yhtp',
        intentPrompt: '当用户想看诱惑图片时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '诱惑图片',
        sampleInput: '来一张诱惑图片'
      }),
      createQingmengEndpoint({
        id: 'wallpaper-search',
        name: '壁纸搜索',
        enabled: true,
        group: 'image',
        description: '根据用户提供的主题搜索壁纸。',
        intentAliases: ['壁纸搜索', '搜壁纸', '搜索壁纸', '找壁纸'],
        fallbackEligible: false,
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/4kbz/4kss',
        intentPrompt: '当用户明确说想搜索某种主题的壁纸时使用。',
        parameters: [
          {
            id: 'msg',
            name: 'msg',
            label: '搜索内容',
            description: '要搜索的壁纸关键词，比如动漫、海边、赛博朋克。',
            source: 'intent',
            required: true,
            defaultValue: ''
          },
          {
            id: 'count',
            name: 'count',
            label: '数量',
            description: '用户希望返回的壁纸数量，没有明确时默认 1。',
            source: 'intent',
            required: false,
            defaultValue: '1'
          },
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定为 json。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_list',
        listPath: 'data',
        displayMode: 'fixed',
        displayText: '给你找到了这些壁纸',
        captionTemplate: '壁纸搜索',
        sampleInput: '搜一张动漫壁纸'
      }),
      createQingmengEndpoint({
        id: 'duitang-search',
        name: '堆糖搜图',
        enabled: true,
        group: 'image',
        description: '根据关键词搜索图片。你给的 id=329 实际对应的是这个接口，不是热舞系列。',
        intentAliases: ['堆糖搜图', '搜图', '找图', '搜索图片'],
        fallbackEligible: false,
        method: 'GET',
        url: 'https://api.317ak.cn/api/tp/duitangtu',
        intentPrompt: '当用户想搜图、找某个主题的图片时使用。',
        parameters: [
          {
            id: 'msg',
            name: 'msg',
            label: '搜索内容',
            description: '搜索图像的主题或关键词。',
            source: 'intent',
            required: true,
            defaultValue: ''
          },
          {
            id: 'n',
            name: 'n',
            label: '序号',
            description: '固定为 yes，随机返回一张。',
            source: 'fixed',
            required: true,
            defaultValue: 'yes'
          },
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定为 json。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_value',
        responsePath: 'data.0.Url',
        displayMode: 'fixed',
        displayText: '给你找了一张',
        captionTemplate: '堆糖搜图',
        sampleInput: '帮我搜一张动漫图'
      }),
      createQingmengEndpoint({
        id: 'genshin-kfc-audio',
        name: '原神KFC语音',
        enabled: true,
        group: 'audio',
        description: '随机返回原神 KFC 联动语音。',
        intentAliases: ['原神KFC语音', '原神语音', 'kfc语音'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/yy/ys_kfc_music',
        intentPrompt: '当用户想听原神 KFC 语音时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '原神 KFC 语音',
        sampleInput: '来一段原神 KFC 语音'
      }),
      createQingmengEndpoint({
        id: 'kun-audio',
        name: '坤坤语音',
        enabled: true,
        group: 'audio',
        description: '随机返回坤坤语音。',
        intentAliases: ['坤坤语音', '坤坤'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/yy/kkyy',
        intentPrompt: '当用户想听坤坤语音时使用。',
        parameters: [],
        responseMode: 'redirect_media',
        displayMode: 'none',
        captionTemplate: '坤坤语音',
        sampleInput: '来一段坤坤语音'
      }),
      createQingmengEndpoint({
        id: 'constellation-match',
        name: '星座运势配对',
        enabled: true,
        group: 'tool',
        description: '根据用户提到的星座和时间范围返回运势与配对信息。',
        intentAliases: ['星座运势配对', '星座运势', '星座配对', '查星座', '星座'],
        method: 'GET',
        url: 'https://api.317ak.cn/api/yljk/xzyspd',
        intentPrompt: '当用户想查某个星座的运势、配对、今日运势、本周运势时使用。',
        parameters: [
          {
            id: 'msg',
            name: 'msg',
            label: '星座名称',
            description: '需要查询的星座名称，支持中文或英文。',
            source: 'intent',
            required: true,
            defaultValue: ''
          },
          {
            id: 'time',
            name: 'time',
            label: '时间范围',
            description: 'today、week、month、year，未明确时默认 today。',
            source: 'intent',
            required: false,
            defaultValue: 'today'
          },
          {
            id: 'type',
            name: 'type',
            label: '返回格式',
            description: '固定为 json。',
            source: 'fixed',
            required: true,
            defaultValue: 'json'
          }
        ],
        responseMode: 'json_value',
        responsePath: '$self',
        displayMode: 'fixed',
        displayText: '星座运势配对',
        captionTemplate: '星座运势配对',
        sampleInput: '帮我查一下白羊座本周运势'
      })
    ]
  };
}

type LegacyRuntimeSettings = {
  routedAis?: Array<Record<string, unknown>>;
  qweather?: Partial<QWeatherPluginConfig>;
};

async function loadLegacyRuntimeSettings(): Promise<LegacyRuntimeSettings | null> {
  return readJsonFile<LegacyRuntimeSettings | null>(runtimeSettingsPath, null);
}

async function loadDefaultPluginConfig(kind: PluginKind): Promise<PluginConfig> {
  const legacy = await loadLegacyRuntimeSettings();

  if (kind === 'ds2api') {
    const fallback = getDefaultDs2ApiPlugin();
    const legacyDs2Api = legacy?.routedAis?.find((item) => item.id === 'ds2api') ?? legacy?.routedAis?.[0] ?? {};
    return normalizeDs2ApiPlugin(legacyDs2Api as Partial<Ds2ApiPluginConfig>, fallback);
  }

  if (kind === 'qingmeng') {
    return getDefaultQingmengPlugin();
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
  const loaded = await readJsonFile<PluginConfig>(getPluginFilePath(kind), fallback);

  if (kind === 'ds2api' && fallback.kind === 'ds2api') {
    return normalizeDs2ApiPlugin(loaded as Partial<Ds2ApiPluginConfig>, fallback);
  }

  if (kind === 'qingmeng' && loaded.kind === 'qingmeng' && fallback.kind === 'qingmeng') {
    return normalizeQingmengPlugin(loaded, fallback);
  }

  return loaded;
}

export async function loadPluginConfigs(): Promise<PluginConfig[]> {
  const defaults = await Promise.all([loadPluginConfig('ds2api'), loadPluginConfig('qweather'), loadPluginConfig('qingmeng')]);

  try {
    const existingFiles = await readdir(pluginsDir);
    const extraPluginFiles = existingFiles.filter(
      (file) => file.endsWith('.json') && !['ds2api.json', 'qweather.json', 'qingmeng.json'].includes(file)
    );
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

export async function loadScheduledTasks(): Promise<ScheduledTask[]> {
  const tasks = await readJsonFile<ScheduledTask[]>(tasksPath, []);
  return Array.isArray(tasks)
    ? tasks.map((task) => ({
      ...task,
      pluginId: typeof task.pluginId === 'string' ? task.pluginId : '',
      pluginPayload: task.pluginPayload && typeof task.pluginPayload === 'object' ? task.pluginPayload : {},
      messageTemplate: typeof task.messageTemplate === 'string' ? task.messageTemplate : '',
      timezone: typeof task.timezone === 'string' && task.timezone.trim() ? task.timezone : 'Asia/Shanghai',
      jitterSeconds: Number.isFinite(task.jitterSeconds) ? Math.max(0, Math.floor(task.jitterSeconds)) : 0,
      targets: Array.isArray(task.targets) ? task.targets : [],
      logs: Array.isArray(task.logs) ? task.logs.slice(0, 20) : []
    }))
    : [];
}

export async function saveScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  await writeJsonFile(tasksPath, tasks);
}

/** 会话状态文件路径，供 store 层统一写回。 */
export { sessionsPath, tasksPath, rulesPath, personasPath, runtimeSettingsPath, pluginsDir };
