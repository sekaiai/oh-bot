import type { BotMessage, ReplyDecision } from '../types/bot.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  QWeatherClient,
  type AirNow,
  type QWeatherLocation,
  type SunriseSunset,
  type WeatherIndex,
  type WeatherNow,
  type WeatherWarning
} from './qweather-client.js';

/**
 * 天气工具聚合结果。
 *
 * 这里保留“原始但已收敛”的结构，而不是直接拼最终回复，
 * 是为了让 LLM 继续负责自然语言组织，工具层只负责保证事实来源可靠。
 */
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

// 第一版用关键词而不是模型分类，目的是降低时延和实现复杂度。
// 天气类请求语义相对集中，用规则先挡一层，足够覆盖大多数“查天气/查空气/查预警”场景。
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

// 这里维护的是“地点提取时应该剥离掉的功能词”。
// 这样做不是为了做完美 NLU，而是把最常见的聊天表达压缩成可送给 GeoAPI 的地点短语。
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

/**
 * 从自然语言里提取地点候选词。
 *
 * 这里故意保持轻量规则：
 * 1. 首版目标是快速上线天气能力，而不是做完整中文地名解析；
 * 2. 失败时可以安全退化为“追问地点”，不会像瞎猜地点那样产生错误事实。
 */
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

/**
 * 把多接口结果整理成供 LLM 消费的工具上下文。
 *
 * 这里使用“半结构化文本”而不是再定义更复杂的 JSON schema，
 * 是因为当前 `AiClient` 本来就是文本 prompt 模式，这样接入成本最低，也更便于日志排查。
 */
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

// 和风天文接口要求 `yyyyMMdd`，这里统一转换，避免上层关心第三方接口的日期格式细节。
function formatDateForAstronomy(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export class ToolRouter {
  private readonly qweatherClient = new QWeatherClient();

  /**
   * 统一处理“是否要走工具”以及“工具如何兜底”。
   *
   * 返回值设计成 `ToolResolution`，是为了把三种结果都收敛到一个出口：
   * - 不需要工具，继续走原来的 AI 链路；
   * - 工具已给出直接回复，比如缺地点或未配置 Key；
   * - 工具查到了数据，把结果交还给 AI 组织自然回复。
   */
  async resolve(message: BotMessage): Promise<ToolResolution> {
    if (!looksLikeWeatherRequest(message.cleanText)) {
      return { handled: false };
    }

    // 缺少 API Key 时直接短路，而不是继续让模型“假装知道天气”，
    // 这样能明确暴露配置问题，也能保证实时信息永远来自真实外部数据。
    if (!config.QWEATHER_API_KEY) {
      return {
        handled: true,
        reason: 'tool_error',
        reply: '还没有配置和风天气 API Key，先在环境变量里设置 `QWEATHER_API_KEY`。'
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
      const locations = await this.qweatherClient.lookupCity(requestedLocation);
      const location = locations[0];

      // 第一版先取最匹配的一条结果，优先保证交互简洁。
      // 如果后续发现“同名地点歧义”很多，再扩展成候选地点澄清流程。
      if (!location) {
        return {
          handled: true,
          reason: 'tool_missing_location',
          reply: `没找到“${requestedLocation}”这个地点，你可以换一个更完整的城市或区县名称。`
        };
      }

      const [weatherNow, warnings, indices, airNow, sunriseSunset] = await Promise.all([
        this.qweatherClient.getWeatherNow(location.id),
        this.qweatherClient.getWarningNow(location.id),
        // 这里预取一组常用指数，是为了覆盖“天气指数”这一泛化需求，
        // 避免用户问紫外线、穿衣、洗车时还要再做二次工具调用。
        this.qweatherClient.getIndices(location.id, '1,2,3,5,8,9,10,15,16'),
        this.qweatherClient.getAirNow(location.id),
        this.qweatherClient.getSunriseSunset(location.id, formatDateForAstronomy(message.time))
      ]);

      const context = formatWeatherToolContext({
        location,
        requestedLocation,
        weatherNow,
        warnings,
        indices,
        airNow,
        sunriseSunset
      });

      return {
        handled: true,
        reason: 'tool_weather',
        toolContext: context
      };
    } catch (error) {
      // 这里统一吞掉工具异常并回一个稳定文案，
      // 是因为对聊天机器人来说，“可解释的失败”比把第三方异常直接抛给用户更重要。
      logger.error({ err: error, text: message.cleanText }, 'Weather tool failed');
      return {
        handled: true,
        reason: 'tool_error',
        reply: '天气查询失败了，可能是和风天气接口或网络暂时不可用，稍后再试。'
      };
    }
  }
}
