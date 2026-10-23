import { and, desc, eq, sql } from "drizzle-orm";
import { checkDatabaseReady, checkWorkerQueueReady } from "./health.js";
import {
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import type { Database } from "../database/database.js";
import { ADMIN_DATABASE, ApiError, isAuthenticatedAdminPrincipal } from "./auth.js";
import type { AuthenticatedAdminPrincipal } from "./auth.js";
import { MemoryLifecycleError, MemoryLifecycleService } from "../memory/memory-lifecycle-service.js";
import {
  auditEvents,
  businessOutbox,
  characters,
  circleMembers,
  conversationPolicies,
  conversations,
  deliveryOutbox,
  jobLogs,
  modelProfiles,
  modelRoleBindings,
  people,
  personIdentityLinks,
  platformIdentities,
  primaryRelationshipBindings,
  socialCircles,
  turns,
} from "../database/schema/index.js";
import { IdentityService } from "../identity/identity-service.js";
import { DeliveryService } from "../transactions/delivery-service.js";

const uuid = z.string().uuid();
const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
const jobPageSchema = pageSchema.extend({
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
});
function assertRetryableLeases(
  log: typeof jobLogs.$inferSelect,
  outbox: typeof businessOutbox.$inferSelect,
  now: Date,
): void {
  if ((log.status !== "failed" && log.status !== "running") ||
    (log.leaseExpiresAt && log.leaseExpiresAt > now) ||
    (outbox.leaseExpiresAt && outbox.leaseExpiresAt > now)) {
    throw new ApiError(409, "invalid_state");
  }
}
const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const noQuerySchema = strict({});
const profileBaseUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash;
  });
const timeZoneSchema = z.string().min(1).max(80).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
});
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, "invalid_input");
  return result.data;
}
@Controller()
export class AdminController {
  constructor(
    @Inject(ADMIN_DATABASE) private readonly database: Database,
    @Inject("IDENTITY") private readonly identity: IdentityService,
    @Inject("DELIVERY") private readonly delivery: DeliveryService,
    @Inject("HEALTH_CONFIG")
    private readonly healthConfig: { model: boolean; qq: boolean },
    @Inject("MEMORY_LIFECYCLE") private readonly memoryLifecycle: MemoryLifecycleService,
  ) {}
  @Post("/admin/memory-revisions/:revisionId/approve") async approveMemoryRevision(
    @Param("revisionId") revisionId: string,
    @Body() raw: unknown,
    @Req() request: import("fastify").FastifyRequest & { adminPrincipal?: AuthenticatedAdminPrincipal },
  ) {
    const body = parse(strict({ expectedVersion: z.number().int().positive(), claimKind: z.literal("direct"), evidenceQuote: z.string().min(1).max(4000) }), raw);
    if (!isAuthenticatedAdminPrincipal(request.adminPrincipal)) throw new ApiError(401, "unauthorized");
    try {
      return await this.memoryLifecycle.approveCandidate(revisionId, body.expectedVersion, request.adminPrincipal, body);
    } catch (error) {
      if (!(error instanceof MemoryLifecycleError)) throw error;
      const status = error.code === "untrusted_actor" ? 401
        : error.code === "invalid_input" ? 400
          : error.code === "source_not_owned" ? 404
            : error.code === "source_unavailable" ? 422 : 409;
      throw new ApiError(status, error.code);
    }
  }
  @Get("/health") async health(@Query() query: unknown) {
    parse(noQuerySchema, query);
    const databaseReady = await checkDatabaseReady(this.database);
    return {
      status: databaseReady ? "ready" : "unready",
      databaseReady,
      configured: { model: this.healthConfig.model, qq: this.healthConfig.qq },
    };
  }
  @Get("/admin/people") async peopleList(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    return this.database.db
      .select({
        id: people.id,
        displayName: people.displayName,
        aliases: people.aliases,
        status: people.status,
        version: people.version,
        createdAt: people.createdAt,
      })
      .from(people)
      .orderBy(people.createdAt, people.id)
      .limit(p.limit)
      .offset(p.offset);
  }
  @Post("/admin/people") async createPerson(@Body() raw: unknown) {
    const b = parse(
      strict({
        displayName: z.string().trim().min(1).max(160).nullable().optional(),
        aliases: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
      }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(people)
        .values({
          displayName: b.displayName ?? null,
          aliases: b.aliases ?? [],
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "person_created",
        targetId: row.id,
        metadata: {},
      });
      return {
        id: row.id,
        displayName: row.displayName,
        aliases: row.aliases,
        status: row.status,
        version: row.version,
      };
    });
  }
  @Get("/admin/identities") async identities(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    return this.database.db
      .select({
        id: platformIdentities.id,
        personId: platformIdentities.personId,
        platform: platformIdentities.platform,
        platformUserId: platformIdentities.platformUserId,
        verifiedAt: platformIdentities.verifiedAt,
        verificationMethod: platformIdentities.verificationMethod,
      })
      .from(platformIdentities)
      .orderBy(platformIdentities.createdAt, platformIdentities.id)
      .limit(p.limit)
      .offset(p.offset);
  }
  @Get("/admin/identities/links") async identityLinks(@Query() query: unknown) {
    const page = parse(pageSchema, query);
    return this.database.db
      .select({
        aliasPersonId: personIdentityLinks.aliasPersonId,
        canonicalPersonId: personIdentityLinks.canonicalPersonId,
        createdAt: personIdentityLinks.createdAt,
      })
      .from(personIdentityLinks)
      .orderBy(personIdentityLinks.createdAt, personIdentityLinks.aliasPersonId)
      .limit(page.limit)
      .offset(page.offset);
  }
  @Get("/admin/characters") async listCharacters(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    return this.database.db
      .select()
      .from(characters)
      .orderBy(characters.createdAt, characters.id)
      .limit(p.limit)
      .offset(p.offset);
  }
  @Post("/admin/characters") async createCharacter(@Body() raw: unknown) {
    const b = parse(strict({ name: z.string().trim().min(1).max(160) }), raw);
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(characters)
        .values({ name: b.name })
        .returning();
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "character_created",
        targetId: row.id,
        metadata: {},
      });
      return row;
    });
  }
  @Get("/admin/characters/:id/primary-partner") async getPartner(
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    validUuid(id);
    parse(noQuerySchema, query);
    const [row] = await this.database.db
      .select()
      .from(primaryRelationshipBindings)
      .where(eq(primaryRelationshipBindings.characterId, id))
      .limit(1);
    return { personId: row?.personId ?? null };
  }
  @Put("/admin/characters/:id/primary-partner") async putPartner(
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    validUuid(id);
    const b = parse(strict({ personId: uuid }), raw);
    await this.identity.setPrimaryPartner(id, b.personId, {
      kind: "admin",
      auditActorId: "admin",
    });
    return { ok: true };
  }
  @Get("/admin/circles") async listCircles(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    return this.database.db
      .select()
      .from(socialCircles)
      .orderBy(socialCircles.createdAt, socialCircles.id)
      .limit(p.limit)
      .offset(p.offset);
  }
  @Post("/admin/circles") async createCircle(@Body() raw: unknown) {
    const b = parse(
      strict({ characterId: uuid, name: z.string().trim().min(1).max(160) }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(socialCircles)
        .values({ characterId: b.characterId, name: b.name })
        .returning();
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "circle_created",
        targetId: row.id,
        metadata: { characterId: b.characterId },
      });
      return row;
    });
  }
  @Post("/admin/circles/:id/members") async confirmMember(
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    validUuid(id);
    const b = parse(
      strict({ personId: uuid, confirmed: z.literal(true) }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [circle] = await tx
        .select()
        .from(socialCircles)
        .where(eq(socialCircles.id, id))
        .for("update")
        .limit(1);
      if (!circle) throw new ApiError(404, "not_found");
      const [row] = await tx
        .insert(circleMembers)
        .values({ circleId: id, personId: b.personId, confirmedAt: new Date() })
        .onConflictDoUpdate({
          target: [circleMembers.circleId, circleMembers.personId],
          set: { confirmedAt: new Date() },
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "circle_member_confirmed",
        targetId: id,
        metadata: { personId: b.personId },
      });
      return row;
    });
  }
  @Delete("/admin/circles/:id/members/:personId") async removeMember(
    @Param("id") id: string,
    @Param("personId") personId: string,
  ) {
    validUuid(id);
    validUuid(personId);
    return this.database.db.transaction(async (tx) => {
      const [circle] = await tx
        .select()
        .from(socialCircles)
        .where(eq(socialCircles.id, id))
        .for("update")
        .limit(1);
      if (!circle) throw new ApiError(404, "not_found");
      await tx
        .delete(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, id),
            eq(circleMembers.personId, personId),
          ),
        );
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "circle_member_removed",
        targetId: id,
        metadata: { personId },
      });
      return { ok: true };
    });
  }
  @Get("/admin/conversations/:id/policy") async getPolicy(
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    validUuid(id);
    parse(noQuerySchema, query);
    const [conversation] = await this.database.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conversation || conversation.kind !== "group")
      throw new ApiError(404, "not_found");
    const [row] = await this.database.db
      .select()
      .from(conversationPolicies)
      .where(eq(conversationPolicies.conversationId, id))
      .limit(1);
    if (!row) throw new ApiError(404, "not_found");
    return row;
  }
  @Put("/admin/conversations/:id/policy") async updatePolicy(
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    validUuid(id);
    const b = parse(
      strict({
        version: z.number().int().min(1),
        triggerMode: z.enum(["mentioned", "all", "disabled"]),
        circleDisclosureVerified: z.boolean(),
        proactiveEnabled: z.boolean().default(false),
        quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timeZone: timeZoneSchema,
        maxPerDay: z.number().int().min(0).max(100),
      }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (!conversation || conversation.kind !== "group")
        throw new ApiError(404, "not_found");
      const [old] = await tx
        .select()
        .from(conversationPolicies)
        .where(eq(conversationPolicies.conversationId, id))
        .for("update")
        .limit(1);
      if (!old) throw new ApiError(404, "not_found");
      if (old.version !== b.version)
        throw new ApiError(409, "version_conflict");
      const [row] = await tx
        .update(conversationPolicies)
        .set({ ...b, version: old.version + 1, updatedAt: new Date() })
        .where(
          and(
            eq(conversationPolicies.conversationId, id),
            eq(conversationPolicies.version, b.version),
          ),
        )
        .returning();
      if (!row) throw new ApiError(409, "version_conflict");
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "conversation_policy_updated",
        targetId: id,
        metadata: { version: row.version },
      });
      return row;
    });
  }
  @Get("/admin/model-profiles") async profiles(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    const rows = await this.database.db
      .select()
      .from(modelProfiles)
      .orderBy(modelProfiles.createdAt, modelProfiles.id)
      .limit(p.limit)
      .offset(p.offset);
    return rows.map(({ credentialRef, ...row }) => ({
      ...row,
      credentialRef,
      configured: Boolean(process.env[credentialRef]),
    }));
  }
  @Post("/admin/model-profiles") async createProfile(@Body() raw: unknown) {
    const b = parse(
      strict({
        name: z.string().trim().min(1).max(120),
        purpose: z.enum(["chat", "memory", "embedding", "search", "rerank"]),
        provider: z.string().trim().min(1).max(80),
        baseUrl: profileBaseUrlSchema,
        model: z.string().trim().min(1).max(160),
        credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
        dimensions: z.number().int().min(1).max(65536).nullable().optional(),
        maxTokens: z.number().int().min(1).max(100000).default(1024),
        timeoutMs: z.number().int().min(100).max(600000).default(30000),
        monthlyBudgetUsd: z
          .string()
          .regex(/^\d+(\.\d{1,4})?$/)
          .nullable()
          .optional(),
      }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(modelProfiles)
        .values({ ...b, enabled: false, lastTestStatus: "never" })
        .returning();
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "model_profile_created",
        targetId: row.id,
        metadata: { purpose: row.purpose },
      });
      const { credentialRef, ...safe } = row;
      return {
        ...safe,
        credentialRef,
        configured: Boolean(process.env[credentialRef]),
      };
    });
  }
  @Put("/admin/model-profiles/:id") async updateProfile(
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    validUuid(id);
    const b = parse(
      strict({
        version: z.number().int().min(1),
        name: z.string().trim().min(1).max(120),
        provider: z.string().trim().min(1).max(80),
        baseUrl: profileBaseUrlSchema,
        model: z.string().trim().min(1).max(160),
        credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
        dimensions: z.number().int().min(1).max(65536).nullable(),
        maxTokens: z.number().int().min(1).max(100000),
        timeoutMs: z.number().int().min(100).max(600000),
        monthlyBudgetUsd: z
          .string()
          .regex(/^\d+(\.\d{1,4})?$/)
          .nullable(),
      }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [old] = await tx
        .select()
        .from(modelProfiles)
        .where(eq(modelProfiles.id, id))
        .for("update")
        .limit(1);
      if (!old) throw new ApiError(404, "not_found");
      if (old.version !== b.version)
        throw new ApiError(409, "version_conflict");
      const [row] = await tx
        .update(modelProfiles)
        .set({
          name: b.name,
          provider: b.provider,
          baseUrl: b.baseUrl,
          model: b.model,
          credentialRef: b.credentialRef,
          dimensions: b.dimensions,
          maxTokens: b.maxTokens,
          timeoutMs: b.timeoutMs,
          monthlyBudgetUsd: b.monthlyBudgetUsd,
          enabled: false,
          lastTestAt: null,
          lastTestStatus: "never",
          version: old.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(eq(modelProfiles.id, id), eq(modelProfiles.version, b.version)),
        )
        .returning();
      if (!row) throw new ApiError(409, "version_conflict");
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "model_profile_updated",
        targetId: id,
        metadata: { version: row.version },
      });
      const { credentialRef, ...safe } = row;
      return {
        ...safe,
        credentialRef,
        configured: Boolean(process.env[credentialRef]),
      };
    });
  }
  @Get("/admin/characters/:id/model-bindings") async bindings(
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    validUuid(id);
    parse(noQuerySchema, query);
    return this.database.db
      .select()
      .from(modelRoleBindings)
      .where(eq(modelRoleBindings.characterId, id))
      .orderBy(modelRoleBindings.purpose);
  }
  @Put("/admin/characters/:id/model-bindings") async putBinding(
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    validUuid(id);
    const b = parse(
      strict({
        purpose: z.enum(["chat", "memory", "embedding", "search", "rerank"]),
        profileId: uuid,
      }),
      raw,
    );
    return this.database.db.transaction(async (tx) => {
      const [profile] = await tx
        .select()
        .from(modelProfiles)
        .where(
          and(
            eq(modelProfiles.id, b.profileId),
            eq(modelProfiles.purpose, b.purpose),
          ),
        )
        .limit(1);
      if (!profile) throw new ApiError(400, "profile_purpose_mismatch");
      const [row] = await tx
        .insert(modelRoleBindings)
        .values({ characterId: id, ...b })
        .onConflictDoUpdate({
          target: [modelRoleBindings.characterId, modelRoleBindings.purpose],
          set: { profileId: b.profileId },
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorKind: "admin",
        actorId: "admin",
        action: "model_binding_updated",
        targetId: id,
        metadata: { purpose: b.purpose, profileId: b.profileId },
      });
      return row;
    });
  }
  @Get("/admin/job-logs") async jobs(@Query() query: unknown) {
    const p = parse(jobPageSchema, query);
    return this.database.db
      .select()
      .from(jobLogs)
      .where(p.status ? eq(jobLogs.status, p.status) : undefined)
      .orderBy(desc(jobLogs.createdAt), desc(jobLogs.id))
      .limit(p.limit)
      .offset(p.offset);
  }
  @Get("/admin/worker/status") async workerStatus(@Query() query: unknown) {
    parse(noQuerySchema, query);
    const jobs = await this.database.db.select({ status: jobLogs.status, count: sql<number>`count(*)::int` }).from(jobLogs).groupBy(jobLogs.status);
    const outbox = await this.database.db.select({ status: businessOutbox.status, count: sql<number>`count(*)::int` }).from(businessOutbox).groupBy(businessOutbox.status);
    const queueSchemaReady = await checkWorkerQueueReady(this.database);
    return {
      queueSchemaReady,
      jobs: Object.fromEntries(jobs.map((row) => [row.status, Number(row.count)])),
      outbox: Object.fromEntries(outbox.map((row) => [row.status, Number(row.count)])),
      processorConfigured: false,
      senderConfigured: false,
    };
  }
  @Get("/admin/job-logs/:id") async jobDetail(@Param("id") id: string, @Query() query: unknown) {
    validUuid(id);
    parse(noQuerySchema, query);
    const [row] = await this.database.db.select().from(jobLogs).where(eq(jobLogs.id, id)).limit(1);
    if (!row) throw new ApiError(404, "not_found");
    return row;
  }
  @Post("/admin/job-logs/:id/retry") async retryJob(@Param("id") id: string, @Body() raw: unknown) {
    validUuid(id);
    parse(strict({}), raw);
    const outcome = await this.database.db.transaction(async (tx) => {
      const lockedDatabaseTime = async () => {
        const result = await tx.execute(sql`select clock_timestamp() as now`);
        return new Date((result.rows[0] as { now: string }).now);
      };
      const resetRetryRows = async (log: typeof jobLogs.$inferSelect, outbox: typeof businessOutbox.$inferSelect, now: Date) => {
        await tx.update(businessOutbox).set({ status: "pending", leaseOwner: null, leaseExpiresAt: null, availableAt: now, lastErrorCode: null, updatedAt: now }).where(eq(businessOutbox.id, outbox.id));
        await tx.update(jobLogs).set({ status: "pending", errorCode: null, nextRunAt: null, pgBossId: null, leaseOwner: null, leaseExpiresAt: null, version: sql`${jobLogs.version} + 1`, updatedAt: now }).where(eq(jobLogs.id, log.id));
      };
      // Read the immutable operation key without a row lock, then acquire locks in
      // dispatcher order: business_outbox before job_logs.
      const [logIdentity] = await tx.select({ operationKey: jobLogs.operationKey }).from(jobLogs).where(eq(jobLogs.id, id)).limit(1);
      if (!logIdentity) throw new ApiError(404, "not_found");
      const [outboxIdentity] = await tx.select().from(businessOutbox).where(eq(businessOutbox.operationKey, logIdentity.operationKey)).limit(1);
      if (!outboxIdentity) throw new ApiError(409, "invalid_state");
      let outbox: typeof businessOutbox.$inferSelect | undefined;
      let log: typeof jobLogs.$inferSelect | undefined;
      let delivery: typeof deliveryOutbox.$inferSelect | undefined;
      let turn: typeof turns.$inferSelect | undefined;
      let deliveryPayload: { turnId: string; deliveryId: string } | undefined;
      if (outboxIdentity.kind === "deliver_message") {
        const payload = z.object({ turnId: uuid, deliveryId: uuid }).safeParse(outboxIdentity.payload);
        if (!payload.success) throw new ApiError(409, "invalid_state");
        deliveryPayload = payload.data;
        // Reconcile locks delivery → turn → business outbox → job log. Match
        // that order here to avoid retry/reconcile deadlocks for receipt_unknown.
        [delivery] = await tx.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, payload.data.deliveryId)).for("update").limit(1);
        [turn] = delivery?.turnId ? await tx.select().from(turns).where(eq(turns.id, delivery.turnId)).for("update").limit(1) : [];
        [outbox] = await tx.select().from(businessOutbox).where(eq(businessOutbox.operationKey, logIdentity.operationKey)).for("update").limit(1);
        [log] = await tx.select().from(jobLogs).where(eq(jobLogs.id, id)).for("update").limit(1);
      } else {
        // Process retry follows dispatcher order: business outbox → job log.
        [outbox] = await tx.select().from(businessOutbox).where(eq(businessOutbox.operationKey, logIdentity.operationKey)).for("update").limit(1);
        [log] = await tx.select().from(jobLogs).where(eq(jobLogs.id, id)).for("update").limit(1);
      }
      if (!outbox || !log || log.operationKey !== logIdentity.operationKey || outbox.kind !== outboxIdentity.kind) throw new ApiError(409, "invalid_state");
      if (outbox.kind === "process_turn") {
        const payload = z.object({ turnId: uuid }).safeParse(outbox.payload);
        if (!payload.success) throw new ApiError(409, "invalid_state");
        [delivery] = await tx.select().from(deliveryOutbox).where(eq(deliveryOutbox.turnId, payload.data.turnId)).for("update").limit(1);
        [turn] = await tx.select().from(turns).where(eq(turns.id, payload.data.turnId)).for("update").limit(1);
        const now = await lockedDatabaseTime();
        assertRetryableLeases(log, outbox, now);
        const expiredProcessing = turn?.status === "processing" && (!turn.leaseExpiresAt || turn.leaseExpiresAt <= now);
        const unavailable = log.errorCode === "processor_unavailable";
        const expiredAttempt = log.status === "running" && (!log.leaseExpiresAt || log.leaseExpiresAt <= now);
        if (!turn || outbox.operationKey !== `turn:${turn.id}:process` || delivery || (turn.leaseExpiresAt && turn.leaseExpiresAt > now) || (turn.status !== "failed" && !expiredProcessing && !(turn.status === "received" && (unavailable || expiredAttempt)))) throw new ApiError(409, "invalid_state");
        if (turn.status !== "received") await tx.update(turns).set({ status: "received", errorCode: null, leaseOwner: null, leaseExpiresAt: null, version: sql`${turns.version} + 1`, updatedAt: now }).where(eq(turns.id, turn.id));
        await resetRetryRows(log, outbox, now);
      } else if (outbox.kind === "deliver_message") {
        const now = await lockedDatabaseTime();
        assertRetryableLeases(log, outbox, now);
        const unavailable = log.errorCode === "sender_unavailable";
        const expiredAttempt = log.status === "running" && (!log.leaseExpiresAt || log.leaseExpiresAt <= now);
        if (!deliveryPayload || !delivery || !turn || delivery.turnId !== deliveryPayload.turnId || delivery.id !== deliveryPayload.deliveryId || delivery.operationKey !== outbox.operationKey || outbox.operationKey !== `turn:${turn.id}:deliver` || delivery.platformReceipt || (delivery.leaseExpiresAt && delivery.leaseExpiresAt > now) || (delivery.status !== "failed" && !(delivery.status === "pending" && (unavailable || expiredAttempt))) || (delivery.status === "failed" && turn.status !== "failed") || (delivery.status === "pending" && turn.status !== "generated")) throw new ApiError(409, "invalid_state");
        if (delivery.status === "failed") await tx.update(deliveryOutbox).set({ status: "pending", errorCode: null, leaseOwner: null, leaseExpiresAt: null, version: sql`${deliveryOutbox.version} + 1`, updatedAt: now }).where(eq(deliveryOutbox.id, delivery.id));
        await tx.update(turns).set({ status: "generated", errorCode: null, version: sql`${turns.version} + 1`, updatedAt: now }).where(eq(turns.id, delivery.turnId));
        await resetRetryRows(log, outbox, now);
      } else throw new ApiError(409, "invalid_state");
      await tx.insert(auditEvents).values({ actorKind: "admin", actorId: "admin", action: "job_retried", targetId: log.id, metadata: { operationKey: log.operationKey, queueName: log.queueName } });
      return { ok: true };
    });
    return outcome;
  }
  @Get("/admin/turns") async turnList(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    return this.database.db
      .select()
      .from(turns)
      .orderBy(desc(turns.createdAt), desc(turns.id))
      .limit(p.limit)
      .offset(p.offset);
  }
  @Get("/admin/deliveries") async deliveryList(@Query() query: unknown) {
    const p = parse(pageSchema, query);
    return this.database.db
      .select()
      .from(deliveryOutbox)
      .orderBy(desc(deliveryOutbox.createdAt), desc(deliveryOutbox.id))
      .limit(p.limit)
      .offset(p.offset);
  }
  @Post("/admin/deliveries/:id/reconcile") async reconcile(
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    validUuid(id);
    const b = parse(
      strict({
        decision: z.enum(["sent", "retry"]),
        receipt: z.string().trim().min(1).max(512).optional(),
      }),
      raw,
    );
    if (
      (b.decision === "sent" && !b.receipt) ||
      (b.decision === "retry" && b.receipt)
    )
      throw new ApiError(400, "invalid_input");
    try {
      await this.delivery.reconcile(
        id,
        b.decision,
        { kind: "admin", auditActorId: "admin" },
        b.receipt,
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "invalid_state") throw new ApiError(409, "invalid_state");
      if (code === "invalid_input") throw new ApiError(400, "invalid_input");
      throw error;
    }
    return { ok: true };
  }
}
function validUuid(value: string) {
  if (!uuid.safeParse(value).success) throw new ApiError(400, "invalid_input");
}
