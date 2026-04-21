import axios, { type AxiosInstance } from 'axios';
import { config } from '../config/index.js';

/**
 * 和风天气客户端。
 *
 * 这个类故意只做“HTTP 协议适配”和“响应字段收敛”，不做聊天语义判断。
 * 目的是把第三方 API 的变动影响限制在这一层，reply/tool 层只消费稳定的业务字段。
 */
export interface QWeatherLocation {
  id: string;
  name: string;
  adm1?: string;
  adm2?: string;
  country?: string;
  lat?: string;
  lon?: string;
  tz?: string;
}

interface QWeatherResponseBase {
  code: string;
}

interface CityLookupResponse extends QWeatherResponseBase {
  location?: QWeatherLocation[];
}

export interface WeatherNow {
  obsTime?: string;
  temp?: string;
  feelsLike?: string;
  text?: string;
  windDir?: string;
  windScale?: string;
  humidity?: string;
  precip?: string;
  pressure?: string;
  vis?: string;
  cloud?: string;
  dew?: string;
}

interface WeatherNowResponse extends QWeatherResponseBase {
  now?: WeatherNow;
}

export interface WeatherWarning {
  id?: string;
  sender?: string;
  pubTime?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  level?: string;
  severity?: string;
  severityColor?: string;
  type?: string;
  typeName?: string;
  text?: string;
}

interface WeatherWarningResponse extends QWeatherResponseBase {
  warning?: WeatherWarning[];
}

export interface WeatherIndex {
  date?: string;
  type?: string;
  name?: string;
  level?: string;
  category?: string;
  text?: string;
}

interface WeatherIndicesResponse extends QWeatherResponseBase {
  daily?: WeatherIndex[];
}

export interface AirNow {
  pubTime?: string;
  aqi?: string;
  level?: string;
  category?: string;
  primary?: string;
  pm2p5?: string;
  pm10?: string;
  no2?: string;
  so2?: string;
  co?: string;
  o3?: string;
}

interface AirNowResponse extends QWeatherResponseBase {
  now?: AirNow;
}

export interface SunriseSunset {
  sunrise?: string;
  sunset?: string;
  moonrise?: string;
  moonset?: string;
}

interface AstronomyResponse extends QWeatherResponseBase {
  sunrise?: string;
  sunset?: string;
  moonrise?: string;
  moonset?: string;
}

function joinPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export class QWeatherClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      // 这里复用 AI_TIMEOUT_MS，而不是再拆一个更细的 WEATHER_TIMEOUT_MS，
      // 是因为当前项目的外部依赖很少，先保持配置面最小，避免为了一个工具过早引入过多环境变量。
      timeout: config.AI_TIMEOUT_MS,
      headers: {
        'X-QW-Api-Key': config.QWEATHER_API_KEY
      }
    });
  }

  /**
   * 统一封装 code 校验。
   *
   * 和风天气成功并不只看 HTTP 200，还要看业务层 `code` 是否等于 `200`。
   * 这里集中处理，避免上层每个接口都重复写一遍判错逻辑。
   */
  private async get<T extends QWeatherResponseBase>(path: string, params: Record<string, string>): Promise<T> {
    const response = await this.http.get<T>(joinPath(config.QWEATHER_API_HOST, path), {
      params: {
        ...params,
        lang: config.QWEATHER_LANG
      }
    });

    if (response.data.code !== '200') {
      throw new Error(`QWeather API returned code=${response.data.code} for ${path}`);
    }

    return response.data;
  }

  /**
   * 先做地点解析，再查天气明细。
   *
   * 聊天消息里的“北京”“浦东”“南山”都是自然语言地点，和风的大部分天气接口需要 `LocationID`，
   * 所以 GeoAPI 是所有天气子能力的统一前置步骤。
   */
  async lookupCity(location: string): Promise<QWeatherLocation[]> {
    const data = await this.get<CityLookupResponse>('/geo/v2/city/lookup', {
      location,
      number: '5',
      range: 'cn'
    });
    return data.location ?? [];
  }

  async getWeatherNow(locationId: string): Promise<WeatherNow | null> {
    const data = await this.get<WeatherNowResponse>('/v7/weather/now', { location: locationId });
    return data.now ?? null;
  }

  // 预警、指数、空气质量、日出日落拆成独立方法，是为了让 Tool Router 按需组合，
  // 后续如果想按用户意图裁剪调用范围，不需要改底层客户端。
  async getWarningNow(locationId: string): Promise<WeatherWarning[]> {
    const data = await this.get<WeatherWarningResponse>('/v7/warning/now', { location: locationId });
    return data.warning ?? [];
  }

  async getIndices(locationId: string, types: string): Promise<WeatherIndex[]> {
    const data = await this.get<WeatherIndicesResponse>('/v7/indices/1d', {
      location: locationId,
      type: types
    });
    return data.daily ?? [];
  }

  async getAirNow(locationId: string): Promise<AirNow | null> {
    const data = await this.get<AirNowResponse>('/v7/air/now', { location: locationId });
    return data.now ?? null;
  }

  async getSunriseSunset(locationId: string, date: string): Promise<SunriseSunset | null> {
    const data = await this.get<AstronomyResponse>('/v7/astronomy/sun', {
      location: locationId,
      date
    });
    return {
      sunrise: data.sunrise,
      sunset: data.sunset,
      moonrise: data.moonrise,
      moonset: data.moonset
    };
  }
}
