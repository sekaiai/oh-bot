import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';

export const ruleConfigSchema = z.object({
  admins: z.array(z.string()),
  whitelistGroups: z.array(z.string()),
  blacklistUsers: z.array(z.string()),
  privateBlacklist: z.array(z.string()),
  groupBlacklist: z.array(z.string()),
  botNames: z.array(z.string().min(1)),
  requireAtInGroup: z.boolean(),
  aiEnabled: z.boolean(),
  commandPrefix: z.string().min(1),
  cooldownSeconds: z.number().int().min(0)
});

export const loginSchema = z.object({
  password: z.string().min(1)
});

const aiEndpointSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive()
});

const ds2apiRouteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  model: z.string().min(1),
  intentPrompt: z.string().min(1),
  systemPrompt: z.string(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive()
});

const ds2apiPluginSchema = aiEndpointSchema.omit({ model: true }).extend({
  id: z.string().min(1),
  kind: z.literal('ds2api'),
  name: z.string().min(1),
  enabled: z.boolean(),
  routes: z.array(ds2apiRouteSchema).min(1)
});

const qweatherPluginSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('qweather'),
  name: z.string().min(1),
  enabled: z.boolean(),
  apiHost: z.string().url(),
  apiKey: z.string(),
  lang: z.string().min(1)
});

const qingmengParameterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  source: z.enum(['fixed', 'intent', 'image_url']),
  required: z.boolean(),
  defaultValue: z.string()
});

const qingmengEndpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  group: z.enum(['image', 'video', 'audio', 'text', 'tool', 'analysis']),
  description: z.string().min(1),
  intentAliases: z.array(z.string().min(1)),
  fallbackEligible: z.boolean(),
  method: z.literal('GET'),
  url: z.string().url(),
  intentPrompt: z.string().min(1),
  parameters: z.array(qingmengParameterSchema),
  responseMode: z.enum(['json_value', 'json_list', 'openai_text', 'redirect_media']),
  responsePath: z.string().optional(),
  listPath: z.string().optional(),
  itemTitlePath: z.string().optional(),
  itemUrlPath: z.string().optional(),
  displayMode: z.enum(['none', 'fixed']).optional(),
  displayText: z.string().optional(),
  captionTemplate: z.string().optional(),
  sampleInput: z.string(),
  sampleImageUrl: z.string().url().optional().or(z.literal(''))
});

const qingmengPluginSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('qingmeng'),
  name: z.string().min(1),
  enabled: z.boolean(),
  ckey: z.string(),
  classifierPrompt: z.string().min(1),
  endpoints: z.array(qingmengEndpointSchema)
});

export const pluginConfigSchema = z.discriminatedUnion('kind', [ds2apiPluginSchema, qweatherPluginSchema, qingmengPluginSchema]);

export const pluginTestSchema = z.object({
  plugin: pluginConfigSchema,
  input: z.string().optional().default(''),
  endpointId: z.string().optional(),
  routeId: z.string().optional(),
  imageUrl: z.string().optional()
});

export const sessionSettingsSchema = z.object({
  chatKey: z.string().regex(/^(group|private):[^:\s]+$/, 'chatKey 格式不合法'),
  status: z.enum(['available', 'banned'])
});

const taskTargetSchema = z.object({
  chatType: z.enum(['group', 'private']),
  targetId: z.string().min(1),
  displayName: z.string().min(1)
});

const cronExpressionSchema = z.string().min(1).superRefine((value, ctx) => {
  try {
    CronExpressionParser.parse(value, {
      currentDate: new Date(),
      tz: 'Asia/Shanghai'
    });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Cron 表达式不合法'
    });
  }
});

const taskExecutionTargetResultSchema = z.object({
  chatType: z.enum(['group', 'private']),
  targetId: z.string().min(1),
  displayName: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional()
});

const taskExecutionLogSchema = z.object({
  id: z.string().min(1),
  scheduledFor: z.string().min(1),
  executedAt: z.number().int().positive(),
  status: z.enum(['success', 'partial', 'failed']),
  message: z.string().min(1),
  results: z.array(taskExecutionTargetResultSchema)
});

export const scheduledTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  cronExpression: cronExpressionSchema,
  timezone: z.string().min(1),
  jitterSeconds: z.number().int().min(0).max(86400),
  messageTemplate: z.string(),
  pluginId: z.enum(['', 'ds2api', 'qweather', 'qingmeng']).optional(),
  pluginPayload: z.record(z.string(), z.unknown()).optional().default({}),
  targets: z.array(taskTargetSchema).min(1),
  lastRunAt: z.number().int().positive().optional(),
  lastRunScheduledFor: z.string().optional(),
  lastRunStatus: z.enum(['success', 'partial', 'failed']).optional(),
  lastRunMessage: z.string().optional(),
  logs: z.array(taskExecutionLogSchema).max(20).default([])
}).superRefine((value, ctx) => {
  const hasPlugin = Boolean(value.pluginId);
  const hasText = value.messageTemplate.trim().length > 0;

  if (!hasPlugin && !hasText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '未选择插件时必须填写发送文案'
    });
  }
});

export const scheduledTasksSchema = z.object({
  tasks: z.array(scheduledTaskSchema)
});
