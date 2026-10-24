import { z } from 'zod';
import { overviewSchema, listSchema } from './schemas';

export type PanelOperation = 'overview' | 'characters' | 'identities' | 'persona' | 'relationships' | 'memory-sources' | 'memory-revisions' | 'deletions' | 'agent-runs' | 'tool-runs' | 'jobs' | 'turns' | 'deliveries' | 'model-profiles' | 'tools' | 'agents' | 'commitments' | 'permissions' | 'operations' | 'backups' | 'migrations' | 'primary-partner';
export type PanelList = { items: Record<string, unknown>[]; configured?: boolean; message?: string };
export type PanelOverview = z.infer<typeof overviewSchema> & { queueReady?: boolean };
export type PanelDetail = Record<string, unknown>;
type ListOperation = Exclude<PanelOperation, 'overview' | 'primary-partner'>;
type ResponseMap = { overview: PanelOverview; 'primary-partner': { personId: string | null } } & Record<ListOperation, PanelList>;

const listOrRawArray = z.preprocess((value) => Array.isArray(value) ? { items: value } : value, listSchema);
const responses: Record<PanelOperation, z.ZodTypeAny> = {
  overview: overviewSchema.extend({ queueReady: z.boolean().optional() }).passthrough(),
  'primary-partner': z.object({ personId: z.string().uuid().nullable() }),
  characters: listOrRawArray, identities: listOrRawArray, persona: listSchema, relationships: listSchema,
  'memory-sources': listSchema, 'memory-revisions': listSchema, deletions: listSchema, 'agent-runs': listSchema,
  'tool-runs': listSchema, jobs: listOrRawArray, turns: listOrRawArray, deliveries: listOrRawArray, 'model-profiles': listOrRawArray, tools: listSchema,
  agents: listSchema, commitments: listSchema, permissions: listSchema, operations: listSchema,
  backups: listSchema, migrations: listSchema
};
export function responseFor<T extends PanelOperation>(operation: T, value: unknown): ResponseMap[T] {
  return responses[operation]!.parse(value) as ResponseMap[T];
}

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const positiveVersion = z.coerce.number().int().positive();
const nonNegativeVersion = z.coerce.number().int().nonnegative();
const sha256Version = z.string().regex(/^[a-f0-9]{64}$/);
const requiredText = (max = 1000) => z.string().trim().min(1).max(max);
const quietTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z.string().min(1).max(80).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
const modelProfileSchema = strict({
  version: positiveVersion, name: requiredText(120), provider: requiredText(80), baseUrl: z.string().url().max(2048).refine((value) => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }), model: requiredText(160),
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/), dimensions: z.preprocess((v) => v === '' || v === undefined ? null : Number(v), z.number().int().min(1).max(65536).nullable()),
  maxTokens: z.coerce.number().int().min(1).max(100000), timeoutMs: z.coerce.number().int().min(100).max(600000),
  monthlyBudgetUsd: z.preprocess((v) => v === '' || v === undefined ? null : v, z.string().regex(/^\d+(\.\d{1,4})?$/).nullable())
});
const toolSettingsSchema = strict({
  apiUrl: z.string().url().max(2048).refine((value) => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }),
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)
});
const bodies: Record<string, z.ZodTypeAny> = {
  'memory-approve': strict({ expectedVersion: positiveVersion, claimKind: z.literal('direct'), evidenceQuote: z.string().min(1).max(4000) }),
  'model-test': strict({ version: positiveVersion }),
  'model-enabled': strict({ version: positiveVersion, enabled: z.boolean(), auditReason: z.string().trim().min(8).max(1000) }),
  'model-update': modelProfileSchema,
  'backup-action': strict({ action: z.enum(['create', 'verify', 'restore']), backupId: z.string().min(1).max(100).optional(), expectedVersion: sha256Version.optional(), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }).superRefine((body, context) => {
    if (body.action !== 'create' && !body.backupId) context.addIssue({ code: z.ZodIssueCode.custom, message: '请选择服务端列出的备份记录', path: ['backupId'] });
    if ((body.action === 'verify' || body.action === 'restore') && !body.expectedVersion) context.addIssue({ code: z.ZodIssueCode.custom, message: '请刷新并选择带有 SHA-256 版本的备份记录', path: ['expectedVersion'] });
  }),
  'migration-action': strict({ action: z.enum(['inspect', 'backup', 'apply']), sourceId: z.string().min(1).max(100), expectedVersion: sha256Version.optional(), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }).superRefine((body, context) => {
    if ((body.action === 'backup' || body.action === 'apply') && !body.expectedVersion) context.addIssue({ code: z.ZodIssueCode.custom, message: '请刷新并选择带有 SHA-256 版本的迁移来源', path: ['expectedVersion'] });
  }),
  'character-create': strict({ name: requiredText(160) }),
  'partner-update': strict({ personId: z.string().uuid() }),
  'persona-publish': strict({ expectedVersion: nonNegativeVersion, content: z.string().min(1).max(16000), auditReason: z.string().trim().min(8).max(1000) }),
  'memory-forget': strict({ expectedVersion: positiveVersion, auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }),
  'memory-correct': strict({ expectedVersion: positiveVersion, evidenceQuote: z.string().trim().min(1).max(2000), factText: z.string().trim().min(1).max(4000), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }),
  'source-delete': strict({ sourceIds: z.array(z.string().uuid()).min(1), scope: requiredText(128), auditReason: z.string().trim().min(8).max(1000), confirmed: z.literal(true) }).transform(({ confirmed, ...body }) => ({ ...body, confirm: confirmed })),
  'agent-update': strict({ expectedVersion: positiveVersion, enabled: z.boolean(), settings: z.record(z.string(), z.unknown()).optional().refine((settings) => !settings || Object.keys(settings).length === 0), auditReason: z.string().trim().min(8).max(1000) }),
  'tool-update': strict({ expectedVersion: positiveVersion, enabled: z.boolean(), settings: toolSettingsSchema, auditReason: z.string().trim().min(8).max(1000) }),
  'permission-update': strict({ characterId: z.string().uuid(), personId: z.string().uuid().optional(), conversationId: z.string().uuid().optional(), scope: z.enum(['person', 'group']), enabled: z.boolean(), quietStart: quietTime.optional(), quietEnd: quietTime.optional(), timeZone: timeZone.optional(), maxPerDay: z.coerce.number().int().min(0).max(100).optional(), expectedVersion: positiveVersion, auditReason: z.string().trim().min(8).max(1000) }).superRefine((body, context) => {
    if (body.scope === 'person' && (!body.personId || body.conversationId)) context.addIssue({ code: z.ZodIssueCode.custom, message: '个人授权必须只指定人物 ID', path: ['personId'] });
    if (body.scope === 'group' && (!body.conversationId || body.personId)) context.addIssue({ code: z.ZodIssueCode.custom, message: '群授权必须只指定会话 ID', path: ['conversationId'] });
  }),
  'relationship-create': strict({ personId: z.string().uuid(), characterId: z.string().uuid(), event: z.enum(['conversation', 'appreciation', 'shared_experience', 'boundary_respected', 'distress', 'direct_attack', 'quoted_attack', 'refusal', 'late_reply', 'delay']), sourceIds: z.array(z.string().uuid()).min(1).max(100), auditReason: z.string().trim().min(8).max(1000) }),
  'commitment-create': strict({ personId: z.string().uuid(), characterId: z.string().uuid(), sourceMessageId: z.string().uuid(), text: requiredText(1000), dueAt: z.string().datetime(), scope: requiredText(128), auditReason: z.string().trim().min(8).max(1000) })
};
export function parseOperationBody<T = Record<string, unknown>>(operation: string, value: unknown): T {
  const schema = bodies[operation];
  if (!schema) throw new Error(`Unsupported operation: ${operation}`);
  return schema.parse(value) as T;
}

const secretKey = /access.?token|token|password|credential|(?:api|provider)[_-]?key|secret/i;
export function safeForDisplay<T>(value: T, key = ''): T {
  if (key && secretKey.test(key)) return '[已隐藏]' as T;
  if (typeof value === 'string') return value.replace(/((?:api[-_ ]?key|token|secret|password|credential)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]') as T;
  if (Array.isArray(value)) return value.map((item) => safeForDisplay(item)) as T;
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, safeForDisplay(child, childKey)])) as T;
  return value;
}
