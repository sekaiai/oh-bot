import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { deletionRecords, jobLogs, knowledgeClaims, memoryIndexes, memoryMappings, memoryRevisions, memorySources, memoryValidationRecords, messages, personEntities, relationshipEdges } from '../database/schema/index.js';
import type { Database } from '../database/database.js';
import type { ActorContext } from '../domain/contracts.js';
import { isTrustedActorContext } from '../identity/trust.js';
import type { Memory } from 'mem0ai/oss';
import { MemoryLifecycleService } from './memory-lifecycle-service.js';
import { MemoryReadService, type ReadableMemory } from './memory-read-service.js';
import { appendDeletionJournal, assertDeletionJournalReplayed, replayDeletionJournal } from './memory-deletion-journal.js';

export interface MemoryEngine extends Pick<Memory, 'add' | 'search' | 'delete' | 'get'> {
  /** Exact source-scoped enumeration; unlike search this must not rank/filter results. */
  getAll?: Memory['getAll'];
  deleteHistory(memoryId: string): Promise<number>;
}
export type MemoryEngineResolver = (indexId: string) => Promise<MemoryEngine>;
export type MemoryRecall = Readonly<{ context: string; results: readonly ReadableMemory[]; degraded: boolean }>;

function terms(text: string): string[] {
  const normalized = text.toLocaleLowerCase().normalize('NFKC');
  const chunks = normalized.match(/[\p{Script=Han}\p{Letter}\p{Number}]+/gu) ?? [];
  const result = new Set<string>();
  for (const chunk of chunks) {
    result.add(chunk);
    if (/\p{Script=Han}/u.test(chunk)) for (let i = 0; i + 1 < chunk.length; i++) result.add(chunk.slice(i, i + 2));
  }
  return [...result].filter((term) => term.length > 0);
}

/** One entry point for source registration, authorized recall, asynchronous Mem0 work, and deletion. */
export class MemoryGateway {
  constructor(
    private readonly database: Database,
    private readonly lifecycle: MemoryLifecycleService,
    private readonly reads: MemoryReadService,
    private readonly engine: MemoryEngine,
    private readonly resolveTrustedActor: (source: typeof memorySources.$inferSelect) => Promise<ActorContext>,
    private readonly deletionJournalPath = process.env.MEMORY_DELETION_JOURNAL_PATH,
    private readonly resolveIndexEngine?: MemoryEngineResolver,
  ) {}

  /** Persists only the source and durable job. Mem0 extraction runs later in processPending(). */
  async record(actor: ActorContext, messageId: string): Promise<typeof memorySources.$inferSelect> {
    if (!isTrustedActorContext(actor)) throw new Error('untrusted actor context');
    const source = await this.lifecycle.recordUserSource(actor, messageId);
    const op = `mem0-sync:${source.id}`;
    await this.database.db.insert(jobLogs).values({ operationKey: op, queueName: 'memory_sync', status: 'pending' })
      .onConflictDoNothing({ target: jobLogs.operationKey });
    return source;
  }

  /** Retrieves only validated current revisions authorized by the existing disclosure ledger. */
  async recall(actor: ActorContext, query: string, options: { limit?: number } = {}): Promise<MemoryRecall> {
    if (!isTrustedActorContext(actor)) throw new Error('untrusted actor context');
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid memory recall limit');
    let degraded = false;
    const lexicalTerms = terms(query);
    let engineIds = new Set<string>();
    try {
      const searchEngine = await this.engineForCharacter(actor.characterId);
      const search = await searchEngine.search(query, { filters: { agent_id: actor.characterId, user_id: actor.personId }, topK: 50 });
      engineIds = new Set(search.results.map((item) => item.id));
    } catch { degraded = true; }
    const termPredicates = lexicalTerms.map((term) => sql`${memoryRevisions.factText} ilike ${`%${term}%`}`);
    const scoreTerms = lexicalTerms.map((term) => sql`case when ${memoryRevisions.factText} ilike ${`%${term}%`} then 1 else 0 end`);
    const lexicalScore = scoreTerms.length ? sql<number>`(${sql.join(scoreTerms, sql` + `)})` : sql<number>`0`;
    const exactScore = query.trim() ? sql<number>`case when ${memoryRevisions.factText} ilike ${`%${query.trim()}%`} then 100 else 0 end` : sql<number>`0`;
    const candidatePredicate = or(
      ...(termPredicates.length ? termPredicates : []),
      ...(engineIds.size ? [inArray(memoryRevisions.engineMemoryId, [...engineIds]), inArray(memoryMappings.engineMemoryId, [...engineIds])] : []),
    );
    if (!candidatePredicate) return { context: '', results: [], degraded };
    const callerOwnedPeople = [...new Set([actor.personId, ...actor.linkedPersonIds])];
    const candidateScopes = [
      sql`${memorySources.scope}->>'kind' = 'character_public'`,
      sql`(${memorySources.scope}->>'kind' = 'conversation_shared' and ${memorySources.scope}->>'conversationId' = ${actor.conversationId})`,
    ];
    if (callerOwnedPeople.length) candidateScopes.push(sql`(${memorySources.scope}->>'kind' in ('person_private','partner_private') and ${memorySources.scope}->>'personId' in (${sql.join(callerOwnedPeople.map((id) => sql`${id}`), sql`, `)}))`);
    if (actor.circleIds.length) candidateScopes.push(sql`(${memorySources.scope}->>'kind' = 'circle_shared' and ${memorySources.scope}->>'circleId' in (${sql.join(actor.circleIds.map((id) => sql`${id}`), sql`, `)}))`);
    const candidateRows = await this.database.db.select({ revisionId: memoryRevisions.id, engineMemoryId: memoryRevisions.engineMemoryId, mappedEngineMemoryId: memoryMappings.engineMemoryId })
      .from(memoryRevisions).innerJoin(memorySources, eq(memorySources.id, memoryRevisions.sourceId))
      .innerJoin(messages, eq(messages.id, memorySources.messageId))
      .leftJoin(memoryMappings, eq(memoryMappings.revisionId, memoryRevisions.id))
      .where(and(
        eq(memoryRevisions.characterId, actor.characterId), eq(memoryRevisions.status, 'validated'), isNull(memoryRevisions.validTo),
        eq(memorySources.status, 'active'), isNull(memorySources.deletedAt), eq(memorySources.sourceKind, 'user'),
        eq(memorySources.claimKind, 'direct'), eq(memorySources.allowedForExtraction, true), eq(messages.role, 'user'),
        isNull(messages.deletedAt), candidatePredicate, or(...candidateScopes),
      ))
      .orderBy(desc(sql`${exactScore} + ${lexicalScore}`), desc(memoryRevisions.validFrom), asc(memoryRevisions.id))
      .limit(1000);
    const candidateIds = [...new Set(candidateRows.map((row) => row.revisionId))];
    const visible = await this.reads.listCandidatesForActor(actor, candidateIds);
    const engineIdByRevision = new Map(candidateRows.flatMap((row) => {
      const id = row.engineMemoryId ?? row.mappedEngineMemoryId;
      return id ? [[row.revisionId, id] as const] : [];
    }));
    const scored = visible.map((item) => {
      const bodyTerms = new Set(terms(item.factText));
      const overlap = lexicalTerms.filter((term) => bodyTerms.has(term)).length;
      return { item, score: overlap * 2 + (engineIds.has(engineIdByRevision.get(item.revisionId) ?? '') ? 1 : 0) };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
    const fresh = await this.reads.listCandidatesForActor(actor, candidateIds);
    const freshById = new Map(fresh.map((item) => [item.revisionId, item]));
    const results = scored.filter(({ item }) => freshById.get(item.revisionId)?.version === item.version)
      .map(({ item }) => freshById.get(item.revisionId)!).slice(0, limit);
    return { context: results.map((item) => item.factText).join('\n'), results, degraded };
  }

  /** Claims durable jobs with a lease; at-least-once SDK adds use stable source metadata for dedupe. */
  async processPending(): Promise<{ processed: number; failed: number }> {
    const now = new Date();
    const leaseOwner = randomUUID();
    const pending = await this.database.db.transaction(async (tx) => {
      const rows = await tx.select().from(jobLogs).where(and(eq(jobLogs.queueName, 'memory_sync'), or(
        eq(jobLogs.status, 'pending'), and(eq(jobLogs.status, 'failed'), or(isNull(jobLogs.nextRunAt), lt(jobLogs.nextRunAt, now))),
        and(eq(jobLogs.status, 'running'), or(isNull(jobLogs.leaseExpiresAt), lt(jobLogs.leaseExpiresAt, now))),
      )))
        .orderBy(sql`case when ${jobLogs.status} = 'pending' then 0 else 1 end`, asc(jobLogs.nextRunAt), asc(jobLogs.createdAt)).limit(20).for('update', { skipLocked: true });
      for (const job of rows) await tx.update(jobLogs).set({ status: 'running', attempts: job.attempts + 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000), nextRunAt: null, version: sql`${jobLogs.version} + 1` }).where(eq(jobLogs.id, job.id));
      return rows;
    });
    let processed = 0, failed = 0;
    for (const job of pending) {
      const sourceId = job.operationKey.slice('mem0-sync:'.length);
      const [source] = await this.database.db.select().from(memorySources).where(eq(memorySources.id, sourceId)).limit(1);
      const [message] = source ? await this.database.db.select().from(messages).where(eq(messages.id, source.messageId)).limit(1) : [];
      if (!source || source.status !== 'active' || source.deletedAt || source.sourceKind !== 'user' || source.claimKind !== 'direct' || !source.allowedForExtraction || !message || message.role !== 'user' || message.deletedAt || !message.text?.trim()) {
        await this.finishClaimedJob(job.id, leaseOwner, job.version + 1, 'completed');
        continue;
      }
      try {
        const actor = await this.resolveTrustedActor(source);
        if (!isTrustedActorContext(actor) || actor.characterId !== source.characterId || actor.conversationId !== source.conversationId) throw new Error('trusted actor resolver returned mismatched context');
        const filters = { agent_id: source.characterId, user_id: source.personId!, run_id: source.id };
        const sourceEngine = await this.engineForCharacter(source.characterId);
        const existing = await sourceEngine.search(message.text, { filters, topK: 100 });
        const outcome = existing.results.length ? existing : await sourceEngine.add(message.text, {
          userId: source.personId!, agentId: source.characterId, runId: source.id,
          metadata: { source_id: source.id, message_id: source.messageId, scope: source.scope },
        });
        // Persist every engine output as an untrusted candidate; lifecycle still checks user source/evidence.
        for (const result of outcome.results) {
          const canonicalKey = `mem0:${result.id}`;
          try {
            await this.lifecycle.recordCandidate(actor, { sourceId: source.id, canonicalKey, factText: result.memory, engineMemoryId: result.id });
          } catch (error) {
            const [freshSource] = await this.database.db.select().from(memorySources).where(eq(memorySources.id, source.id)).limit(1);
            if (!freshSource || freshSource.status !== 'active' || freshSource.deletedAt) {
              const tombstones = await this.database.db.select().from(deletionRecords).where(and(eq(deletionRecords.characterId, source.characterId), sql`${source.id} = any(${deletionRecords.sourceIds})`));
              for (const tombstone of tombstones) {
                if (!this.deletionJournalPath) throw new Error('memory deletion journal path is required');
                // Persist the late ID in the independent journal before changing
                // the ledger, so a restored DB still discovers this engine write.
                const late = await appendDeletionJournal(this.deletionJournalPath, { operationKey: `${tombstone.operationKey}:late:${result.id}`, characterId: tombstone.characterId, sourceIds: tombstone.sourceIds, memoryIds: [result.id], scope: tombstone.scope });
                const [intent] = await this.database.db.insert(deletionRecords).values({ characterId: tombstone.characterId, personId: tombstone.personId, scope: tombstone.scope, sourceIds: tombstone.sourceIds, memoryIds: [result.id], operationKey: late.operationKey, status: 'pending', journalSequence: BigInt(late.sequence) }).onConflictDoNothing({ target: deletionRecords.operationKey }).returning({ id: deletionRecords.id });
                if (intent) await this.database.db.insert(jobLogs).values({ operationKey: `mem0-delete:${intent.id}`, queueName: 'memory_delete', status: 'pending' }).onConflictDoNothing({ target: jobLogs.operationKey });
              }
              continue;
            }
            throw error;
          }
        }
        await this.finishClaimedJob(job.id, leaseOwner, job.version + 1, 'completed');
        processed++;
      } catch {
        await this.finishClaimedJob(job.id, leaseOwner, job.version + 1, 'failed', 'memory_sync_failed', Math.min(3_600_000, 1_000 * 2 ** Math.min(job.attempts, 12)));
        failed++;
      }
    }
    return { processed, failed };
  }

  /** Ledger tombstone hides a source immediately; this worker physically removes each SDK ID and its history. */
  async deleteEngineMemory(memoryId: string): Promise<void> {
    if (await this.engine.get(memoryId)) await this.engine.delete(memoryId);
    await this.engine.deleteHistory(memoryId);
  }

  private async deleteSourceMemories(record: typeof deletionRecords.$inferSelect): Promise<void> {
    const { sourceIds } = record;
    const explicitIds = record.memoryIds;
    if (!sourceIds.length) {
      for (const id of explicitIds) await this.deleteQualifiedMemory(id);
      return;
    }
    const revisions = await this.database.db.select({ id: memoryRevisions.id, engineMemoryId: memoryRevisions.engineMemoryId })
      .from(memoryRevisions).where(inArray(memoryRevisions.sourceId, sourceIds));
    const revisionIds = revisions.map((revision) => revision.id);
    const validations = await this.database.db.select({ engineMemoryId: memoryValidationRecords.engineMemoryId })
      .from(memoryValidationRecords).where(inArray(memoryValidationRecords.sourceId, sourceIds));
    const mappings = revisionIds.length ? await this.database.db.select({ engineMemoryId: memoryMappings.engineMemoryId, indexId: memoryMappings.indexId })
      .from(memoryMappings).where(inArray(memoryMappings.revisionId, revisionIds)) : [];
    const sources = await this.database.db.select({ id: memorySources.id, characterId: memorySources.characterId }).from(memorySources).where(inArray(memorySources.id, sourceIds));
    const characterIds = [...new Set(sources.map((source) => source.characterId))];
    const indexes = characterIds.length ? await this.database.db.select().from(memoryIndexes).where(inArray(memoryIndexes.characterId, characterIds)) : [];
    const targets = new Map<string, MemoryEngine>([['primary', this.engine]]);
    for (const index of indexes) targets.set(index.id, this.resolveIndexEngine ? await this.resolveIndexEngine(index.id) : this.engine);
    const qualified = new Set<string>();
    const encode = (indexId: string, id: string) => indexId === 'primary' ? id : `${indexId}|${id}`;
    for (const id of explicitIds) qualified.add(id.includes('|') ? id : encode('primary', id));
    for (const mapping of mappings) qualified.add(encode(mapping.indexId, mapping.engineMemoryId));
    for (const revision of revisions) if (revision.engineMemoryId) qualified.add(encode('primary', revision.engineMemoryId));
    for (const validation of validations) if (validation.engineMemoryId) qualified.add(encode('primary', validation.engineMemoryId));

    // Exact getAll enumeration includes expired rows and does not embed/rank the
    // source ID. Mem0's API has no cursor; hitting the ceiling fails closed.
    const enumerationLimit = 100_000;
    for (const [indexId, target] of targets) {
      if (!target.getAll) throw new Error('exact memory enumeration is unavailable');
      for (const sourceId of sourceIds) {
        const listed = await target.getAll({ filters: { run_id: sourceId }, topK: enumerationLimit, showExpired: true });
        if (listed.results.length >= enumerationLimit) throw new Error('exact memory enumeration limit reached');
        for (const result of listed.results) qualified.add(encode(indexId, result.id));
      }
    }
    // Keep every discovered engine-qualified ID before the first external
    // deletion, so a crash can resume even after the vector row is gone.
    await this.database.db.update(deletionRecords)
      .set({ memoryIds: [...qualified] })
      .where(and(eq(deletionRecords.id, record.id), eq(deletionRecords.status, 'pending')));
    for (const encoded of qualified) await this.deleteQualifiedMemory(encoded);
    if (revisionIds.length) {
      await this.database.db.delete(memoryMappings).where(inArray(memoryMappings.revisionId, revisionIds));
      await this.database.db.update(memoryRevisions).set({ engineMemoryId: null }).where(inArray(memoryRevisions.id, revisionIds));
    }
    await this.database.db.update(memoryValidationRecords).set({ engineMemoryId: null }).where(inArray(memoryValidationRecords.sourceId, sourceIds));
  }

  private async deleteQualifiedMemory(encoded: string): Promise<void> {
    const separator = encoded.indexOf('|');
    const indexId = separator < 0 ? 'primary' : encoded.slice(0, separator);
    const memoryId = separator < 0 ? encoded : encoded.slice(separator + 1);
    const target = indexId === 'primary' ? this.engine : this.resolveIndexEngine ? await this.resolveIndexEngine(indexId) : this.engine;
    await this.deleteFromEngine(target, memoryId);
  }

  private async deleteFromEngine(target: MemoryEngine, memoryId: string) {
    if (await target.get(memoryId)) await target.delete(memoryId);
    await target.deleteHistory(memoryId);
  }

  private async engineForCharacter(characterId: string): Promise<MemoryEngine> {
    const [active] = await this.database.db.select({ id: memoryIndexes.id }).from(memoryIndexes)
      .where(and(eq(memoryIndexes.characterId, characterId), eq(memoryIndexes.status, 'active'))).limit(1);
    if (!active) return this.engine;
    if (!this.resolveIndexEngine) throw new Error('active memory index engine is unavailable');
    return this.resolveIndexEngine(active.id);
  }

  private async finishClaimedJob(id: string, owner: string, version: number, status: 'completed' | 'failed', errorCode?: string, retryDelayMs = 0): Promise<boolean> {
    const [updated] = await this.database.db.update(jobLogs).set({ status, errorCode: errorCode ?? null, leaseOwner: null, leaseExpiresAt: null,
      nextRunAt: status === 'failed' ? new Date(Date.now() + retryDelayMs) : null, version: sql`${jobLogs.version} + 1` })
      .where(and(eq(jobLogs.id, id), eq(jobLogs.leaseOwner, owner), eq(jobLogs.version, version), eq(jobLogs.status, 'running'))).returning({ id: jobLogs.id });
    return Boolean(updated);
  }

  /** Marks the trusted correction/forget decision immediately and schedules durable physical erasure. */
  async forget(actor: ActorContext, sourceId: string) {
    if (!this.deletionJournalPath) throw new Error('memory deletion journal path is required');
    let sequence = 0;
    const tombstone = await this.lifecycle.forgetSource(actor, sourceId, async (entry) => {
      sequence = (await appendDeletionJournal(this.deletionJournalPath!, entry)).sequence;
    });
    if (sequence) await this.database.db.update(deletionRecords).set({ journalSequence: BigInt(sequence) }).where(eq(deletionRecords.id, tombstone.id));
    await this.database.db.insert(jobLogs).values({ operationKey: `mem0-delete:${tombstone.id}`, queueName: 'memory_delete', status: 'pending' })
      .onConflictDoNothing({ target: jobLogs.operationKey });
    return tombstone;
  }

  /** Replaces a grounded revision immediately and schedules its new source for asynchronous extraction. */
  async correct(actor: ActorContext, input: { revisionId: string; expectedVersion: number; messageId: string; factText: string }) {
    const revision = await this.lifecycle.correctRevision(actor, input);
    const [source] = await this.database.db.select().from(memorySources).where(eq(memorySources.id, revision.sourceId)).limit(1);
    if (!source) throw new Error('corrected memory source is unavailable');
    await this.database.db.insert(jobLogs).values({ operationKey: `mem0-sync:${source.id}`, queueName: 'memory_sync', status: 'pending' })
      .onConflictDoNothing({ target: jobLogs.operationKey });
    return revision;
  }

  async correctAsAdmin(input: { revisionId: string; expectedVersion: number; messageId: string; factText: string; evidenceQuote: string }, principal: unknown, auditReason: string) {
    return this.lifecycle.correctRevisionAsAdmin(input, principal, auditReason);
  }

  async forgetRevisionAsAdmin(revisionId: string, expectedVersion: number, principal: unknown, auditReason: string) {
    if (!this.deletionJournalPath) throw new Error('memory deletion journal path is required');
    let sequence = 0;
    const tombstone = await this.lifecycle.forgetRevisionAsAdmin(revisionId, expectedVersion, principal, auditReason, async (entry) => {
      sequence = (await appendDeletionJournal(this.deletionJournalPath!, entry)).sequence;
    });
    if (sequence) await this.database.db.update(deletionRecords).set({ journalSequence: BigInt(sequence) }).where(eq(deletionRecords.id, tombstone.id));
    await this.database.db.insert(jobLogs).values({ operationKey: `mem0-delete:${tombstone.id}`, queueName: 'memory_delete', status: 'pending' }).onConflictDoNothing({ target: jobLogs.operationKey });
    return tombstone;
  }

  async processDeletions(): Promise<{ processed: number; failed: number }> {
    if (!this.deletionJournalPath) throw new Error('memory deletion journal path is required');
    {
      await replayDeletionJournal(this.deletionJournalPath, async (entry) => {
        await this.applyJournalIntent(entry);
      });
    }
    const now = new Date();
    const leaseOwner = randomUUID();
    const jobs = await this.database.db.transaction(async (tx) => {
      const rows = await tx.select().from(jobLogs).where(and(eq(jobLogs.queueName, 'memory_delete'), or(
        eq(jobLogs.status, 'pending'), and(eq(jobLogs.status, 'failed'), or(isNull(jobLogs.nextRunAt), lt(jobLogs.nextRunAt, now))),
        and(eq(jobLogs.status, 'running'), or(isNull(jobLogs.leaseExpiresAt), lt(jobLogs.leaseExpiresAt, now))),
      ))).orderBy(sql`case when ${jobLogs.status} = 'pending' then 0 else 1 end`, asc(jobLogs.nextRunAt), asc(jobLogs.createdAt)).limit(20).for('update', { skipLocked: true });
      for (const job of rows) await tx.update(jobLogs).set({ status: 'running', attempts: job.attempts + 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000), nextRunAt: null, version: sql`${jobLogs.version} + 1` }).where(eq(jobLogs.id, job.id));
      return rows;
    });
    let processed = 0, failed = 0;
    for (const job of jobs) {
      const recordId = job.operationKey.slice('mem0-delete:'.length);
      const [record] = await this.database.db.select().from(deletionRecords).where(eq(deletionRecords.id, recordId)).limit(1);
      if (!record || record.status === 'applied') {
        await this.finishClaimedJob(job.id, leaseOwner, job.version + 1, 'completed');
        continue;
      }
      try {
        await this.deleteSourceMemories(record);
        if (await this.finishDeletionClaim(job.id, record.id, leaseOwner, job.version + 1)) processed++;
      } catch {
        await this.finishClaimedJob(job.id, leaseOwner, job.version + 1, 'failed', 'memory_delete_failed', Math.min(3_600_000, 1_000 * 2 ** Math.min(job.attempts, 12)));
        failed++;
      }
    }
    return { processed, failed };
  }

  /** Restore/reindex must keep services closed while any durable tombstone is unapplied. */
  async assertDeletionJournalReplayed(): Promise<void> {
    if (!this.deletionJournalPath) throw new Error('memory deletion journal path is required');
    {
      await replayDeletionJournal(this.deletionJournalPath, async (entry) => this.applyJournalIntent(entry));
    }
    const cleanup = await this.processDeletions();
    if (cleanup.failed) throw new Error('deletion journal replay cleanup failed');
    await assertDeletionJournalReplayed(this.database, this.deletionJournalPath);
  }

  private async applyJournalIntent(entry: { sequence: number; operationKey: string; characterId: string; sourceIds: string[]; memoryIds: string[]; scope: typeof memorySources.$inferSelect.scope }) {
    await this.database.db.transaction(async (tx) => {
      const now = new Date();
      const personId = entry.scope.kind === 'person_private' || entry.scope.kind === 'partner_private' ? entry.scope.personId : null;
      const [existing] = await tx.select().from(deletionRecords).where(eq(deletionRecords.operationKey, entry.operationKey)).for('update').limit(1);
      let recordId: string;
      if (existing) {
        // A journal replay is a reconciliation pass, not a new deletion. Keep
        // immutable applied receipts and don't revoke a failed/backed-off or
        // currently leased cleanup job.
        if (existing.status === 'applied') return;
        recordId = existing.id;
        await tx.update(deletionRecords).set({ journalSequence: BigInt(entry.sequence), memoryIds: [...new Set([...existing.memoryIds, ...entry.memoryIds])], sourceIds: [...new Set([...existing.sourceIds, ...entry.sourceIds])] }).where(eq(deletionRecords.id, existing.id));
      } else {
        const [record] = await tx.insert(deletionRecords).values({ characterId: entry.characterId, personId, scope: entry.scope, sourceIds: entry.sourceIds, memoryIds: entry.memoryIds, operationKey: entry.operationKey, status: 'pending', journalSequence: BigInt(entry.sequence) }).returning({ id: deletionRecords.id });
        if (!record) throw new Error('deletion journal intent could not be persisted');
        recordId = record.id;
      }
      await tx.insert(jobLogs).values({ operationKey: `mem0-delete:${recordId}`, queueName: 'memory_delete', status: 'pending' })
        .onConflictDoNothing({ target: jobLogs.operationKey });
      await tx.update(memorySources).set({ status: 'deleted', deletedAt: sql`coalesce(${memorySources.deletedAt}, ${now})` }).where(inArray(memorySources.id, entry.sourceIds));
      await tx.update(memoryRevisions).set({ status: 'deleted', factText: '[forgotten]', validTo: sql`coalesce(${memoryRevisions.validTo}, ${now})`, version: sql`${memoryRevisions.version} + 1` }).where(and(inArray(memoryRevisions.sourceId, entry.sourceIds), sql`${memoryRevisions.status} <> 'deleted'`));
      const sourceRows = await tx.select({ messageId: memorySources.messageId }).from(memorySources).where(inArray(memorySources.id, entry.sourceIds));
      const messageIds = sourceRows.map((row) => row.messageId);
      await this.lifecycle.eraseSourceDerivedText(tx, entry.sourceIds, messageIds, now);
    });
  }

  private async finishDeletionClaim(jobId: string, recordId: string, owner: string, version: number): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [job] = await tx.update(jobLogs).set({ status: 'completed', errorCode: null, leaseOwner: null, leaseExpiresAt: null, nextRunAt: null,
        version: sql`${jobLogs.version} + 1` })
        .where(and(eq(jobLogs.id, jobId), eq(jobLogs.leaseOwner, owner), eq(jobLogs.version, version), eq(jobLogs.status, 'running')))
        .returning({ id: jobLogs.id });
      if (!job) return false;
      await tx.update(deletionRecords).set({ status: 'applied', appliedAt: sql`coalesce(${deletionRecords.appliedAt}, now())` })
        .where(and(eq(deletionRecords.id, recordId), eq(deletionRecords.status, 'pending')));
      return true;
    });
  }
}
