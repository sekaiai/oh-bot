import type {
  BotMessage,
  Ds2ApiPluginConfig,
  PersonaConfig,
  PluginConfig,
  QWeatherPluginConfig,
  ReplyDecision,
  SessionMessage
} from '../types/bot.js';
import { logger } from '../utils/logger.js';
import { AiClient } from './ai-client.js';
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

function matchDs2ApiPlugin(text: string, plugins: PluginConfig[]): Ds2ApiPluginConfig | undefined {
  const normalized = text.toLowerCase();
  return plugins.find((plugin): plugin is Ds2ApiPluginConfig => {
    if (plugin.kind !== 'ds2api' || !plugin.enabled || plugin.triggerKeywords.length === 0) {
      return false;
    }

    return plugin.triggerKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
  });
}

function findQWeatherPlugin(plugins: PluginConfig[]): QWeatherPluginConfig | undefined {
  return plugins.find((plugin): plugin is QWeatherPluginConfig => plugin.kind === 'qweather');
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
    if (looksLikeWeatherRequest(message.cleanText)) {
      if (!qweatherPlugin?.enabled) {
        return {
          handled: true,
          reason: 'tool_error',
          reply: '和风天气插件当前未启用，请先在后台打开插件或补全配置。'
        };
      }

      return this.resolveWeather(message, qweatherPlugin);
    }

    const ds2apiPlugin = matchDs2ApiPlugin(message.cleanText, plugins);
    if (!ds2apiPlugin) {
      return { handled: false };
    }

    if (!ds2apiPlugin.apiKey) {
      return {
        handled: true,
        reason: 'tool_error',
        reply: `插件「${ds2apiPlugin.name}」还没有配置 API Key，请先在后台补全。`
      };
    }

    try {
      const reply = await this.aiClient.generateRoutedReply(message, contextMessages, persona, ds2apiPlugin);
      return {
        handled: true,
        reason: 'tool_ds2api',
        reply
      };
    } catch (error) {
      logger.error({ err: error, pluginId: ds2apiPlugin.id }, 'DS2API plugin request failed');
      return {
        handled: true,
        reason: 'tool_error',
        reply: `插件「${ds2apiPlugin.name}」当前调用失败，请稍后再试。`
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
