import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { assertIsolatedDatabase } from '../src/isolation.js';
import { verifyMemoryProbe } from '../src/memory-probe.js';

test('memory verify rejects a missing collection without creating it', async () => {
  const databaseUrl = process.env.COMPAT_DATABASE_URL;
  if (!databaseUrl) throw new Error('COMPAT_DATABASE_URL must be explicitly set for integration tests');
  assertIsolatedDatabase(databaseUrl);
  const historyPath = process.env.COMPAT_HISTORY_PATH ?? path.resolve('.state/memory-history.sqlite');
  const config = loadConfig({
    COMPAT_MODE: 'protocol-fixture', COMPAT_DATABASE_URL: databaseUrl, COMPAT_HISTORY_PATH: historyPath,
    COMPAT_CHAT_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_CHAT_API_KEY: 'fixture-only', COMPAT_CHAT_MODEL: 'fixture-chat',
    COMPAT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_EMBEDDING_API_KEY: 'fixture-only', COMPAT_EMBEDDING_MODEL: 'fixture-embedding', COMPAT_EMBEDDING_DIMENSIONS: '8',
  });
  const collection = `compat_memories_missing_${randomUUID().replaceAll('-', '')}`;
  const observer = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    const before = await observer.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [`public.${collection}`]);
    assert.equal(before.rows[0]?.relation, null);
    await assert.rejects(verifyMemoryProbe(config, {
      id: randomUUID(), userId: 'owner-a', scopeId: 'sentinel-owner-a', fact: 'synthetic fact', collection, historyPath,
    }), /collection does not exist/i);
    const after = await observer.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [`public.${collection}`]);
    assert.equal(after.rows[0]?.relation, null, 'read-only verification must not initialize a Mem0 collection');
  } finally {
    await observer.query(`DROP TABLE IF EXISTS "${collection}"`);
    await observer.end();
  }
});
