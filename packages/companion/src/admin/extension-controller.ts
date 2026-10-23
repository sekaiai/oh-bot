import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Body, Controller, Get, Inject, OnModuleDestroy, Param, Post, Put, Query, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Database } from '../database/database.js';
import { agentDefinitions, agentRuns, auditEvents, characterVersions, characters, commitments, conversationPolicies, conversations, deletionRecords, interactionEvents, jobLogs, memoryRevisions, memorySources, messages, people, platformIdentities, primaryRelationshipBindings, proactivePermissions, toolConfigurations, toolRuns, turns } from '../database/schema/index.js';
import { ADMIN_DATABASE, ADMIN_TOKEN, ApiError, isAuthenticatedAdminPrincipal, type AuthenticatedAdminPrincipal } from './auth.js';
import { checkDatabaseReady, checkWorkerQueueReady } from './health.js';
import { MemoryLifecycleError } from '../memory/memory-lifecycle-service.js';
import type { MemoryGateway } from '../memory/memory-gateway.js';
import { toolSettingsSchema } from '../application/turn-processor.js';
import { resolvePersistedTurnActor } from '../application/trusted-turn-actor.js';
import { IdentityService } from '../identity/identity-service.js';
import { ProactiveCommitmentService } from '../proactive/proactive-commitment-service.js';

const uuid = z.string().uuid();
const memoryEnv = ['COMPANION_MEMORY_CHAT_API_URL', 'COMPANION_MEMORY_CHAT_API_KEY', 'COMPANION_MEMORY_CHAT_MODEL', 'COMPANION_MEMORY_EMBEDDING_API_URL', 'COMPANION_MEMORY_EMBEDDING_API_KEY', 'COMPANION_MEMORY_EMBEDDING_MODEL', 'COMPANION_MEMORY_EMBEDDING_DIMENSIONS', 'COMPANION_MEMORY_HISTORY_PATH', 'COMPANION_MEMORY_COLLECTION'];
function memoryConfigured() { return memoryEnv.every((key) => Boolean(process.env[key]?.trim())) && Boolean(process.env.MEMORY_DELETION_JOURNAL_PATH?.trim()); }
function oneBotConfigured() { return process.env.COMPANION_ONEBOT_ENABLED === '1' && Boolean(process.env.COMPANION_CHARACTER_ID && process.env.COMPANION_ONEBOT_WS_URL && process.env.COMPANION_ONEBOT_ACCESS_TOKEN && process.env.COMPANION_ONEBOT_SELF_ID); }
const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'invalid_input');
  return result.data;
}
function parseList(raw: unknown, allowed: readonly string[]) {
  const shape: z.ZodRawShape = { limit: z.coerce.number().int().min(1).max(100).default(50) };
  for (const key of allowed) shape[key] = ['personId', 'characterId', 'sourceId'].includes(key) ? uuid.optional() : z.string().max(64).optional();
  return parse(z.object(shape).strict(), raw);
}

@Controller()
export class AdminExtensionController implements OnModuleDestroy {
  constructor(
    @Inject(ADMIN_DATABASE) private readonly database: Database,
    @Inject(ADMIN_TOKEN) private readonly adminToken: string,
    @Inject('MEMORY_RUNTIME') private readonly memoryRuntime: { gateway: MemoryGateway; close(): Promise<void> } | undefined,
  ) {}

  async onModuleDestroy() { await this.memoryRuntime?.close(); }

  private async executeOperation(body: { action: 'create' | 'verify' | 'restore' | 'inspect' | 'backup' | 'apply'; backupId?: string; sourceId?: string; expectedVersion?: string; auditReason: string; confirm: true }, principal: AuthenticatedAdminPrincipal, target?: string) {
    await this.database.db.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: `operation_${body.action}_requested`, targetId: target ?? body.backupId ?? null, metadata: { reason: body.auditReason } });
    try {
      const { createCompanionOperationsRunner } = await import('../operations/runner.js');
      const result = await createCompanionOperationsRunner().run(body);
      await this.database.db.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: `operation_${body.action}_completed`, targetId: target ?? body.backupId ?? String(result.backupId ?? ''), metadata: { reason: body.auditReason, status: result.ready === false ? 'unready' : 'completed' } });
      return result;
    } catch (error) {
      const code = error instanceof Error && error.name === 'OperationError' && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message.toLowerCase() : 'operation_unavailable';
      await this.database.db.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: `operation_${body.action}_failed`, targetId: target ?? body.backupId ?? null, metadata: { reason: body.auditReason, errorCode: code } });
      if (code.includes('_required') || code.endsWith('_unavailable') || code === 'executor_unavailable') throw new ApiError(503, code);
      if (code.includes('not_found') || code.endsWith('_missing')) throw new ApiError(404, code);
      if (code.includes('conflict') || code.includes('invalid_state')) throw new ApiError(409, code);
      throw new ApiError(400, code);
    }
  }

  @Post('/admin/login') login(@Body() raw: unknown) {
    const body = parse(strict({ password: z.string().min(1).max(4096) }), raw);
    const received = Buffer.from(body.password);
    const expected = Buffer.from(this.adminToken);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new ApiError(401, 'unauthorized');
    // The existing configured bearer is returned only to the caller who supplied it.
    // The frontend contract stores it in memory and never persists it.
    return { token: body.password };
  }

  @Post('/admin/logout') logout(@Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    return { ok: true as const };
  }

  @Get('/admin/overview') async overview() {
    const [databaseReady, queueReady, peopleCount, characterCount, identityCount, partnerCount] = await Promise.all([
      checkDatabaseReady(this.database), checkWorkerQueueReady(this.database),
      this.database.db.select({ count: sql<number>`count(*)::int` }).from(people),
      this.database.db.select({ count: sql<number>`count(*)::int` }).from(characters),
      this.database.db.select({ count: sql<number>`count(*)::int` }).from(platformIdentities),
      this.database.db.select({ count: sql<number>`count(*)::int` }).from(primaryRelationshipBindings),
    ]);
    const configured = {
      model: Boolean(process.env.COMPANION_CHAT_API_URL && process.env.COMPANION_CHAT_API_KEY && process.env.COMPANION_CHAT_MODEL),
      qq: oneBotConfigured(),
      memory: memoryConfigured(),
    };
    return {
      health: databaseReady ? 'ready' : 'unready', configured,
      counts: { people: Number(peopleCount[0]?.count ?? 0), characters: Number(characterCount[0]?.count ?? 0), identities: Number(identityCount[0]?.count ?? 0), primaryRelationships: Number(partnerCount[0]?.count ?? 0) },
      queueReady,
    };
  }

  @Get('/admin/operations/status') async operationsStatus() {
    const databaseReady = await checkDatabaseReady(this.database);
    const queueReady = await checkWorkerQueueReady(this.database);
    let operations: Awaited<ReturnType<import('../operations/runner.js').CompanionOperationsRunner['list']>> | undefined;
    try {
      const { createCompanionOperationsRunner } = await import('../operations/runner.js');
      operations = await createCompanionOperationsRunner().list();
    } catch { /* unconfigured or inaccessible roots are reflected as unavailable */ }
    return { items: [{ capability: 'database', configured: true, ready: databaseReady }, { capability: 'worker_queue', configured: true, ready: queueReady },
      { capability: 'model', configured: Boolean(process.env.COMPANION_CHAT_API_URL && process.env.COMPANION_CHAT_API_KEY && process.env.COMPANION_CHAT_MODEL), ready: false },
      { capability: 'onebot', configured: oneBotConfigured(), ready: false },
      { capability: 'memory', configured: memoryConfigured(), ready: Boolean(memoryConfigured() && this.memoryRuntime) },
      { capability: 'backups', ...operations?.capabilities.backups ?? { configured: false, ready: false, message: 'backup capability unavailable' } },
      { capability: 'restore', ...operations?.capabilities.restore ?? { configured: false, ready: false, message: 'restore capability unavailable' } },
      { capability: 'migrations', ...operations?.capabilities.migrations ?? { configured: false, ready: false, message: 'migration capability unavailable' } }],
      operations: operations ? { configured: operations.configured, ready: operations.ready } : { configured: false, ready: false } };
  }

  @Get('/admin/persona/:characterId') async persona(@Param('characterId') characterId: string, @Query() raw: unknown) {
    const query = parse(strict({ version: z.coerce.number().int().positive().optional() }), raw);
    if (!uuid.safeParse(characterId).success) throw new ApiError(400, 'invalid_input');
    const [character] = await this.database.db.select({ id: characters.id }).from(characters).where(eq(characters.id, characterId)).limit(1);
    if (!character) throw new ApiError(404, 'not_found');
    const versions = await this.database.db.select().from(characterVersions).where(and(eq(characterVersions.characterId, characterId), query.version ? eq(characterVersions.revision, query.version) : undefined)).orderBy(desc(characterVersions.revision)).limit(100);
    return { items: versions, configured: versions.length > 0 };
  }

  @Post('/admin/persona/:characterId') async publishPersona(
    @Param('characterId') characterId: string,
    @Body() raw: unknown,
    @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal },
  ) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    if (!uuid.safeParse(characterId).success) throw new ApiError(400, 'invalid_input');
    const body = parse(strict({ expectedVersion: z.number().int().nonnegative(), content: z.string().min(1).max(16_000), auditReason: z.string().trim().min(8).max(1000) }), raw);
    let submitted: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(body.content);
      const core = z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32).safeParse(decoded);
      if (!core.success) throw new Error();
      submitted = core.data;
    } catch { throw new ApiError(400, 'invalid_input'); }
    return this.database.db.transaction(async (tx) => {
      const [character] = await tx.select().from(characters).where(eq(characters.id, characterId)).for('update').limit(1);
      if (!character) throw new ApiError(404, 'not_found');
      if (character.version !== body.expectedVersion) throw new ApiError(409, 'version_conflict');
      const [latest] = await tx.select().from(characterVersions).where(eq(characterVersions.characterId, characterId)).orderBy(desc(characterVersions.revision)).limit(1);
      const core = { ...submitted, age: '成年', name: '南枝', traits: submitted.traits ?? ['温柔', '主动表达', '有主见', '尊重空间'] };
      const [version] = await tx.insert(characterVersions).values({ characterId, revision: (latest?.revision ?? 0) + 1, core, createdBy: request.adminPrincipal!.auditActorId }).returning();
      if (!version) throw new ApiError(500, 'internal_error');
      const [updated] = await tx.update(characters).set({ currentVersionId: version.id, version: character.version + 1 }).where(and(eq(characters.id, characterId), eq(characters.version, body.expectedVersion))).returning({ id: characters.id });
      if (!updated) throw new ApiError(409, 'version_conflict');
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal!.auditActorId, action: 'persona_published', targetId: characterId, metadata: { revision: version.revision, reason: body.auditReason } });
      return version;
    });
  }

  @Get('/admin/relationships') async relationships(@Query() raw: unknown) {
    const p = parseList(raw, ['personId', 'characterId']);
    return { items: await this.database.db.select().from(interactionEvents)
      .where(and(p.personId ? eq(interactionEvents.personId, p.personId) : undefined, p.characterId ? eq(interactionEvents.characterId, p.characterId) : undefined))
      .orderBy(desc(interactionEvents.createdAt), desc(interactionEvents.id)).limit(p.limit) };
  }

  @Get('/admin/memory-sources') async memorySourceList(@Query() raw: unknown) {
    const p = parseList(raw, ['personId', 'characterId', 'status']);
    const rows = await this.database.db.select({ source: memorySources, text: messages.text, role: messages.role })
      .from(memorySources).innerJoin(messages, eq(messages.id, memorySources.messageId))
      .where(and(p.personId ? eq(memorySources.personId, p.personId) : undefined, p.characterId ? eq(memorySources.characterId, p.characterId) : undefined,
        p.status ? eq(memorySources.status, p.status as typeof memorySources.$inferSelect.status) : undefined))
      .orderBy(desc(memorySources.createdAt), desc(memorySources.id)).limit(p.limit);
    return { items: rows.filter((row) => row.role === 'user').map((row) => ({ ...row.source, sourceText: row.text })) };
  }

  @Get('/admin/memory-revisions') async memoryRevisionList(@Query() raw: unknown) {
    const p = parseList(raw, ['sourceId', 'characterId', 'status']);
    return { items: await this.database.db.select().from(memoryRevisions)
      .where(and(p.sourceId ? eq(memoryRevisions.sourceId, p.sourceId) : undefined,
        p.characterId ? eq(memoryRevisions.characterId, p.characterId) : undefined,
        p.status ? eq(memoryRevisions.status, p.status as typeof memoryRevisions.$inferSelect.status) : undefined))
      .orderBy(desc(memoryRevisions.createdAt), desc(memoryRevisions.id)).limit(p.limit) };
  }

  @Get('/admin/deletions') async deletionList(@Query() raw: unknown) {
    const p = parseList(raw, ['status']);
    return { items: await this.database.db.select().from(deletionRecords)
      .where(p.status ? eq(deletionRecords.status, p.status as typeof deletionRecords.$inferSelect.status) : undefined)
      .orderBy(desc(deletionRecords.createdAt), desc(deletionRecords.id)).limit(p.limit) };
  }

  @Get('/admin/agent-runs') async agentRunList(@Query() raw: unknown) {
    const p = parseList(raw, ['personId', 'characterId', 'status']);
    return { items: await this.database.db.select({ id: agentRuns.id, characterId: agentRuns.characterId, personId: agentRuns.personId,
      conversationId: agentRuns.conversationId, definitionId: agentRuns.definitionId, turnId: agentRuns.turnId, graphVersion: agentRuns.graphVersion,
      threadId: agentRuns.threadId, status: agentRuns.status, usage: agentRuns.usage, errorCode: agentRuns.errorCode, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt })
      .from(agentRuns).where(and(p.personId ? eq(agentRuns.personId, p.personId) : undefined,
        p.characterId ? eq(agentRuns.characterId, p.characterId) : undefined,
        p.status ? eq(agentRuns.status, p.status as typeof agentRuns.$inferSelect.status) : undefined))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(p.limit) };
  }

  @Get('/admin/tool-runs') async toolRunList(@Query() raw: unknown) {
    const p = parseList(raw, ['toolId', 'status']);
    return { items: await this.database.db.select({ id: toolRuns.id, agentRunId: toolRuns.agentRunId, turnId: toolRuns.turnId,
      name: toolRuns.name, permission: toolRuns.permission, status: toolRuns.status, errorCode: toolRuns.errorCode, createdAt: toolRuns.createdAt, updatedAt: toolRuns.updatedAt })
      .from(toolRuns).where(and(p.toolId ? eq(toolRuns.name, p.toolId) : undefined,
        p.status ? eq(toolRuns.status, p.status as typeof toolRuns.$inferSelect.status) : undefined))
      .orderBy(desc(toolRuns.createdAt), desc(toolRuns.id)).limit(p.limit) };
  }

  @Get('/admin/jobs') async jobList(@Query() raw: unknown) {
    const p = parseList(raw, ['status', 'kind']);
    return { items: await this.database.db.select({ id: jobLogs.id, operationKey: jobLogs.operationKey, queueName: jobLogs.queueName, status: jobLogs.status,
      attempts: jobLogs.attempts, errorCode: jobLogs.errorCode, nextRunAt: jobLogs.nextRunAt, createdAt: jobLogs.createdAt, updatedAt: jobLogs.updatedAt })
      .from(jobLogs).where(and(p.status ? eq(jobLogs.status, p.status as typeof jobLogs.$inferSelect.status) : undefined, p.kind ? eq(jobLogs.queueName, p.kind) : undefined))
      .orderBy(desc(jobLogs.createdAt), desc(jobLogs.id)).limit(p.limit) };
  }

  @Get('/admin/commitments') async commitmentList(@Query() raw: unknown) {
    const p = parseList(raw, ['personId', 'characterId', 'status']);
    return { items: await this.database.db.select().from(commitments)
      .where(and(p.personId ? eq(commitments.personId, p.personId) : undefined,
        p.characterId ? eq(commitments.characterId, p.characterId) : undefined,
        p.status ? eq(commitments.status, p.status as typeof commitments.$inferSelect.status) : undefined))
      .orderBy(desc(commitments.createdAt), desc(commitments.id)).limit(p.limit) };
  }

  @Get('/admin/proactive-permissions') async proactivePermissionList(@Query() raw: unknown) {
    const p = parseList(raw, ['personId', 'characterId']);
    const peopleRows = await this.database.db.select().from(proactivePermissions)
      .where(and(p.personId ? eq(proactivePermissions.personId, p.personId) : undefined,
        p.characterId ? eq(proactivePermissions.characterId, p.characterId) : undefined))
      .orderBy(desc(proactivePermissions.updatedAt), desc(proactivePermissions.personId)).limit(p.limit);
    const groups = await this.database.db.select({ conversationId: conversations.id, characterId: conversations.characterId, kind: conversations.kind,
      proactiveEnabled: conversationPolicies.proactiveEnabled, quietStart: conversationPolicies.quietStart, quietEnd: conversationPolicies.quietEnd,
      timeZone: conversationPolicies.timeZone, maxPerDay: conversationPolicies.maxPerDay, updatedAt: conversationPolicies.updatedAt, version: conversationPolicies.version })
      .from(conversationPolicies).innerJoin(conversations, eq(conversations.id, conversationPolicies.conversationId))
      .where(and(eq(conversations.kind, 'group'), p.characterId ? eq(conversations.characterId, p.characterId) : undefined))
      .orderBy(desc(conversationPolicies.updatedAt), desc(conversations.id)).limit(p.limit);
    return { items: [...peopleRows.map((row) => ({ ...row, scope: 'person' as const })), ...groups.map((row) => ({ ...row, scope: 'group' as const }))] };
  }

  @Put('/admin/proactive-permissions') async updateProactivePermission(@Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    const body = parse(strict({ characterId: uuid, personId: uuid.optional(), conversationId: uuid.optional(), scope: z.enum(['person', 'group']), enabled: z.boolean(), quietStart: z.string().regex(/^\d{2}:\d{2}$/).optional(), quietEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(), timeZone: z.string().min(1).max(80).optional(), maxPerDay: z.number().int().min(0).max(100).optional(), expectedVersion: z.number().int().positive(), auditReason: z.string().trim().min(8).max(1000) }), raw);
    if (body.scope === 'person') {
      if (!body.personId || body.conversationId) throw new ApiError(400, 'invalid_input');
      return this.database.db.transaction(async (tx) => {
        const [prior] = await tx.select().from(proactivePermissions).where(and(eq(proactivePermissions.characterId, body.characterId), eq(proactivePermissions.personId!, body.personId!))).for('update').limit(1);
        if (prior && prior.version !== body.expectedVersion || !prior && body.expectedVersion !== 1) throw new ApiError(409, 'version_conflict');
        const patch = { enabled: body.enabled, ...(body.quietStart ? { quietStart: body.quietStart } : {}), ...(body.quietEnd ? { quietEnd: body.quietEnd } : {}), ...(body.timeZone ? { timeZone: body.timeZone } : {}), ...(body.maxPerDay === undefined ? {} : { maxPerDay: body.maxPerDay }), version: prior ? prior.version + 1 : 1, updatedAt: new Date() };
        const [row] = prior
          ? await tx.update(proactivePermissions).set(patch).where(and(eq(proactivePermissions.characterId, body.characterId), eq(proactivePermissions.personId, body.personId! ), eq(proactivePermissions.version, body.expectedVersion))).returning()
          : await tx.insert(proactivePermissions).values({ characterId: body.characterId, personId: body.personId!, ...patch }).returning();
        if (!row) throw new ApiError(409, 'version_conflict');
        await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal!.auditActorId, action: 'proactive_person_permission_updated', targetId: body.personId!, metadata: { characterId: body.characterId, enabled: body.enabled, reason: body.auditReason } });
        return row;
      });
    }
    if (!body.conversationId || body.personId) throw new ApiError(400, 'invalid_input');
    return this.database.db.transaction(async (tx) => {
      const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, body.conversationId!), eq(conversations.characterId, body.characterId), eq(conversations.kind, 'group'))).limit(1);
      if (!conversation) throw new ApiError(404, 'not_found');
      const [prior] = await tx.select().from(conversationPolicies).where(eq(conversationPolicies.conversationId, body.conversationId!)).for('update').limit(1);
      if (!prior || prior.version !== body.expectedVersion) throw new ApiError(409, 'version_conflict');
      const [row] = await tx.update(conversationPolicies).set({ proactiveEnabled: body.enabled, ...(body.quietStart ? { quietStart: body.quietStart } : {}), ...(body.quietEnd ? { quietEnd: body.quietEnd } : {}), ...(body.timeZone ? { timeZone: body.timeZone } : {}), ...(body.maxPerDay === undefined ? {} : { maxPerDay: body.maxPerDay}), version: body.expectedVersion + 1, updatedAt: new Date() }).where(and(eq(conversationPolicies.conversationId, body.conversationId!), eq(conversationPolicies.version, body.expectedVersion))).returning();
      if (!row) throw new ApiError(409, 'version_conflict');
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal!.auditActorId, action: 'proactive_group_permission_updated', targetId: body.conversationId!, metadata: { characterId: body.characterId, enabled: body.enabled, reason: body.auditReason } });
      return row;
    });
  }

  @Get('/admin/backups') async backupList(@Query() raw: unknown) {
    const p = parseList(raw, []);
    try {
      const { createCompanionOperationsRunner } = await import('../operations/runner.js');
      const listing = await createCompanionOperationsRunner().list();
      return { items: listing.backups.slice(0, p.limit), configured: listing.capabilities.backups.configured, ready: listing.capabilities.backups.ready, message: listing.capabilities.backups.message };
    } catch { return { items: [], configured: false, ready: false, message: 'Backup roots are unavailable.' }; }
  }

  @Get('/admin/migrations') async migrationList(@Query() raw: unknown) {
    const p = parseList(raw, []);
    try {
      const { createCompanionOperationsRunner } = await import('../operations/runner.js');
      const listing = await createCompanionOperationsRunner().list();
      return { items: listing.sources.slice(0, p.limit), configured: listing.capabilities.migrations.configured, ready: listing.capabilities.migrations.ready, message: listing.capabilities.migrations.message };
    } catch { return { items: [], configured: false, ready: false, message: 'Legacy source root is unavailable.' }; }
  }

  private async safeToolConfiguration(toolId: string) {
    const [row] = await this.database.db.select().from(toolConfigurations).where(eq(toolConfigurations.toolId, toolId)).limit(1);
    const settings = row ? toolSettingsSchema.safeParse(row.settings) : undefined;
    const credentialRef = settings?.success ? settings.data.credentialRef : undefined;
    const configured = Boolean(row?.enabled && settings?.success && credentialRef && process.env[credentialRef]?.trim());
    return { id: toolId, toolId, enabled: row?.enabled ?? false, settings: settings?.success ? settings.data : {}, version: row?.version ?? 1, configured };
  }
  @Get('/admin/tools') async tools() {
    return { items: await Promise.all(['search', 'weather'].map((toolId) => this.safeToolConfiguration(toolId))), configured: true };
  }
  @Get('/admin/tools/:toolId') async toolDetail(@Param('toolId') toolId: string) {
    if (!['search', 'weather'].includes(toolId)) throw new ApiError(404, 'not_found');
    return this.safeToolConfiguration(toolId);
  }
  @Get('/admin/agents/:agentId') async agentDetail(@Param('agentId') id: string) {
    if (!uuid.safeParse(id).success) throw new ApiError(400, 'invalid_input');
    const [row] = await this.database.db.select({ id: agentDefinitions.id, name: agentDefinitions.name, kind: agentDefinitions.kind,
      enabled: agentDefinitions.enabled, description: agentDefinitions.description, toolNames: agentDefinitions.toolNames,
      modelProfileId: agentDefinitions.modelProfileId, permissions: agentDefinitions.permissions, budget: agentDefinitions.budget,
      version: agentDefinitions.version, createdAt: agentDefinitions.createdAt }).from(agentDefinitions).where(eq(agentDefinitions.id, id)).limit(1);
    if (!row) throw new ApiError(404, 'not_found');
    return row;
  }
  @Get('/admin/agents') async agents(@Query() raw: unknown) {
    const p = parseList(raw, []);
    return { items: await this.database.db.select({ id: agentDefinitions.id, name: agentDefinitions.name, kind: agentDefinitions.kind,
      enabled: agentDefinitions.enabled, description: agentDefinitions.description, toolNames: agentDefinitions.toolNames,
      modelProfileId: agentDefinitions.modelProfileId, permissions: agentDefinitions.permissions, budget: agentDefinitions.budget,
      version: agentDefinitions.version, createdAt: agentDefinitions.createdAt }).from(agentDefinitions)
      .orderBy(desc(agentDefinitions.createdAt), desc(agentDefinitions.id)).limit(p.limit), configured: true };
  }

  @Put('/admin/agents/:agentId') async updateAgent(@Param('agentId') id: string, @Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    if (!uuid.safeParse(id).success) throw new ApiError(400, 'invalid_input');
    const body = parse(strict({ expectedVersion: z.number().int().positive(), enabled: z.boolean(), settings: z.record(z.string(), z.unknown()).optional(), auditReason: z.string().trim().min(8).max(1000) }), raw);
    if (body.settings && Object.keys(body.settings).length) throw new ApiError(400, 'unsupported_settings');
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.update(agentDefinitions).set({ enabled: body.enabled, version: body.expectedVersion + 1 }).where(and(eq(agentDefinitions.id, id), eq(agentDefinitions.version, body.expectedVersion))).returning({ id: agentDefinitions.id, name: agentDefinitions.name, enabled: agentDefinitions.enabled, version: agentDefinitions.version });
      if (!row) throw new ApiError(409, 'version_conflict');
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal!.auditActorId, action: 'agent_enabled_updated', targetId: id, metadata: { enabled: body.enabled, reason: body.auditReason } });
      return row;
    });
  }

  @Post('/admin/backups') async backupAction(@Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    const body = parse(strict({ action: z.enum(['create', 'verify', 'restore']), backupId: z.string().max(100).optional(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }), raw);
    if (body.action !== 'create' && !body.backupId) throw new ApiError(400, 'invalid_input');
    if (body.action !== 'create' && !body.expectedVersion) throw new ApiError(400, 'expected_version_required');
    return this.executeOperation(body, request.adminPrincipal, body.backupId);
  }

  @Post('/admin/migrations') async migrationAction(@Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    const body = parse(strict({ action: z.enum(['inspect', 'backup', 'apply']), sourceId: z.string().max(100).optional(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }), raw);
    if (body.action !== 'inspect' && (!body.sourceId || !body.expectedVersion)) throw new ApiError(400, 'expected_version_required');
    return this.executeOperation(body, request.adminPrincipal, body.sourceId);
  }

  @Post('/admin/relationships') async recordRelationship(@Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    const body = parse(strict({ personId: uuid, characterId: uuid, event: z.enum(['conversation', 'appreciation', 'shared_experience', 'boundary_respected', 'distress', 'direct_attack', 'quoted_attack', 'refusal', 'late_reply', 'delay']), sourceIds: z.array(uuid).min(1).max(100), expectedVersion: z.number().int().positive().optional(), auditReason: z.string().trim().min(8).max(1000) }), raw);
    return this.database.db.transaction(async (tx) => {
      const sourceRows = await tx.select({ message: messages, conversation: conversations }).from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(inArray(messages.id, body.sourceIds), eq(messages.role, 'user'), isNull(messages.deletedAt), eq(conversations.characterId, body.characterId)));
      if (sourceRows.length !== body.sourceIds.length || sourceRows.some(({ message }) => message.personId !== body.personId || !message.text?.trim()) || new Set(sourceRows.map(({ conversation }) => conversation.id)).size !== 1) throw new ApiError(404, 'source_not_owned');
      for (const sourceId of body.sourceIds) {
        await tx.insert(interactionEvents).values({ eventKey: `admin:${request.adminPrincipal!.auditActorId}:${sourceId}:${body.event}`, characterId: body.characterId, personId: body.personId, sourceMessageId: sourceId, kind: body.event, payload: { sourceMessageId: sourceId, kind: body.event, auditReason: body.auditReason }, appliedAt: new Date() }).onConflictDoNothing({ target: interactionEvents.eventKey });
      }
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal!.auditActorId, action: 'relationship_event_recorded', targetId: body.personId, metadata: { characterId: body.characterId, event: body.event, sourceIds: body.sourceIds, reason: body.auditReason } });
      return { status: 'recorded', personId: body.personId, characterId: body.characterId, event: body.event, sourceIds: body.sourceIds };
    });
  }

  @Post('/admin/memory-revisions/:revisionId/forget') async forgetRevision(@Param('revisionId') revisionId: string, @Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    if (!uuid.safeParse(revisionId).success) throw new ApiError(400, 'invalid_input');
    const body = parse(strict({ expectedVersion: z.number().int().positive(), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }), raw);
    try {
      if (!this.memoryRuntime) throw new ApiError(503, 'capability_unavailable');
      return await this.memoryRuntime.gateway.forgetRevisionAsAdmin(revisionId, body.expectedVersion, request.adminPrincipal, body.auditReason);
    } catch (error) {
      if (error instanceof MemoryLifecycleError) {
        const status = error.code === 'untrusted_actor' ? 401 : error.code === 'invalid_input' ? 400 : error.code === 'source_not_owned' ? 404 : 409;
        throw new ApiError(status, error.code);
      }
      if (error instanceof Error && error.message === 'memory_deletion_journal_required') throw new ApiError(503, 'capability_unavailable');
      throw error;
    }
  }

  @Post('/admin/memory-revisions/:revisionId/correct') async correctRevision(@Param('revisionId') revisionId: string, @Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    if (!uuid.safeParse(revisionId).success) throw new ApiError(400, 'invalid_input');
    const body = parse(strict({ expectedVersion: z.number().int().positive(), evidenceQuote: z.string().trim().min(1).max(2000), factText: z.string().trim().min(1).max(4000), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }), raw);
    if (!this.memoryRuntime) throw new ApiError(503, 'capability_unavailable');
    const [row] = await this.database.db.select({ messageId: memorySources.messageId }).from(memoryRevisions)
      .innerJoin(memorySources, eq(memorySources.id, memoryRevisions.sourceId)).where(eq(memoryRevisions.id, revisionId)).limit(1);
    if (!row) throw new ApiError(404, 'not_found');
    try {
      return await this.memoryRuntime.gateway.correctAsAdmin({ revisionId, expectedVersion: body.expectedVersion, messageId: row.messageId, factText: body.factText, evidenceQuote: body.evidenceQuote }, request.adminPrincipal, body.auditReason);
    } catch (error) {
      if (error instanceof MemoryLifecycleError) {
        const status = error.code === 'untrusted_actor' ? 401 : error.code === 'invalid_input' ? 400 : error.code === 'source_not_owned' ? 404 : 409;
        throw new ApiError(status, error.code);
      }
      throw error;
    }
  }

  @Post('/admin/deletions') async deleteSources(@Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    const body = parse(strict({ sourceIds: z.array(uuid).min(1).max(100), memoryIds: z.array(z.string().min(1).max(512)).max(100).optional(), scope: z.string().min(1).max(512), auditReason: z.string().trim().min(8).max(1000), confirm: z.literal(true) }), raw);
    if (!this.memoryRuntime) throw new ApiError(503, 'capability_unavailable');
    const sources = await this.database.db.select().from(memorySources).where(inArray(memorySources.id, body.sourceIds));
    if (sources.length !== body.sourceIds.length || sources.some((source) => JSON.stringify(source.scope) !== body.scope || source.status === 'deleted')) throw new ApiError(409, 'scope_or_source_conflict');
    const revisions = await this.database.db.select().from(memoryRevisions).where(and(inArray(memoryRevisions.sourceId, body.sourceIds), eq(memoryRevisions.status, 'validated'), isNull(memoryRevisions.validTo)));
    const latestBySource = new Map<string, typeof revisions[number]>();
    for (const revision of revisions) if (!latestBySource.has(revision.sourceId)) latestBySource.set(revision.sourceId, revision);
    if (body.sourceIds.some((id) => !latestBySource.has(id))) throw new ApiError(409, 'active_revision_required');
    const result = [];
    for (const sourceId of body.sourceIds) {
      const revision = latestBySource.get(sourceId)!;
      try { result.push(await this.memoryRuntime.gateway.forgetRevisionAsAdmin(revision.id, revision.version, request.adminPrincipal, body.auditReason)); }
      catch (error) { if (error instanceof MemoryLifecycleError) throw new ApiError(error.code === 'untrusted_actor' ? 401 : error.code === 'invalid_input' ? 400 : error.code === 'source_not_owned' ? 404 : 409, error.code); throw error; }
    }
    return { status: 'accepted', items: result };
  }

  @Post('/admin/commitments') async scheduleCommitment(@Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    const body = parse(strict({ personId: uuid, characterId: uuid, sourceMessageId: uuid, text: z.string().trim().min(1).max(1000), dueAt: z.string().datetime(), scope: z.string().min(1).max(128), auditReason: z.string().trim().min(8).max(1000) }), raw);
    const [turn] = await this.database.db.select({ id: turns.id, personId: turns.personId, conversationId: turns.conversationId }).from(turns).where(eq(turns.inboundMessageId, body.sourceMessageId)).limit(1);
    if (!turn || turn.personId !== body.personId) throw new ApiError(404, 'source_not_owned');
    const actor = await resolvePersistedTurnActor(this.database, new IdentityService(this.database), turn.id);
    if (actor.characterId !== body.characterId) throw new ApiError(404, 'source_not_owned');
    const [conversation] = await this.database.db.select({ kind: conversations.kind }).from(conversations).where(eq(conversations.id, turn.conversationId)).limit(1);
    if (!conversation || body.scope !== conversation.kind) throw new ApiError(409, 'scope_conflict');
    try {
      const row = await new ProactiveCommitmentService(this.database).schedule(actor, body.sourceMessageId, { description: body.text, dueAt: new Date(body.dueAt) });
      await this.database.db.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal.auditActorId, action: 'admin_proactive_commitment_scheduled', targetId: row.id, metadata: { personId: body.personId, characterId: body.characterId, sourceMessageId: body.sourceMessageId, reason: body.auditReason } });
      return row;
    } catch (error) { throw new ApiError(409, error instanceof Error ? error.message.replace(/[^a-z0-9_]/giu, '_').slice(0, 100) : 'commitment_unavailable'); }
  }

  @Put('/admin/tools/:toolId') async updateTool(@Param('toolId') toolId: string, @Body() raw: unknown, @Req() request: FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal }) {
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, 'unauthorized');
    if (!['search', 'weather'].includes(toolId)) throw new ApiError(404, 'not_found');
    const body = parse(strict({ expectedVersion: z.number().int().positive(), enabled: z.boolean(), settings: toolSettingsSchema, auditReason: z.string().trim().min(8).max(1000) }), raw);
    return this.database.db.transaction(async (tx) => {
      const [prior] = await tx.select().from(toolConfigurations).where(eq(toolConfigurations.toolId, toolId)).for('update').limit(1);
      if (prior && prior.version !== body.expectedVersion || !prior && body.expectedVersion !== 1) throw new ApiError(409, 'version_conflict');
      const values = { enabled: body.enabled, settings: body.settings, version: prior ? prior.version + 1 : 1, updatedAt: new Date() };
      const [row] = prior
        ? await tx.update(toolConfigurations).set(values).where(and(eq(toolConfigurations.toolId, toolId), eq(toolConfigurations.version, body.expectedVersion))).returning()
        : await tx.insert(toolConfigurations).values({ toolId, ...values }).returning();
      if (!row) throw new ApiError(409, 'version_conflict');
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: request.adminPrincipal!.auditActorId, action: 'tool_configuration_updated', targetId: toolId, metadata: { enabled: row.enabled, credentialRef: body.settings.credentialRef, reason: body.auditReason } });
      return { id: row.toolId, toolId: row.toolId, enabled: row.enabled, settings: row.settings, version: row.version, configured: Boolean(process.env[body.settings.credentialRef]?.trim()) };
    });
  }
}
