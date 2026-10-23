import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import SqliteDatabase from 'better-sqlite3';
import type { Memory } from 'mem0ai/oss';

const endpoint = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
});
export const mem0ConfigSchema = z.object({
  chat: z.object({ baseUrl: endpoint, apiKey: z.string().min(1), model: z.string().min(1) }).strict(),
  embedding: z.object({ baseUrl: endpoint, apiKey: z.string().min(1), model: z.string().min(1), dimensions: z.number().int().min(1).max(16000) }).strict(),
  databaseUrl: z.string().url().startsWith('postgresql://'),
  historyPath: z.string().min(1),
  initializeHistory: z.boolean().default(false),
  collectionName: z.string().regex(/^companion_memory_[a-z0-9_]{1,50}$/),
}).strict();
export type Mem0Config = z.infer<typeof mem0ConfigSchema>;

/** Creates the pinned Mem0 OSS implementation with explicit external model endpoints and durable stores. */
export async function createMem0Memory(rawConfig: Mem0Config): Promise<Memory & { close(): Promise<void> }> {
  const parsed = mem0ConfigSchema.safeParse(rawConfig);
  if (!parsed.success) throw new Error('invalid Mem0 configuration');
  const config = parsed.data;
  if (!config.initializeHistory) await assertExistingHistoryFile(config.historyPath);
  else await mkdir(path.dirname(path.resolve(config.historyPath)), { recursive: true });
  process.env.MEM0_TELEMETRY ??= 'false';
  const { Memory: Mem0Memory } = await import('mem0ai/oss');
  return new Mem0Memory({
    embedder: { provider: 'openai', config: { apiKey: config.embedding.apiKey, model: config.embedding.model, baseURL: config.embedding.baseUrl, embeddingDims: config.embedding.dimensions } },
    llm: { provider: 'openai', config: { apiKey: config.chat.apiKey, model: config.chat.model, baseURL: config.chat.baseUrl } },
    vectorStore: { provider: 'pgvector', config: { connectionString: config.databaseUrl, collectionName: config.collectionName, embeddingModelDims: config.embedding.dimensions } },
    historyStore: { provider: 'sqlite', config: { historyDbPath: path.resolve(config.historyPath) } },
  }) as Memory & { close(): Promise<void> };
}

/** Existing stores must be present, non-empty SQLite files; Mem0 otherwise silently initializes a blank history DB. */
export async function assertExistingHistoryFile(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < 100) throw new Error();
    const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true });
    try {
      const check = db.pragma('quick_check') as Array<{ quick_check?: string }>;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const columns = db.prepare('PRAGMA table_info(memory_history)').all() as Array<{ name: string }>;
      if (check.length !== 1 || check[0]?.quick_check !== 'ok' || !tables.some((table) => table.name === 'memory_history') ||
          !['memory_id', 'previous_value', 'new_value', 'action'].every((required) => columns.some((column) => column.name === required))) throw new Error();
    } finally { db.close(); }
  } catch { throw new Error('Mem0 history store is missing or corrupt'); }
}
