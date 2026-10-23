import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Memory } from 'mem0ai/oss';
import { memoryIndexes, memoryMappings, memoryRevisions, memorySources, memoryValidationRecords, messages, modelProfiles } from '../database/schema/index.js';
import type { Database } from '../database/database.js';
import { assertDeletionJournalReplayed } from './memory-deletion-journal.js';

type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export type MemoryIndexSpec = Readonly<{ characterId: string; modelProfileId: string; provider: string; model: string; dimensions: number; preprocessingVersion: string; collectionName: string }>;
export type MemoryIndexEngine = Pick<Memory, 'add' | 'search' | 'delete' | 'get'> & { deleteHistory(memoryId: string): Promise<number> };
export type MemoryIndexEngineConfiguration = Readonly<Pick<MemoryIndexSpec, 'provider' | 'model' | 'dimensions' | 'preprocessingVersion' | 'collectionName'> & { indexId: string }>;
export type MemoryIndexEngineHandle = Readonly<{ engine: MemoryIndexEngine; configuration: MemoryIndexEngineConfiguration }>;
export type MemoryIndexEngineFactory = (index: typeof memoryIndexes.$inferSelect, profile: typeof modelProfiles.$inferSelect) => Promise<MemoryIndexEngineHandle>;

type EligibleRevision = {
  revision: typeof memoryRevisions.$inferSelect;
  source: typeof memorySources.$inferSelect;
  message: typeof messages.$inferSelect;
  evidenceQuote: string | null;
};

function isGroundedCurrent(row: EligibleRevision): boolean {
  return row.revision.status === 'validated' && row.revision.validTo === null &&
    row.source.status === 'active' && row.source.deletedAt === null && row.source.sourceKind === 'user' &&
    row.source.claimKind === 'direct' && row.source.allowedForExtraction && row.message.role === 'user' &&
    row.message.deletedAt === null && typeof row.message.text === 'string' && row.message.text.trim().length > 0 &&
    typeof row.revision.factText === 'string' && row.revision.factText.trim().length > 0 &&
    ((typeof row.evidenceQuote === 'string' && row.evidenceQuote.trim().length > 0 && row.message.text.includes(row.evidenceQuote)) ||
      (row.evidenceQuote === null && row.message.text.includes(row.revision.factText)));
}

async function eligibleRevisions(tx: Transaction, characterId: string, lock = false): Promise<EligibleRevision[]> {
  let query = tx.select({
    revision: memoryRevisions,
    source: memorySources,
    message: messages,
    evidenceQuote: memoryValidationRecords.evidenceQuote,
  }).from(memoryRevisions)
    .innerJoin(memorySources, eq(memorySources.id, memoryRevisions.sourceId))
    .innerJoin(messages, eq(messages.id, memorySources.messageId))
    .innerJoin(memoryValidationRecords, and(
      eq(memoryValidationRecords.sourceId, memorySources.id),
      eq(memoryValidationRecords.status, 'validated'),
      or(
        eq(memoryValidationRecords.engineMemoryId, memoryRevisions.engineMemoryId!),
        and(isNull(memoryRevisions.engineMemoryId), isNull(memoryValidationRecords.engineMemoryId)),
      ),
    ))
    .where(and(
      eq(memoryRevisions.characterId, characterId), eq(memoryRevisions.status, 'validated'), isNull(memoryRevisions.validTo),
      eq(memorySources.characterId, characterId), eq(memorySources.status, 'active'), isNull(memorySources.deletedAt),
      eq(memorySources.sourceKind, 'user'), eq(memorySources.claimKind, 'direct'), eq(memorySources.allowedForExtraction, true),
      eq(messages.role, 'user'), isNull(messages.deletedAt),
    ));
  if (lock) query = query.for('update') as typeof query;
  const rows = await query;
  return rows.filter(isGroundedCurrent);
}

async function validateProfile(database: Database, spec: MemoryIndexSpec) {
  const [profile] = await database.db.select().from(modelProfiles).where(eq(modelProfiles.id, spec.modelProfileId)).limit(1);
  if (!profile || profile.purpose !== 'embedding' || !profile.enabled || profile.provider !== spec.provider || profile.model !== spec.model || profile.dimensions !== spec.dimensions) {
    throw new Error('memory index does not match an enabled embedding profile');
  }
  return profile;
}

/** Creates a distinct building collection. Dimension/model changes never reuse an active vector space. */
export async function beginMemoryIndex(database: Database, spec: MemoryIndexSpec) {
  if (!Number.isInteger(spec.dimensions) || spec.dimensions < 1 || spec.dimensions > 16000 || spec.preprocessingVersion !== 'v1' ||
      !/^companion_memory_[a-z0-9_]{1,50}$/.test(spec.collectionName) ||
      !/^[a-zA-Z0-9._-]{1,64}$/.test(spec.preprocessingVersion)) throw new Error('invalid memory index spec');
  await validateProfile(database, spec);
  return database.db.insert(memoryIndexes).values({ ...spec, status: 'building' }).returning().then(([row]) => {
    if (!row) throw new Error('memory index was not created');
    return row;
  });
}

/**
 * Backfills only current, validated, source-grounded ledger facts into the configured
 * Mem0 collection. The engine must use this index's collection and embedding profile.
 * The stable operation key in public Mem0 metadata lets a restart recover an SDK add
 * that completed immediately before its ledger mapping was committed.
 */
export async function rebuildMemoryIndex(database: Database, indexId: string, engineFactory: MemoryIndexEngineFactory, deletionJournalPath = process.env.MEMORY_DELETION_JOURNAL_PATH): Promise<{ indexed: number; skipped: number }> {
  if (!deletionJournalPath) throw new Error('memory deletion journal path is required');
  await assertDeletionJournalReplayed(database, deletionJournalPath);
  const [index] = await database.db.select().from(memoryIndexes).where(eq(memoryIndexes.id, indexId)).limit(1);
  if (!index || index.status !== 'building') throw new Error('memory index is not building');
  const profile = await validateProfile(database, index);
  const handle = await engineFactory(index, profile);
  const expected: MemoryIndexEngineConfiguration = {
    indexId: index.id, collectionName: index.collectionName, provider: index.provider, model: index.model,
    dimensions: index.dimensions, preprocessingVersion: index.preprocessingVersion,
  };
  if (JSON.stringify(handle.configuration) !== JSON.stringify(expected)) throw new Error('Mem0 engine configuration does not match memory index');
  const engine = handle.engine;
  const candidates = await database.db.transaction((tx) => eligibleRevisions(tx, index.characterId));
  let indexed = 0;
  let skipped = 0;
  for (const item of candidates) {
    const operationKey = `memory-index:${index.id}:${item.revision.id}`;
    const [existingMapping] = await database.db.select({ engineMemoryId: memoryMappings.engineMemoryId })
      .from(memoryMappings).where(and(eq(memoryMappings.indexId, index.id), eq(memoryMappings.revisionId, item.revision.id))).limit(1);
    if (existingMapping) { skipped++; continue; }

    const filters = {
      agent_id: index.characterId,
      ...(item.source.personId ? { user_id: item.source.personId } : {}),
      run_id: item.source.id,
      revision_id: item.revision.id,
    };
    const search = await engine.search(item.revision.factText!, { filters, topK: 100 });
    const recovered = search.results.filter((result) => result.metadata?.operation_key === operationKey);
    const added = recovered.length ? recovered : (await engine.add(item.revision.factText!, {
      userId: item.source.personId ?? item.source.id,
      agentId: index.characterId,
      runId: item.source.id,
      infer: false,
      metadata: {
        source_id: item.source.id,
        revision_id: item.revision.id,
        operation_key: operationKey,
        preprocessing_version: index.preprocessingVersion,
        index_id: index.id,
      },
    })).results;
    if (!added.length || added.some((result) => !result.id)) throw new Error('Mem0 did not return an indexed memory ID');

    for (const result of added) {
      const persisted = await database.db.transaction(async (tx) => {
        const stillEligible = await eligibleRevisions(tx, index.characterId, true);
        const current = stillEligible.find((candidate) => candidate.revision.id === item.revision.id && candidate.revision.version === item.revision.version);
        if (!current) return false;
        await tx.insert(memoryMappings).values({ operationKey, engineMemoryId: result.id, revisionId: item.revision.id, indexId: index.id })
          .onConflictDoNothing({ target: [memoryMappings.operationKey, memoryMappings.engineMemoryId] });
        const [mapping] = await tx.select({ id: memoryMappings.id }).from(memoryMappings).where(and(
          eq(memoryMappings.indexId, index.id), eq(memoryMappings.revisionId, item.revision.id), eq(memoryMappings.engineMemoryId, result.id),
        )).limit(1);
        return Boolean(mapping);
      });
      if (!persisted) {
        if (await engine.get(result.id)) await engine.delete(result.id);
        await engine.deleteHistory(result.id);
        skipped++;
      } else indexed++;
    }
  }
  await assertDeletionJournalReplayed(database, deletionJournalPath);
  return { indexed, skipped };
}

/** Activation is serialized per character and rechecks the complete ledger under row locks. */
export async function activateMemoryIndex(database: Database, indexId: string, deletionJournalPath = process.env.MEMORY_DELETION_JOURNAL_PATH) {
  if (!deletionJournalPath) throw new Error('memory deletion journal path is required');
  await assertDeletionJournalReplayed(database, deletionJournalPath);
  return database.db.transaction(async (tx) => {
    const [initial] = await tx.select().from(memoryIndexes).where(eq(memoryIndexes.id, indexId)).limit(1);
    if (!initial || initial.status !== 'building') throw new Error('memory index is not building');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`memory-index-activation:${initial.characterId}`}, 0))`);
    const [index] = await tx.select().from(memoryIndexes).where(eq(memoryIndexes.id, indexId)).for('update').limit(1);
    if (!index || index.status !== 'building') throw new Error('memory index is not building');
    const [profile] = await tx.select().from(modelProfiles).where(eq(modelProfiles.id, index.modelProfileId)).for('share').limit(1);
    if (!profile || profile.purpose !== 'embedding' || !profile.enabled || profile.provider !== index.provider || profile.model !== index.model || profile.dimensions !== index.dimensions || index.preprocessingVersion !== 'v1') {
      throw new Error('memory index does not match an enabled embedding profile');
    }
    const revisions = await eligibleRevisions(tx, index.characterId, true);
    const revisionIds = revisions.map(({ revision }) => revision.id);
    const mappings = revisionIds.length ? await tx.select({ revisionId: memoryMappings.revisionId }).from(memoryMappings)
      .where(and(eq(memoryMappings.indexId, index.id), inArray(memoryMappings.revisionId, revisionIds))) : [];
    if (new Set(mappings.map(({ revisionId }) => revisionId)).size !== revisionIds.length) throw new Error('memory index is incomplete');
    await tx.update(memoryIndexes).set({ status: 'retired' }).where(and(eq(memoryIndexes.characterId, index.characterId), eq(memoryIndexes.status, 'active')));
    const [active] = await tx.update(memoryIndexes).set({ status: 'active', activatedAt: new Date() })
      .where(and(eq(memoryIndexes.id, index.id), eq(memoryIndexes.status, 'building'))).returning();
    if (!active) throw new Error('memory index activation lost race');
    return active;
  });
}
