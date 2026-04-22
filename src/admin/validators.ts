import { z } from 'zod';

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

const personaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive()
});

export const personaRegistrySchema = z.object({
  defaultPersonaId: z.string().min(1),
  personas: z.array(personaSchema).min(1),
  bindings: z.record(z.string())
}).superRefine((value, ctx) => {
  const ids = new Set(value.personas.map((item) => item.id));
  if (!ids.has(value.defaultPersonaId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'defaultPersonaId 必须存在于 personas 列表中'
    });
  }

  for (const [chatKey, personaId] of Object.entries(value.bindings)) {
    if (!chatKey.startsWith('group:') && !chatKey.startsWith('private:')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `非法会话绑定 key: ${chatKey}`
      });
    }

    if (!ids.has(personaId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `会话 ${chatKey} 绑定了不存在的人设 ${personaId}`
      });
    }
  }
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

const ds2apiPluginSchema = aiEndpointSchema.extend({
  id: z.string().min(1),
  kind: z.literal('ds2api'),
  name: z.string().min(1),
  enabled: z.boolean(),
  triggerKeywords: z.array(z.string().min(1)),
  systemPrompt: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive()
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

export const pluginConfigSchema = z.discriminatedUnion('kind', [ds2apiPluginSchema, qweatherPluginSchema]);

export const pluginTestSchema = z.object({
  plugin: pluginConfigSchema,
  input: z.string().optional().default('')
});

export const sessionSettingsSchema = z.object({
  chatKey: z.string().regex(/^(group|private):[^:\s]+$/, 'chatKey 格式不合法'),
  personaId: z.string().min(1).nullable(),
  status: z.enum(['available', 'banned'])
});
