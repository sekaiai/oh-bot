import axios, { type AxiosInstance } from 'axios';
import { config } from '../config/index.js';
import type { QWeatherPluginConfig } from '../types/bot.js';
import { logger } from '../utils/logger.js';

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

interface AirQualityIndex {
  code?: string;
  name?: string;
  aqi?: number;
  aqiDisplay?: string;
  level?: string;
  category?: string;
  primaryPollutant?: {
    code?: string;
    name?: string;
    fullName?: string;
  } | null;
}

interface AirQualityPollutant {
  code?: string;
  concentration?: {
    value?: number;
    unit?: string;
  };
}

interface AirNowResponse {
  metadata?: {
    tag?: string;
  };
  indexes?: AirQualityIndex[];
  pollutants?: AirQualityPollutant[];
  stations?: Array<{
    id?: string;
    name?: string;
  }>;
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
  private readonly plugin: QWeatherPluginConfig;

  constructor(plugin: QWeatherPluginConfig) {
    this.plugin = plugin;
    this.http = axios.create({
      timeout: config.AI_TIMEOUT_MS,
      headers: {
        'X-QW-Api-Key': plugin.apiKey
      }
    });
  }

  private async get<T extends QWeatherResponseBase>(path: string, params: Record<string, string>): Promise<T> {
    const response = await this.http.get<T>(joinPath(this.plugin.apiHost, path), {
      params: {
        ...params,
        lang: this.plugin.lang
      }
    });

    if (response.data.code !== '200') {
      throw new Error(`QWeather API returned code=${response.data.code} for ${path}`);
    }

    return response.data;
  }

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

  async probeLocation(location: string): Promise<{
    selectedLocation: QWeatherLocation | null;
    lookup: CityLookupResponse;
    weatherNow: WeatherNowResponse | null;
  }> {
    const lookup = await this.get<CityLookupResponse>('/geo/v2/city/lookup', {
      location,
      number: '5',
      range: 'cn'
    });

    const selectedLocation = lookup.location?.[0] ?? null;
    if (!selectedLocation) {
      return {
        selectedLocation: null,
        lookup,
        weatherNow: null
      };
    }

    const weatherNow = await this.get<WeatherNowResponse>('/v7/weather/now', {
      location: selectedLocation.id
    });

    return {
      selectedLocation,
      lookup,
      weatherNow
    };
  }

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

  async getAirNow(latitude: string, longitude: string): Promise<AirNow | null> {
    if (!latitude || !longitude) {
      return null;
    }

    return this.getAirNowByCoordinates(latitude, longitude);
  }

  async getAirNowByCoordinates(latitude: string, longitude: string): Promise<AirNow | null> {
    const response = await this.http.get<AirNowResponse>(
      joinPath(this.plugin.apiHost, `/airquality/v1/current/${latitude}/${longitude}`),
      {
        params: {
          lang: this.plugin.lang
        }
      }
    );

    const primaryIndex = response.data.indexes?.[0];
    const pollutants = new Map(
      (response.data.pollutants ?? []).map((item) => [item.code ?? '', item.concentration?.value])
    );

    if (!primaryIndex) {
      return null;
    }

    return {
      aqi: primaryIndex.aqiDisplay ?? String(primaryIndex.aqi ?? ''),
      level: primaryIndex.level,
      category: primaryIndex.category,
      primary: primaryIndex.primaryPollutant?.name ?? primaryIndex.primaryPollutant?.code,
      pm2p5: pollutants.get('pm2p5')?.toString(),
      pm10: pollutants.get('pm10')?.toString(),
      no2: pollutants.get('no2')?.toString(),
      so2: pollutants.get('so2')?.toString(),
      co: pollutants.get('co')?.toString(),
      o3: pollutants.get('o3')?.toString()
    };
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
