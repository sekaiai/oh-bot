import type {
  BotMessage,
  Ds2ApiPluginConfig,
  OutboundMessageContent,
  PersonaConfig,
  PluginConfig,
  QingmengEndpointConfig,
  QingmengPluginConfig,
  QWeatherPluginConfig,
  ReplyDecision,
  SessionMessage
} from '../types/bot.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AiClient, type PluginRoutingCandidateSummary } from './ai-client.js';
import { QingmengClient } from './qingmeng-client.js';
import {
  QWeatherClient,
  type AirNow,
  type QWeatherLocation,
  type SunriseSunset,
  type WeatherIndex,
  type WeatherNow,
  type WeatherWarning
} from './qweather-client.js';

interface WeatherToolResult {
  location: QWeatherLocation;
  requestedLocation: string;
  weatherNow: WeatherNow | null;
  warnings: WeatherWarning[];
  indices: WeatherIndex[];
  airNow: AirNow | null;
  sunriseSunset: SunriseSunset | null;
}

export interface ToolResolution {
  handled: boolean;
  reason?: ReplyDecision['reason'];
  reply?: string;
  outboundMessage?: OutboundMessageContent;
  toolContext?: string;
}

const WEATHER_KEYWORDS = [
  '天气',
  '气温',
  '温度',
  '下雨',
  '下雪',
  '冷不冷',
  '热不热',
  '预警',
  '空气质量',
  '空气',
  'aqi',
  '紫外线',
  '穿衣',
  '洗车',
  '指数',
  '日出',
  '日落'
];

const LOCATION_STOPWORDS = [
  '查',
  '查询',
  '看看',
  '帮我',
  '想知道',
  '一下',
  '今天',
  '现在',
  '实时',
  '当前',
  '天气',
  '气温',
  '温度',
  '空气质量',
  '空气',
  '预警',
  '指数',
  '紫外线',
  '日出',
  '日落',
  '有没有',
  '吗',
  '呢',
  '呀',
  '吧'
];

function looksLikeWeatherRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return WEATHER_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function extractCandidateLocation(text: string): string {
  let candidate = text;
  for (const word of LOCATION_STOPWORDS) {
    candidate = candidate.replaceAll(word, ' ');
  }

  candidate = candidate.replace(/[？?！!，,。.:：/]/g, ' ');
  candidate = candidate.replace(/\s+/g, ' ').trim();
  return candidate;
}

function buildLocationDisplayName(location: QWeatherLocation): string {
  return [location.name, location.adm2, location.adm1, location.country]
    .filter((part, index, array) => part && array.indexOf(part) === index)
    .join(' ');
}

function formatWeatherToolContext(result: WeatherToolResult): string {
  const sections: string[] = [];
  const displayName = buildLocationDisplayName(result.location);

  sections.push(`查询地点: ${displayName}`);
  sections.push(`用户输入地点: ${result.requestedLocation}`);

  if (result.weatherNow) {
    sections.push(
      [
        '实时天气:',
        `天气=${result.weatherNow.text ?? '未知'}`,
        `温度=${result.weatherNow.temp ?? '未知'}C`,
        `体感=${result.weatherNow.feelsLike ?? '未知'}C`,
        `湿度=${result.weatherNow.humidity ?? '未知'}%`,
        `风向=${result.weatherNow.windDir ?? '未知'}`,
        `风力=${result.weatherNow.windScale ?? '未知'}级`,
        `降水=${result.weatherNow.precip ?? '未知'}mm`,
        `气压=${result.weatherNow.pressure ?? '未知'}hPa`,
        `能见度=${result.weatherNow.vis ?? '未知'}km`,
        `更新时间=${result.weatherNow.obsTime ?? '未知'}`
      ].join(' ')
    );
  }

  if (result.warnings.length > 0) {
    const warningText = result.warnings
      .slice(0, 3)
      .map((warning, index) => {
        return `${index + 1}. ${warning.title ?? warning.typeName ?? '天气预警'}；级别=${warning.level ?? warning.severity ?? '未知'}；状态=${warning.status ?? '未知'}；发布时间=${warning.pubTime ?? '未知'}；内容=${warning.text ?? '无'}`;
      })
      .join('\n');
    sections.push(`天气预警:\n${warningText}`);
  } else {
    sections.push('天气预警: 当前无预警');
  }

  if (result.indices.length > 0) {
    const indicesText = result.indices
      .map((index) => `${index.name ?? index.type}: ${index.category ?? '未知'}；${index.text ?? '无说明'}`)
      .join('\n');
    sections.push(`天气指数:\n${indicesText}`);
  }

  if (result.airNow) {
    sections.push(
      [
        '空气质量:',
        `AQI=${result.airNow.aqi ?? '未知'}`,
        `等级=${result.airNow.category ?? result.airNow.level ?? '未知'}`,
        `首要污染物=${result.airNow.primary ?? '未知'}`,
        `PM2.5=${result.airNow.pm2p5 ?? '未知'}`,
        `PM10=${result.airNow.pm10 ?? '未知'}`,
        `NO2=${result.airNow.no2 ?? '未知'}`,
        `SO2=${result.airNow.so2 ?? '未知'}`,
        `CO=${result.airNow.co ?? '未知'}`,
        `O3=${result.airNow.o3 ?? '未知'}`
      ].join(' ')
    );
  }

  if (result.sunriseSunset) {
    sections.push(
      [
        '日出日落:',
        `日出=${result.sunriseSunset.sunrise ?? '未知'}`,
        `日落=${result.sunriseSunset.sunset ?? '未知'}`,
        `月出=${result.sunriseSunset.moonrise ?? '未知'}`,
        `月落=${result.sunriseSunset.moonset ?? '未知'}`
      ].join(' ')
    );
  }

  return sections.join('\n\n');
}

function formatDateForAstronomy(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

async function resolveOptionalToolCall<T>(
  label: string,
  loader: () => Promise<T>,
  fallback: T,
  context: Record<string, unknown>
): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    logger.warn({ err: error, label, ...context }, 'Optional weather sub-request failed');
    return fallback;
  }
}

function findDs2ApiPlugin(plugins: PluginConfig[]): Ds2ApiPluginConfig | undefined {
  return plugins.find((plugin): plugin is Ds2ApiPluginConfig => plugin.kind === 'ds2api');
}

function findFallbackDs2ApiPlugin(plugins: PluginConfig[]): Ds2ApiPluginConfig | undefined {
  return plugins.find((plugin): plugin is Ds2ApiPluginConfig => {
    return plugin.kind === 'ds2api' && plugin.enabled && Boolean(plugin.apiKey) && plugin.routes.some((route) => route.enabled);
  });
}

function findQWeatherPlugin(plugins: PluginConfig[]): QWeatherPluginConfig | undefined {
  return plugins.find((plugin): plugin is QWeatherPluginConfig => plugin.kind === 'qweather');
}

function findQingmengPlugin(plugins: PluginConfig[]): QingmengPluginConfig | undefined {
  return plugins.find((plugin): plugin is QingmengPluginConfig => plugin.kind === 'qingmeng');
}

function normalizeIntentText(text: string): string {
  return text.trim().toLowerCase();
}

function matchQingmengEndpointByAlias(text: string, endpoints: QingmengEndpointConfig[]): QingmengEndpointConfig | undefined {
  const normalized = normalizeIntentText(text);
  const candidates = endpoints
    .map((endpoint) => {
      const bestAlias = endpoint.intentAliases
        .map((alias) => alias.trim())
        .filter(Boolean)
        .filter((alias) => normalized.includes(alias.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];

      return {
        endpoint,
        bestAliasLength: bestAlias?.length ?? 0
      };
    })
    .filter((item) => item.bestAliasLength > 0)
    .sort((a, b) => b.bestAliasLength - a.bestAliasLength);

  return candidates[0]?.endpoint;
}

function looksLikeGenericImageRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return ['图片', '照片', '来张图', '来一张图', '来张图片', '发张图', '发一张图', '来个图片'].some((keyword) =>
    normalized.includes(keyword)
  );
}

function looksLikeGenericVideoRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return ['视频', '短视频', '短片', '片子'].some((keyword) => normalized.includes(keyword));
}

function looksLikeGenericAudioRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return ['语音', '音频', '声音'].some((keyword) => normalized.includes(keyword));
}

function detectQingmengFallbackGroup(text: string, hasImageAttachment: boolean): QingmengEndpointConfig['group'] | null {
  if (!hasImageAttachment && looksLikeGenericImageRequest(text)) {
    return 'image';
  }

  if (looksLikeGenericVideoRequest(text)) {
    return 'video';
  }

  if (looksLikeGenericAudioRequest(text)) {
    return 'audio';
  }

  return null;
}

function pickRandomQingmengEndpoint(
  endpoints: QingmengEndpointConfig[],
  group: QingmengEndpointConfig['group']
): QingmengEndpointConfig | undefined {
  const candidates = endpoints.filter((endpoint) => endpoint.group === group && endpoint.fallbackEligible);
  if (candidates.length === 0) {
    return undefined;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function summarizeQingmengPlugin(plugin: QingmengPluginConfig): string {
  const enabledEndpoints = plugin.endpoints.filter((endpoint) => endpoint.enabled);
  if (enabledEndpoints.length === 0) {
    return '没有启用的接口。';
  }

  const groupSummary = ['analysis', 'tool', 'text', 'image', 'video', 'audio']
    .map((group) => {
      const items = enabledEndpoints.filter((endpoint) => endpoint.group === group);
      if (items.length === 0) {
        return null;
      }

      return `${group}: ${items.map((endpoint) => endpoint.name).join('、')}`;
    })
    .filter(Boolean)
    .join('\n');

  return groupSummary || '没有启用的接口。';
}

function buildPluginRoutingCandidates(
  qweatherPlugin: QWeatherPluginConfig | undefined,
  qingmengPlugin: QingmengPluginConfig | undefined,
  ds2apiPlugin: Ds2ApiPluginConfig | undefined
): PluginRoutingCandidateSummary {
  return {
    qweather: {
      enabled: Boolean(qweatherPlugin?.enabled && qweatherPlugin.apiKey),
      intentPrompt: '处理天气、空气质量、预警、紫外线、日出日落等实时天气查询。'
    },
    qingmeng: {
      enabled: Boolean(qingmengPlugin?.enabled && qingmengPlugin.ckey && qingmengPlugin.endpoints.some((endpoint) => endpoint.enabled)),
      intentPrompt: qingmengPlugin
        ? `处理外部接口类请求。可用能力如下：\n${summarizeQingmengPlugin(qingmengPlugin)}`
        : '处理图片、视频、语音、新闻、图片分析等外部接口能力。'
    },
    ds2api: {
      enabled: Boolean(ds2apiPlugin?.enabled && ds2apiPlugin.apiKey && ds2apiPlugin.routes.some((route) => route.enabled)),
      routes: (ds2apiPlugin?.routes ?? [])
        .filter((route) => route.enabled)
        .map((route) => ({
          id: route.id,
          name: route.name,
          intentPrompt: route.intentPrompt
        }))
    }
  };
}

function selectDs2ApiRoute(plugin: Ds2ApiPluginConfig, routeId?: string | null) {
  return plugin.routes.find((route) => route.id === routeId && route.enabled)
    ?? plugin.routes.find((route) => route.enabled)
    ?? null;
}

export class ToolRouter {
  private readonly aiClient = new AiClient();

  async resolve(
    message: BotMessage,
    plugins: PluginConfig[],
    contextMessages: SessionMessage[],
    persona: PersonaConfig
  ): Promise<ToolResolution> {
    const qweatherPlugin = findQWeatherPlugin(plugins);
    const ds2apiPlugin = findDs2ApiPlugin(plugins);
    const qingmengPlugin = findQingmengPlugin(plugins);

    const routingCandidates = buildPluginRoutingCandidates(qweatherPlugin, qingmengPlugin, ds2apiPlugin);
    if (!routingCandidates.qweather.enabled && !routingCandidates.qingmeng.enabled && !routingCandidates.ds2api.enabled) {
      return { handled: false };
    }

    try {
      const routingDecision = await this.aiClient.classifyPluginRoute(
        message,
        contextMessages,
        routingCandidates,
        {
          baseUrl: config.AI_BASE_URL,
          apiKey: config.AI_API_KEY,
          model: config.AI_MODEL,
          timeoutMs: config.AI_TIMEOUT_MS
        }
      );

      if (routingDecision.target === 'qweather') {
        if (!qweatherPlugin?.enabled) {
          return {
            handled: true,
            reason: 'tool_error',
            reply: '和风天气插件当前未启用，请先在后台打开插件或补全配置。'
          };
        }

        return this.resolveWeather(message, qweatherPlugin);
      }

      if (routingDecision.target === 'qingmeng') {
        if (!qingmengPlugin?.enabled) {
          return {
            handled: true,
            reason: 'tool_error',
            reply: '倾梦插件当前未启用，请先在后台打开插件或补全配置。'
          };
        }

        return this.resolveQingmeng(message, plugins, contextMessages, persona, qingmengPlugin);
      }

      if (routingDecision.target === 'ds2api') {
        if (!ds2apiPlugin?.enabled || !ds2apiPlugin.apiKey) {
          return { handled: false };
        }

        const route = selectDs2ApiRoute(ds2apiPlugin, routingDecision.ds2apiRouteId);
        if (!route) {
          return {
            handled: true,
            reason: 'tool_error',
            reply: 'DS2API 当前没有可用模型路由，请先在后台启用至少一条路由。'
          };
        }

        const reply = await this.aiClient.generateRoutedReply(message, contextMessages, persona, ds2apiPlugin, route, {
          fallbackContext: `主路由原因: ${routingDecision.reason}`
        });
        return {
          handled: true,
          reason: 'tool_ds2api',
          reply
        };
      }

      if (routingCandidates.ds2api.enabled && ds2apiPlugin?.enabled && ds2apiPlugin.apiKey) {
        const route = selectDs2ApiRoute(ds2apiPlugin, routingDecision.ds2apiRouteId);
        if (route) {
          const reply = await this.aiClient.generateRoutedReply(message, contextMessages, persona, ds2apiPlugin, route, {
            fallbackContext: `主路由原因: ${routingDecision.reason}`
          });
          return {
            handled: true,
            reason: 'tool_ds2api',
            reply
          };
        }
      }

      return { handled: false };
    } catch (error) {
      logger.error({ err: error, text: message.cleanText }, 'Plugin routing failed');

      const fallbackDs2ApiPlugin = findFallbackDs2ApiPlugin(plugins);
      if (fallbackDs2ApiPlugin) {
        try {
          const route = selectDs2ApiRoute(fallbackDs2ApiPlugin);
          if (route) {
            const reply = await this.aiClient.generateRoutedReply(
              message,
              contextMessages,
              persona,
              fallbackDs2ApiPlugin,
              route,
              {
                fallbackContext: [
                  `主路由失败: ${error instanceof Error ? error.message : String(error)}`,
                  '这是主路由失败后的兜底回复。'
                ].join('\n')
              }
            );
            return {
              handled: true,
              reason: 'tool_ds2api',
              reply
            };
          }
        } catch (fallbackError) {
          logger.error({ err: fallbackError, text: message.cleanText }, 'DS2API fallback after routing failure failed');
        }
      }

      return {
        handled: false
      };
    }
  }

  private async resolveQingmeng(
    message: BotMessage,
    plugins: PluginConfig[],
    contextMessages: SessionMessage[],
    persona: PersonaConfig,
    qingmengPlugin: QingmengPluginConfig
  ): Promise<ToolResolution> {
    try {
      const enabledEndpoints = qingmengPlugin.endpoints.filter((endpoint) => endpoint.enabled);
      if (enabledEndpoints.length === 0) {
        return { handled: false };
      }

      if (!qingmengPlugin.ckey) {
        return {
          handled: true,
          reason: 'tool_error',
          reply: `插件「${qingmengPlugin.name}」还没有配置 ckey，请先在后台补全。`
        };
      }

      const qingmengClient = new QingmengClient(qingmengPlugin);
      const aliasMatchedEndpoint = matchQingmengEndpointByAlias(message.cleanText, enabledEndpoints);
      const fallbackGroup = aliasMatchedEndpoint ? null : detectQingmengFallbackGroup(message.cleanText, message.imageUrls.length > 0);
      const fallbackEndpoint = fallbackGroup ? pickRandomQingmengEndpoint(enabledEndpoints, fallbackGroup) : undefined;

      let endpoint = aliasMatchedEndpoint ?? fallbackEndpoint;
      let intentParams: Record<string, string> = {};

      if (!endpoint) {
        const classification = await this.aiClient.classifyQingmengIntent(
          message,
          contextMessages,
          qingmengPlugin,
          {
            baseUrl: config.AI_BASE_URL,
            apiKey: config.AI_API_KEY,
            model: config.AI_MODEL,
            timeoutMs: config.AI_TIMEOUT_MS
          }
        );

        if (!classification.shouldUsePlugin || !classification.endpointId) {
          const fallbackDs2ApiPlugin = findFallbackDs2ApiPlugin(plugins);
          if (fallbackDs2ApiPlugin) {
            const route = selectDs2ApiRoute(fallbackDs2ApiPlugin);
            if (route) {
              const reply = await this.aiClient.generateRoutedReply(
                message,
                contextMessages,
                persona,
                fallbackDs2ApiPlugin,
                route,
                {
                  fallbackContext: '倾梦已被主路由命中，但没有选出具体接口，回退到 DS2API。'
                }
              );
              return {
                handled: true,
                reason: 'tool_ds2api',
                reply
              };
            }
          }

          return { handled: false };
        }

        endpoint = enabledEndpoints.find((item) => item.id === classification.endpointId);
        if (!endpoint) {
          return { handled: false };
        }

        intentParams = classification.params;
      }

      const requestParams = qingmengClient.buildRequestParams(endpoint, intentParams, message.imageUrls);
      const missingImageParam = endpoint.parameters.find((parameter) => parameter.source === 'image_url' && parameter.required);
      if (missingImageParam && !message.imageUrls[0]) {
        return {
          handled: true,
          reason: 'tool_error',
          reply: '你这次没有发图片，我还没法帮你看图。把图片和问题一起发过来就行。'
        };
      }

      const execution = await qingmengClient.executeEndpoint(endpoint, requestParams);
      return {
        handled: true,
        reason: 'tool_qingmeng',
        reply: execution.replySummary,
        outboundMessage: execution.outboundMessage
      };
    } catch (error) {
      logger.error({ err: error, pluginId: qingmengPlugin.id, text: message.cleanText }, 'Qingmeng plugin request failed');

      const fallbackDs2ApiPlugin = findFallbackDs2ApiPlugin(plugins);
      if (fallbackDs2ApiPlugin) {
        try {
          const route = selectDs2ApiRoute(fallbackDs2ApiPlugin);
          if (!route) {
            throw new Error('DS2API 没有可用路由');
          }

          const reply = await this.aiClient.generateRoutedReply(
            message,
            contextMessages,
            persona,
            fallbackDs2ApiPlugin,
            route,
            {
              fallbackContext: [
                `原插件: ${qingmengPlugin.name}`,
                `失败原因: ${error instanceof Error ? error.message : String(error)}`,
                '这是插件失败后的兜底回复。',
                '如果你无法直接理解图片内容，不要假装看懂图片，直接说明当前没有成功读取图片内容，并引导用户稍后重试或补充文字描述。'
              ].join('\n')
            }
          );

          logger.warn(
            {
              pluginId: qingmengPlugin.id,
              fallbackPluginId: fallbackDs2ApiPlugin.id,
              text: message.cleanText,
              imageCount: message.imageUrls.length
            },
            'Qingmeng plugin failed and fell back to DS2API'
          );

          return {
            handled: true,
            reason: 'tool_ds2api',
            reply
          };
        } catch (fallbackError) {
          logger.error(
            {
              err: fallbackError,
              sourcePluginId: qingmengPlugin.id,
              fallbackPluginId: fallbackDs2ApiPlugin.id,
              text: message.cleanText
            },
            'DS2API fallback after Qingmeng failure also failed'
          );
        }
      }

      return {
        handled: true,
        reason: 'tool_error',
        reply: `插件「${qingmengPlugin.name}」当前调用失败，请稍后再试。`
      };
    }
  }

  private async resolveWeather(message: BotMessage, plugin: QWeatherPluginConfig): Promise<ToolResolution> {
    if (!plugin.apiKey) {
      return {
        handled: true,
        reason: 'tool_error',
        reply: '还没有配置和风天气 API Key，先在后台的插件配置里补全。'
      };
    }

    const requestedLocation = extractCandidateLocation(message.cleanText);
    if (!requestedLocation) {
      return {
        handled: true,
        reason: 'tool_missing_location',
        reply: '你要查哪个城市或地区？例如：北京、上海浦东、深圳南山。'
      };
    }

    try {
      const qweatherClient = new QWeatherClient(plugin);
      const locations = await qweatherClient.lookupCity(requestedLocation);
      const location = locations[0];

      if (!location) {
        return {
          handled: true,
          reason: 'tool_missing_location',
          reply: `没找到“${requestedLocation}”这个地点，你可以换一个更完整的城市或区县名称。`
        };
      }

      const [weatherNow, warnings, indices, airNow, sunriseSunset] = await Promise.all([
        qweatherClient.getWeatherNow(location.id),
        resolveOptionalToolCall('warning_now', () => qweatherClient.getWarningNow(location.id), [], {
          locationId: location.id,
          requestedLocation
        }),
        resolveOptionalToolCall('indices_1d', () => qweatherClient.getIndices(location.id, '1,3,5'), [], {
          locationId: location.id,
          requestedLocation
        }),
        resolveOptionalToolCall('air_now', () => qweatherClient.getAirNow(location.lat ?? '', location.lon ?? ''), null, {
          locationId: location.id,
          requestedLocation
        }),
        resolveOptionalToolCall(
          'astronomy_sun',
          () => qweatherClient.getSunriseSunset(location.id, formatDateForAstronomy(message.time * 1000)),
          null,
          {
            locationId: location.id,
            requestedLocation
          }
        )
      ]);

      return {
        handled: false,
        reason: 'tool_weather',
        toolContext: formatWeatherToolContext({
          location,
          requestedLocation,
          weatherNow,
          warnings,
          indices,
          airNow,
          sunriseSunset
        })
      };
    } catch (error) {
      logger.error({ err: error, text: message.cleanText }, 'Weather tool request failed');
      return {
        handled: true,
        reason: 'tool_error',
        reply: '天气服务暂时不可用，稍后再试。'
      };
    }
  }
}
