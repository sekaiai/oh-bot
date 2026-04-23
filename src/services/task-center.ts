import { CronExpressionParser } from 'cron-parser';
import type { NapcatSender } from '../adapters/napcat/sender.js';
import { config } from '../config/index.js';
import type {
  OutboundMessageContent,
  OutboundMessageSegment,
  PluginConfig,
  QingmengPluginConfig,
  QWeatherPluginConfig,
  ScheduledTask,
  ScheduledTaskExecutionLog,
  ScheduledTaskExecutionTargetResult
} from '../types/bot.js';
import { logger } from '../utils/logger.js';
import { AiClient } from './ai-client.js';
import { loadPluginConfigs, loadScheduledTasks, saveScheduledTasks } from './data-repository.js';
import { QingmengClient } from './qingmeng-client.js';
import { QWeatherClient } from './qweather-client.js';

const MAX_TASK_LOGS = 20;

function formatScheduledWeatherText(input: {
  locationName: string;
  weatherText?: string;
  temp?: string;
  feelsLike?: string;
  humidity?: string;
  windDir?: string;
  windScale?: string;
  aqi?: string;
  aqiCategory?: string;
  warnings: string[];
}): string {
  const parts = [
    `${input.locationName}天气`,
    input.weatherText ? `${input.weatherText}` : '天气信息待更新',
    input.temp ? `${input.temp}C` : '',
    input.feelsLike ? `体感 ${input.feelsLike}C` : '',
    input.humidity ? `湿度 ${input.humidity}%` : '',
    input.windDir ? `${input.windDir}${input.windScale ? ` ${input.windScale}级` : ''}` : ''
  ].filter(Boolean);

  const lines = [parts.join(' | ')];

  if (input.aqi) {
    lines.push(`空气质量：AQI ${input.aqi}${input.aqiCategory ? `，${input.aqiCategory}` : ''}`);
  }

  if (input.warnings.length > 0) {
    lines.push(`预警：${input.warnings.join('；')}`);
  }

  return lines.join('\n');
}

function composeScheduledMessage(
  messageTemplate: string,
  pluginContent?: OutboundMessageContent
): OutboundMessageContent {
  const prefix = messageTemplate.trim();
  if (!pluginContent) {
    return prefix;
  }

  if (!prefix) {
    return pluginContent;
  }

  if (typeof pluginContent === 'string') {
    return `${prefix}\n\n${pluginContent}`.trim();
  }

  const segments: OutboundMessageSegment[] = [
    {
      type: 'text',
      data: {
        text: `${prefix}\n`
      }
    },
    ...pluginContent
  ];

  return segments;
}

function pickPlugin<T extends PluginConfig['kind']>(
  plugins: PluginConfig[],
  kind: T
): Extract<PluginConfig, { kind: T }> | undefined {
  return plugins.find((plugin): plugin is Extract<PluginConfig, { kind: T }> => plugin.kind === kind);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function resolveJitterOffset(task: ScheduledTask, scheduledFor: string): number {
  if (task.jitterSeconds <= 0) {
    return 0;
  }

  return hashString(`${task.id}:${scheduledFor}`) % (task.jitterSeconds + 1);
}

function collectDueOccurrences(task: ScheduledTask, windowStart: number, windowEnd: number): string[] {
  if (!task.enabled) {
    return [];
  }

  const due: string[] = [];
  const iterator = CronExpressionParser.parse(task.cronExpression, {
    currentDate: new Date(Math.max(0, windowStart - 1000)),
    endDate: new Date(windowEnd),
    tz: task.timezone || 'Asia/Shanghai'
  });

  while (true) {
    let nextDate;

    try {
      nextDate = iterator.next();
    } catch {
      break;
    }

    const scheduledAt = nextDate.toDate();
    const jitterOffset = resolveJitterOffset(task, scheduledAt.toISOString()) * 1000;
    const jitteredAt = scheduledAt.getTime() + jitterOffset;

    if (jitteredAt >= windowStart && jitteredAt <= windowEnd) {
      due.push(new Date(jitteredAt).toISOString());
    }
  }

  return due;
}

function resolveTaskStatus(results: ScheduledTaskExecutionTargetResult[]): {
  status: ScheduledTaskExecutionLog['status'];
  message: string;
} {
  const successCount = results.filter((item) => item.ok).length;
  if (successCount === results.length) {
    return {
      status: 'success',
      message: `发送成功，共 ${successCount} 个目标`
    };
  }

  if (successCount > 0) {
    return {
      status: 'partial',
      message: `部分成功，成功 ${successCount} / ${results.length}`
    };
  }

  return {
    status: 'failed',
    message: '发送失败，所有目标都未成功'
  };
}

async function buildQWeatherTaskContent(
  plugin: QWeatherPluginConfig,
  payload: Record<string, unknown>
): Promise<OutboundMessageContent> {
  const location = String(payload.location ?? '').trim();
  if (!location) {
    throw new Error('天气任务缺少 location');
  }

  const client = new QWeatherClient(plugin);
  const locations = await client.lookupCity(location);
  const selected = locations[0];
  if (!selected) {
    throw new Error(`未找到地点：${location}`);
  }

  const [weatherNow, warnings, airNow] = await Promise.all([
    client.getWeatherNow(selected.id),
    client.getWarningNow(selected.id).catch(() => []),
    selected.lat && selected.lon ? client.getAirNow(selected.lat, selected.lon).catch(() => null) : Promise.resolve(null)
  ]);

  const locationName = [selected.name, selected.adm2, selected.adm1].filter(Boolean).join(' ');
  return formatScheduledWeatherText({
    locationName,
    weatherText: weatherNow?.text,
    temp: weatherNow?.temp,
    feelsLike: weatherNow?.feelsLike,
    humidity: weatherNow?.humidity,
    windDir: weatherNow?.windDir,
    windScale: weatherNow?.windScale,
    aqi: airNow?.aqi,
    aqiCategory: airNow?.category ?? airNow?.level,
    warnings: warnings.slice(0, 2).map((warning) => warning.title ?? warning.typeName ?? '天气预警')
  });
}

async function buildQingmengTaskContent(
  plugin: QingmengPluginConfig,
  payload: Record<string, unknown>
): Promise<OutboundMessageContent> {
  const endpointId = String(payload.endpointId ?? '').trim();
  if (!endpointId) {
    throw new Error('倾梦任务缺少 endpointId');
  }

  const endpoint = plugin.endpoints.find((item) => item.id === endpointId && item.enabled);
  if (!endpoint) {
    throw new Error(`未找到启用中的倾梦接口：${endpointId}`);
  }

  const client = new QingmengClient(plugin);
  const input = String(payload.input ?? '').trim();
  const imageUrl = String(payload.imageUrl ?? '').trim();
  const params = payload.params && typeof payload.params === 'object' ? payload.params as Record<string, unknown> : {};
  const intentParams = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, String(value ?? '')])
  );
  const requestParams = client.buildRequestParams(endpoint, intentParams, imageUrl ? [imageUrl] : [], input, imageUrl);
  const result = await client.executeEndpoint(endpoint, requestParams);
  return result.outboundMessage;
}

async function buildDs2ApiTaskContent(
  plugin: Extract<PluginConfig, { kind: 'ds2api' }>,
  payload: Record<string, unknown>
): Promise<OutboundMessageContent> {
  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('DS2API 任务缺少 prompt');
  }

  const routeId = String(payload.routeId ?? '').trim();
  const enabledRoutes = plugin.routes.filter((item) => item.enabled);
  const route = routeId
    ? enabledRoutes.find((item) => item.id === routeId) ?? enabledRoutes[0]
    : enabledRoutes[0];

  if (!route) {
    throw new Error('DS2API 没有可用路由');
  }

  const aiClient = new AiClient();
  return aiClient.generateScheduledTaskText(plugin, route, prompt);
}

async function buildPluginContent(task: ScheduledTask, plugins: PluginConfig[]): Promise<OutboundMessageContent | undefined> {
  if (!task.pluginId) {
    return undefined;
  }

  const payload = task.pluginPayload && typeof task.pluginPayload === 'object' ? task.pluginPayload : {};
  if (task.pluginId === 'qweather') {
    const plugin = pickPlugin(plugins, 'qweather');
    if (!plugin?.enabled || !plugin.apiKey) {
      throw new Error('和风天气插件未启用或未配置 Key');
    }

    return buildQWeatherTaskContent(plugin, payload);
  }

  if (task.pluginId === 'qingmeng') {
    const plugin = pickPlugin(plugins, 'qingmeng');
    if (!plugin?.enabled || !plugin.ckey) {
      throw new Error('倾梦插件未启用或未配置 CKEY');
    }

    return buildQingmengTaskContent(plugin, payload);
  }

  if (task.pluginId === 'ds2api') {
    const plugin = pickPlugin(plugins, 'ds2api');
    if (!plugin?.enabled || !plugin.apiKey) {
      throw new Error('DS2API 插件未启用或未配置 Key');
    }

    return buildDs2ApiTaskContent(plugin, payload);
  }

  return undefined;
}

export async function executeScheduledTask(
  task: ScheduledTask,
  sender: NapcatSender
): Promise<ScheduledTaskExecutionLog> {
  const plugins = await loadPluginConfigs();
  const pluginContent = await buildPluginContent(task, plugins);
  const outboundMessage = composeScheduledMessage(task.messageTemplate, pluginContent);
  if ((typeof outboundMessage === 'string' && !outboundMessage.trim()) || (Array.isArray(outboundMessage) && outboundMessage.length === 0)) {
    throw new Error('任务没有可发送的内容');
  }

  const results: ScheduledTaskExecutionTargetResult[] = [];
  for (const target of task.targets) {
    try {
      await sender.sendMessage({
        chatType: target.chatType,
        userId: target.chatType === 'private' ? target.targetId : undefined,
        groupId: target.chatType === 'group' ? target.targetId : undefined,
        message: outboundMessage
      });

      results.push({
        chatType: target.chatType,
        targetId: target.targetId,
        displayName: target.displayName,
        ok: true
      });
    } catch (error) {
      results.push({
        chatType: target.chatType,
        targetId: target.targetId,
        displayName: target.displayName,
        ok: false,
        error: error instanceof Error ? error.message : '发送失败'
      });
    }
  }

  const summary = resolveTaskStatus(results);
  return {
    id: `${task.id}-${Date.now()}`,
    scheduledFor: new Date().toISOString(),
    executedAt: Math.floor(Date.now() / 1000),
    status: summary.status,
    message: summary.message,
    results
  };
}

export async function persistTaskExecution(taskId: string, log: ScheduledTaskExecutionLog, scheduledFor?: string): Promise<void> {
  const tasks = await loadScheduledTasks();
  const nextTasks = tasks.map((task) => {
    if (task.id !== taskId) {
      return task;
    }

    return {
      ...task,
      lastRunAt: log.executedAt,
      lastRunScheduledFor: scheduledFor ?? log.scheduledFor,
      lastRunStatus: log.status,
      lastRunMessage: log.message,
      logs: [log, ...task.logs].slice(0, MAX_TASK_LOGS)
    };
  });

  await saveScheduledTasks(nextTasks);
}

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastCheckedAt = Date.now();

  constructor(private readonly sender: NapcatSender) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.lastCheckedAt = Date.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.TASK_CENTER_POLL_MS);
    logger.info({ pollMs: config.TASK_CENTER_POLL_MS }, 'Task scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    const windowStart = this.lastCheckedAt;
    const windowEnd = Date.now();
    this.lastCheckedAt = windowEnd;

    try {
      const tasks = await loadScheduledTasks();
      for (const task of tasks.filter((item) => item.enabled)) {
        let dueOccurrences: string[] = [];

        try {
          dueOccurrences = collectDueOccurrences(task, windowStart, windowEnd)
            .filter((scheduledFor) => scheduledFor !== task.lastRunScheduledFor);
        } catch (error) {
          logger.error({ err: error, taskId: task.id }, 'Scheduled task cron parsing failed');
          continue;
        }

        for (const scheduledFor of dueOccurrences) {
          try {
            const log = await executeScheduledTask(task, this.sender);
            const nextLog = {
              ...log,
              scheduledFor
            };
            await persistTaskExecution(task.id, nextLog, scheduledFor);
            logger.info({ taskId: task.id, scheduledFor, status: nextLog.status }, 'Scheduled task executed');
          } catch (error) {
            const failedLog: ScheduledTaskExecutionLog = {
              id: `${task.id}-${Date.now()}`,
              scheduledFor,
              executedAt: Math.floor(Date.now() / 1000),
              status: 'failed',
              message: error instanceof Error ? error.message : '任务执行失败',
              results: []
            };
            await persistTaskExecution(task.id, failedLog, scheduledFor);
            logger.error({ err: error, taskId: task.id, scheduledFor }, 'Scheduled task execution failed');
          }
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}
