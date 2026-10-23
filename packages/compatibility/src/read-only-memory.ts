import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { CompatibilityConfig } from './config.js';
import { assertIsolatedDatabase } from './isolation.js';

const MEM0_SCHEMA_VERSION = '3.3.1';
const COLLECTION_PREFIX = 'compat_memories_';
const COLLECTION_PATTERN = /^compat_memories_[a-z0-9_]{1,100}$/;
interface ReadOnlySqlite {
  prepare(sql: string): { all(...values: unknown[]): unknown[] };
  close(): void;
}
interface ReadOnlySqliteConstructor {
  new(file: string, options: { readonly: true; fileMustExist: true }): ReadOnlySqlite;
}
const Database = createRequire(import.meta.url)('better-sqlite3') as ReadOnlySqliteConstructor;

export const readOnlyMemoryAdapter = {
  id: 'mem0ai-3.3.1-pgvector-sqlite-history-readonly',
  mem0Version: MEM0_SCHEMA_VERSION,
} as const;

export interface MemoryReadManifest {
  id: string;
  userId: string;
  scopeId: string;
  fact: string;
  collection: string;
  historyPath: string;
}

export interface PersistedMemoryRead {
  memory: { id: string; memory: string; metadata: Record<string, unknown> } | null;
  history: Array<{ action: string; new_value: string | null; previous_value: string | null }>;
}

function quoteCollectionIdentifier(collection: string): string {
  if (!collection.startsWith(COLLECTION_PREFIX) || !COLLECTION_PATTERN.test(collection)) {
    throw new Error('Invalid Mem0 compatibility collection identifier');
  }
  return `"${collection.replaceAll('"', '""')}"`;
}

function assertSupportedMem0Version(): void {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('mem0ai/oss');
  const packagePath = path.resolve(path.dirname(entry), '..', '..', 'package.json');
  let version: unknown;
  try { version = (JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }).version; }
  catch { throw new Error('Unable to validate the read-only Mem0 adapter version'); }
  if (version !== MEM0_SCHEMA_VERSION) throw new Error(`Read-only Mem0 adapter supports ${MEM0_SCHEMA_VERSION} only`);
}

function createReadOnlyPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    idleTimeoutMillis: 5_000,
    max: 1,
    options: '-c default_transaction_read_only=on',
  });
}

export async function readPersistedMemory(config: CompatibilityConfig, manifest: MemoryReadManifest): Promise<PersistedMemoryRead> {
  assertIsolatedDatabase(config.databaseUrl);
  assertSupportedMem0Version();
  if (path.resolve(config.historyPath) !== path.resolve(manifest.historyPath)) {
    throw new Error('Manifest history path does not match configured history path');
  }
  const table = quoteCollectionIdentifier(manifest.collection);
  const pool = createReadOnlyPool(config.databaseUrl);
  let sqlite: ReadOnlySqlite | undefined;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    const readOnly = await client.query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only');
    if (readOnly.rows[0]?.default_transaction_read_only !== 'on') throw new Error('Memory verification database connection is not read-only');

    const columns = await client.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', manifest.collection],
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    if (!['id', 'vector', 'payload'].every((column) => columnNames.has(column))) {
      throw new Error(`Mem0 ${MEM0_SCHEMA_VERSION} collection does not exist or has an unsupported schema`);
    }
    const result = await client.query<{ id: string; payload: Record<string, unknown> | string }>(
      `SELECT id::text, payload FROM ${table} WHERE id = $1`, [manifest.id],
    );
    await client.query('COMMIT');

    sqlite = new Database(config.historyPath, { readonly: true, fileMustExist: true });
    const historyColumns = new Set((sqlite.prepare('PRAGMA table_info(memory_history)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!['memory_id', 'previous_value', 'new_value', 'action'].every((column) => historyColumns.has(column))) {
      throw new Error(`Mem0 ${MEM0_SCHEMA_VERSION} SQLite history schema is unsupported`);
    }
    const history = sqlite.prepare(
      'SELECT action, new_value, previous_value FROM memory_history WHERE memory_id = ? ORDER BY id DESC',
    ).all(manifest.id) as PersistedMemoryRead['history'];
    const row = result.rows[0];
    if (!row) return { memory: null, history };
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as Record<string, unknown> : row.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.data !== 'string') {
      throw new Error(`Mem0 ${MEM0_SCHEMA_VERSION} collection row has an unsupported payload`);
    }
    return {
      memory: { id: row.id, memory: payload.data, metadata: payload },
      history,
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    sqlite?.close();
    client?.release();
    await pool.end();
  }
}
