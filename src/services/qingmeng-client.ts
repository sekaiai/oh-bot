import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { config } from '../config/index.js';
import type {
  BotMessage,
  OutboundMessageSegment,
  QingmengEndpointConfig,
  QingmengPluginConfig
} from '../types/bot.js';

interface QingmengRequestResult {
  requestUrl: string;
  requestParams: Record<string, string>;
  responseUrl: string | null;
  status: number;
  contentType: string;
  payload: unknown;
}

export interface QingmengExecutionResult {
  replySummary: string;
  outboundMessage: string | OutboundMessageSegment[];
  diagnostics: Record<string, unknown>;
}

function getByPath(input: unknown, rawPath?: string): unknown {
  if (!rawPath || rawPath === '$self') {
    return input;
  }

  return rawPath.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }

    if (typeof current === 'object') {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, input);
}

function normalizeCountValue(value: string): string {
  const match = value.match(/\d+/);
  if (!match) {
    return '1';
  }

  const number = Number(match[0]);
  if (!Number.isFinite(number) || number <= 0) {
    return '1';
  }

  return String(Math.min(number, 10));
}

function normalizeTimeValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (['today', 'week', 'month', 'year'].includes(normalized)) {
    return normalized;
  }

  if (normalized.includes('周')) {
    return 'week';
  }

  if (normalized.includes('月')) {
    return 'month';
  }

  if (normalized.includes('年')) {
    return 'year';
  }

  return 'today';
}

function normalizeParamValue(name: string, value: string): string {
  if (!value.trim()) {
    return value;
  }

  if (name === 'count' || name === 'page') {
    return normalizeCountValue(value);
  }

  if (name === 'n' && /^\d+$/.test(value.trim())) {
    return normalizeCountValue(value);
  }

  if (name === 'time') {
    return normalizeTimeValue(value);
  }

  return value.trim();
}

function buildConstellationText(payload: Record<string, unknown>): string {
  const goodMatches = Array.isArray(payload.good_matches) ? payload.good_matches.join('、') : '未知';
  const fairMatches = Array.isArray(payload.fair_matches) ? payload.fair_matches.join('、') : '未知';
  const poorMatches = Array.isArray(payload.poor_matches) ? payload.poor_matches.join('、') : '未知';

  return [
    `${String(payload.constellation_name ?? '未知星座')} ${String(payload.time_period ?? 'today')} 运势`,
    `最佳配对：${String(payload.best_match ?? '未知')}`,
    `不错的配对：${goodMatches}`,
    `一般配对：${fairMatches}`,
    `需要留意：${poorMatches}`,
    `综合运势：${String(payload.general_fortune ?? '暂无')}`,
    `感情运势：${String(payload.love_fortune ?? '暂无')}`,
    `建议：${String(payload.love_advice ?? '暂无')}`
  ].join('\n');
}

function buildNewsText(title: string, items: unknown[], titlePath: string, urlPath: string): string {
  const lines = items
    .map((item, index) => {
      const titleValue = String(getByPath(item, titlePath) ?? '');
      const urlValue = String(getByPath(item, urlPath) ?? '');
      return `${index + 1}. ${titleValue}${urlValue ? `\n${urlValue}` : ''}`;
    })
    .filter((line) => line.trim());

  return [title, ...lines].join('\n\n');
}

function mediaSegmentType(group: QingmengEndpointConfig['group']): 'image' | 'video' | 'record' {
  if (group === 'video') {
    return 'video';
  }

  if (group === 'audio') {
    return 'record';
  }

  return 'image';
}

function resolveDisplayMode(endpoint: QingmengEndpointConfig): 'none' | 'fixed' {
  if (endpoint.displayMode) {
    return endpoint.displayMode;
  }

  if (endpoint.group === 'image' || endpoint.group === 'video' || endpoint.group === 'audio') {
    return 'none';
  }

  return 'fixed';
}

function resolveDisplayText(endpoint: QingmengEndpointConfig): string {
  const displayText = endpoint.displayText?.trim();
  if (displayText) {
    return displayText;
  }

  return endpoint.captionTemplate?.trim() || endpoint.name;
}

function buildMediaSegments(endpoint: QingmengEndpointConfig, files: string[]): OutboundMessageSegment[] {
  const segments: OutboundMessageSegment[] = [];
  if (resolveDisplayMode(endpoint) === 'fixed') {
    const displayText = resolveDisplayText(endpoint);
    if (displayText) {
      segments.push({
        type: 'text',
        data: {
          text: `${displayText}\n`
        }
      });
    }
  }

  for (const file of files) {
    if (!file) {
      continue;
    }

    segments.push({
      type: mediaSegmentType(endpoint.group),
      data: {
        file
      }
    });
  }

  return segments;
}

function toBase64File(buffer: Buffer): string {
  return `base64://${buffer.toString('base64')}`;
}

function resolveMediaFileValue(buffer: Buffer, tempFilePath: string): string {
  if (config.NAPCAT_MEDIA_SEND_MODE === 'local_path') {
    return tempFilePath;
  }

  if (config.NAPCAT_MEDIA_SEND_MODE === 'file_url') {
    return `file://${tempFilePath}`;
  }

  return toBase64File(buffer);
}

async function writeTempMediaFile(buffer: Buffer, contentType: string, responseUrl: string | null): Promise<string> {
  const extFromType = contentType.split('/')[1]?.split(';')[0]?.trim();
  const extFromUrl = responseUrl ? path.extname(new URL(responseUrl).pathname).replace('.', '') : '';
  const ext = extFromType || extFromUrl || 'bin';
  const tempDir = config.NAPCAT_MEDIA_TEMP_DIR
    ? path.resolve(config.NAPCAT_MEDIA_TEMP_DIR)
    : path.join(os.tmpdir(), 'oh-bot-qingmeng');
  await mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  await writeFile(filePath, buffer);
  return filePath;
}

function toBuffer(value: ArrayBuffer | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(new Uint8Array(value));
}

function tryParseJsonPayload(value: unknown): unknown | null {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof ArrayBuffer)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    return JSON.parse(trimmed);
  }

  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer) {
    const text = toBuffer(value).toString('utf-8').trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      return null;
    }

    return JSON.parse(text);
  }

  return null;
}

function hasSupportedImageExtension(value: string): boolean {
  return /\.(jpg|jpeg|png|gif)(?:$|[?#])/iu.test(value);
}

function inferImageExtensionFromContentType(contentType: string): string | null {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  if (!normalized.startsWith('image/')) {
    return null;
  }

  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'jpg';
  }

  if (normalized === 'image/png') {
    return 'png';
  }

  if (normalized === 'image/gif') {
    return 'gif';
  }

  return null;
}

async function normalizeRemoteImageUrl(rawUrl: string): Promise<string> {
  const trimmed = rawUrl.trim();
  if (!trimmed || hasSupportedImageExtension(trimmed)) {
    return trimmed;
  }

  try {
    new URL(trimmed);
  } catch {
    return trimmed;
  }

  try {
    const response = await axios.get(trimmed, {
      responseType: 'stream',
      timeout: 10_000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    const contentType = String(response.headers['content-type'] ?? '');
    response.data.destroy();

    const extension = inferImageExtensionFromContentType(contentType);
    if (!extension) {
      return trimmed;
    }

    return `${trimmed}#image.${extension}`;
  } catch {
    return trimmed;
  }
}

export class QingmengClient {
  constructor(private readonly plugin: QingmengPluginConfig) {}

  buildRequestParams(
    endpoint: QingmengEndpointConfig,
    intentParams: Record<string, string>,
    messageImageUrls: string[],
    fallbackInput = '',
    fallbackImageUrl = ''
  ): Record<string, string> {
    const params: Record<string, string> = {};

    for (const parameter of endpoint.parameters) {
      let value = parameter.defaultValue;

      if (parameter.source === 'intent') {
        value = intentParams[parameter.name] ?? fallbackInput ?? parameter.defaultValue;
      }

      if (parameter.source === 'image_url') {
        value = messageImageUrls[0] ?? fallbackImageUrl ?? parameter.defaultValue;
      }

      value = normalizeParamValue(parameter.name, value);

      if (value) {
        params[parameter.name] = value;
      }
    }

    params.ckey = this.plugin.ckey;
    return params;
  }

  private async requestEndpoint(endpoint: QingmengEndpointConfig, params: Record<string, string>): Promise<QingmengRequestResult> {
    const normalizedParams = { ...params };

    for (const parameter of endpoint.parameters) {
      if (parameter.source !== 'image_url') {
        continue;
      }

      const currentValue = normalizedParams[parameter.name];
      if (!currentValue) {
        continue;
      }

      normalizedParams[parameter.name] = await normalizeRemoteImageUrl(currentValue);
    }

    const response = await axios.get<ArrayBuffer | Record<string, unknown>>(endpoint.url, {
      params: normalizedParams,
      responseType: endpoint.responseMode === 'redirect_media' ? 'arraybuffer' : 'json',
      timeout: 20_000,
      maxRedirects: 5,
      headers: {
        ckey: this.plugin.ckey
      },
      validateStatus: () => true
    });

    const contentType = String(response.headers['content-type'] ?? '');
    const responseUrl = typeof response.request?.res?.responseUrl === 'string' ? response.request.res.responseUrl : null;
    const parsedPayload = tryParseJsonPayload(response.data);

    if (contentType.includes('application/json') || (endpoint.responseMode !== 'redirect_media' && parsedPayload !== null)) {
      const payload = parsedPayload ?? response.data;
      const code = Number((payload as Record<string, unknown>)?.code ?? 200);
      if (response.status >= 400 || code >= 203) {
        const message = String((payload as Record<string, unknown>)?.msg ?? (payload as Record<string, unknown>)?.message ?? '倾梦接口调用失败');
        throw new Error(message);
      }

      return {
        requestUrl: endpoint.url,
        requestParams: normalizedParams,
        responseUrl,
        status: response.status,
        contentType,
        payload
      };
    }

    if (response.status >= 400) {
      throw new Error(`倾梦接口请求失败，HTTP ${response.status}`);
    }

    return {
      requestUrl: endpoint.url,
      requestParams: normalizedParams,
      responseUrl,
      status: response.status,
      contentType,
      payload: toBuffer(response.data as ArrayBuffer | Buffer)
    };
  }

  async executeEndpoint(
    endpoint: QingmengEndpointConfig,
    params: Record<string, string>
  ): Promise<QingmengExecutionResult> {
    const result = await this.requestEndpoint(endpoint, params);

    if (endpoint.responseMode === 'openai_text') {
      const text = String(getByPath(result.payload, endpoint.responsePath) ?? '').trim();
      return {
        replySummary: text,
        outboundMessage: text,
        diagnostics: {
          endpointId: endpoint.id,
          params: result.requestParams,
          responsePreview: text
        }
      };
    }

    if (endpoint.responseMode === 'json_value') {
      const value = getByPath(result.payload, endpoint.responsePath);

      if (endpoint.id === 'constellation-match' && value && typeof value === 'object') {
        const text = buildConstellationText(value as Record<string, unknown>);
        return {
          replySummary: text,
          outboundMessage: text,
          diagnostics: {
            endpointId: endpoint.id,
            params: result.requestParams,
            payload: value
          }
        };
      }

      const resolvedValue = String(value ?? '').trim();
      if (!resolvedValue) {
        throw new Error('倾梦接口返回为空');
      }

      if (endpoint.group === 'text' || endpoint.group === 'tool' || endpoint.group === 'analysis') {
        return {
          replySummary: resolvedValue,
          outboundMessage: resolvedValue,
          diagnostics: {
            endpointId: endpoint.id,
            params: result.requestParams,
            value: resolvedValue
          }
        };
      }

      const segments = buildMediaSegments(endpoint, [resolvedValue]);

      return {
        replySummary: resolveDisplayText(endpoint),
        outboundMessage: segments,
        diagnostics: {
          endpointId: endpoint.id,
          params: result.requestParams,
          value: resolvedValue
        }
      };
    }

    if (endpoint.responseMode === 'json_list') {
      const items = getByPath(result.payload, endpoint.listPath);
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('倾梦接口未返回可用数据');
      }

      if (endpoint.group === 'text' || endpoint.group === 'tool') {
        const text = buildNewsText(
          endpoint.captionTemplate || endpoint.name,
          items,
          endpoint.itemTitlePath || 'title',
          endpoint.itemUrlPath || 'url'
        );
        return {
          replySummary: text,
          outboundMessage: text,
          diagnostics: {
            endpointId: endpoint.id,
            params: result.requestParams,
            itemCount: items.length
          }
        };
      }

      const files = items
        .map((item) =>
          typeof item === 'string'
            ? item
            : String(getByPath(item, endpoint.itemUrlPath || 'url') ?? '').trim()
        )
        .filter((item) => item.trim());
      const segments = buildMediaSegments(endpoint, files);

      const mediaSegmentCount = segments.filter((segment) => segment.type !== 'text').length;
      if (mediaSegmentCount === 0) {
        throw new Error('倾梦接口返回了列表，但没有可发送的媒体资源');
      }

      return {
        replySummary: `${resolveDisplayText(endpoint)}，共 ${items.length} 项`,
        outboundMessage: segments,
        diagnostics: {
          endpointId: endpoint.id,
          params: result.requestParams,
          itemCount: items.length
        }
      };
    }

    const payload = result.payload;
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload as ArrayBuffer);
    const safeResponseUrl = result.responseUrl && !result.responseUrl.includes('ckey=') ? result.responseUrl : null;
    let file = safeResponseUrl;

    if (!file) {
      const tempFilePath = await writeTempMediaFile(buffer, result.contentType, result.responseUrl);
      file = resolveMediaFileValue(buffer, tempFilePath);
    }

    const segments = buildMediaSegments(endpoint, [file]);

    return {
      replySummary: resolveDisplayText(endpoint),
      outboundMessage: segments,
      diagnostics: {
        endpointId: endpoint.id,
        params: result.requestParams,
        status: result.status,
        contentType: result.contentType,
        responseUrl: result.responseUrl
      }
    };
  }
}
