import { eq } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { memoryIndexes, modelProfiles, turns } from '../database/schema/index.js';
import { IdentityService } from '../identity/identity-service.js';
import { MemoryGateway, type MemoryEngine } from '../memory/memory-gateway.js';
import { createMem0Memory, type Mem0Config } from '../memory/mem0-adapter.js';
import { MemoryLifecycleService } from '../memory/memory-lifecycle-service.js';
import { MemoryReadService } from '../memory/memory-read-service.js';
import { readDeletionJournal } from '../memory/memory-deletion-journal.js';
import { resolvePersistedTurnActor } from './trusted-turn-actor.js';

const names = [
  'COMPANION_MEMORY_CHAT_API_URL', 'COMPANION_MEMORY_CHAT_API_KEY', 'COMPANION_MEMORY_CHAT_MODEL',
  'COMPANION_MEMORY_EMBEDDING_API_URL', 'COMPANION_MEMORY_EMBEDDING_API_KEY', 'COMPANION_MEMORY_EMBEDDING_MODEL',
  'COMPANION_MEMORY_EMBEDDING_DIMENSIONS', 'COMPANION_MEMORY_HISTORY_PATH', 'COMPANION_MEMORY_COLLECTION',
] as const;

/** No config disables memory; partial config fails closed. Initialization is explicit setup-only. */
type RuntimeMemoryEngine = MemoryEngine & { close(): Promise<void> };
type RuntimeMemoryFactory = (config: Mem0Config) => Promise<RuntimeMemoryEngine>;

export async function createMemoryRuntime(database: Database, options: { initializeHistory?: boolean; databaseUrl?: string; historyPath?: string; deletionJournalPath?: string; env?: NodeJS.ProcessEnv; createEngine?: RuntimeMemoryFactory } = {}) {
  const env = options.env ?? process.env;
  const present = names.filter((name) => Boolean(env[name]?.trim()));
  if (!present.length) return undefined;
  const deletionJournalPath = options.deletionJournalPath ?? process.env.MEMORY_DELETION_JOURNAL_PATH;
  if (present.length !== names.length || !deletionJournalPath?.trim()) throw new Error('memory_config_incomplete');
  const config: Mem0Config = {
    chat: { baseUrl: env.COMPANION_MEMORY_CHAT_API_URL!, apiKey: env.COMPANION_MEMORY_CHAT_API_KEY!, model: env.COMPANION_MEMORY_CHAT_MODEL! },
    embedding: { baseUrl: env.COMPANION_MEMORY_EMBEDDING_API_URL!, apiKey: env.COMPANION_MEMORY_EMBEDDING_API_KEY!, model: env.COMPANION_MEMORY_EMBEDDING_MODEL!, dimensions: Number(env.COMPANION_MEMORY_EMBEDDING_DIMENSIONS) },
    databaseUrl: options.databaseUrl ?? env.COMPANION_DATABASE_URL!, historyPath: options.historyPath ?? env.COMPANION_MEMORY_HISTORY_PATH!,
    collectionName: env.COMPANION_MEMORY_COLLECTION!, initializeHistory: options.initializeHistory === true,
  };
  const createEngine = options.createEngine ?? (createMem0Memory as RuntimeMemoryFactory);
  const engines = new Map<string, RuntimeMemoryEngine>();
  const opening = new Map<string, Promise<RuntimeMemoryEngine>>();
  const engine = await createEngine(config);
  engines.set('primary', engine);
  const resolveIndexEngine = async (indexId: string): Promise<MemoryEngine> => {
    const cached = engines.get(indexId);
    if (cached) return cached;
    const pending = opening.get(indexId);
    if (pending) return pending;
    const task = (async () => {
    const [index] = await database.db.select().from(memoryIndexes).where(eq(memoryIndexes.id, indexId)).limit(1);
    if (!index) throw new Error('memory_index_unavailable');
    const [profile] = await database.db.select().from(modelProfiles).where(eq(modelProfiles.id, index.modelProfileId)).limit(1);
    const credential = profile ? env[profile.credentialRef]?.trim() : undefined;
    if (!profile || profile.purpose !== 'embedding' || !profile.enabled || profile.provider !== 'openai' ||
        profile.provider !== index.provider || profile.model !== index.model || profile.dimensions !== index.dimensions ||
        !credential || /^(?:<|\$\{|change-?me|replace[_-]?me|todo)/i.test(credential)) {
      throw new Error('memory_index_profile_unavailable');
    }
    const indexConfig: Mem0Config = {
      ...config,
      embedding: { baseUrl: profile.baseUrl, apiKey: credential, model: profile.model, dimensions: index.dimensions },
      collectionName: index.collectionName,
      // All vector collections share the existing history store. Index runtimes
      // must validate and open it; they must never initialize a blank database.
      initializeHistory: false,
    };
    const opened = await createEngine(indexConfig);
    engines.set(indexId, opened);
    return opened;
    })();
    opening.set(indexId, task);
    try { return await task; }
    finally { opening.delete(indexId); }
  };
  const close = async () => {
    const owned = [...new Set(engines.values())];
    engines.clear();
    const results = await Promise.allSettled(owned.map((item) => item.close()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'memory runtime close failed');
  };
  const identity = new IdentityService(database);
  const gateway = new MemoryGateway(database, new MemoryLifecycleService(database), new MemoryReadService(database), engine as MemoryEngine, async (source) => {
    const [turn] = await database.db.select({ id: turns.id }).from(turns).where(eq(turns.inboundMessageId, source.messageId)).limit(1);
    if (!turn) throw new Error('memory_source_turn_unavailable');
    return resolvePersistedTurnActor(database, identity, turn.id);
  }, deletionJournalPath, resolveIndexEngine);
  try {
    await gateway.assertDeletionJournalReplayed();
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return { gateway, close };
}

export async function setupMemoryHistory() {
  const env = process.env;
  const present = names.filter((name) => Boolean(env[name]?.trim()));
  if (!present.length) throw new Error('memory_config_missing');
  if (present.length !== names.length || !process.env.MEMORY_DELETION_JOURNAL_PATH?.trim()) throw new Error('memory_config_incomplete');
  const config: Mem0Config = {
    chat: { baseUrl: env.COMPANION_MEMORY_CHAT_API_URL!, apiKey: env.COMPANION_MEMORY_CHAT_API_KEY!, model: env.COMPANION_MEMORY_CHAT_MODEL!,
    },
    embedding: { baseUrl: env.COMPANION_MEMORY_EMBEDDING_API_URL!, apiKey: env.COMPANION_MEMORY_EMBEDDING_API_KEY!, model: env.COMPANION_MEMORY_EMBEDDING_MODEL!, dimensions: Number(env.COMPANION_MEMORY_EMBEDDING_DIMENSIONS) },
    databaseUrl: env.COMPANION_DATABASE_URL!, historyPath: env.COMPANION_MEMORY_HISTORY_PATH!,
    collectionName: env.COMPANION_MEMORY_COLLECTION!, initializeHistory: true,
  };
  const engine = await createMem0Memory(config);
  await engine.close();
}

/** Operations restore adapter: open the configured restored DB/Mem0 stores, replay and verify before returning a durable watermark. */
export async function replayRestoredDeletionJournal(input: { database: Database; databaseUrl: string; journalPath: string; throughSequence: number; historyPath: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const journal = await readDeletionJournal(input.journalPath);
  if (journal.latestSequence !== input.throughSequence) throw new Error('deletion journal watermark mismatch');
  const runtime = await createMemoryRuntime(input.database, { databaseUrl: input.databaseUrl, historyPath: input.historyPath, deletionJournalPath: input.journalPath, env: input.env });
  if (!runtime) throw new Error('memory_runtime_unavailable');
  try { await runtime.gateway.assertDeletionJournalReplayed(); }
  finally { await runtime.close(); }
  return journal.latestSequence;
}

export async function verifyRestoredDeletionJournal(input: { database: Database; databaseUrl: string; journalPath: string; historyPath: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const journal = await readDeletionJournal(input.journalPath);
  const replayed = await replayRestoredDeletionJournal({ ...input, throughSequence: journal.latestSequence });
  return replayed;
}
