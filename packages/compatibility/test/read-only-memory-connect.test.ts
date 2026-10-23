import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { readPersistedMemory } from '../src/read-only-memory.js';

test('read-only memory verification preserves connection failure and releases an unconnected pool', { timeout: 5000 }, async () => {
  const config = loadConfig({
    COMPAT_MODE: 'protocol-fixture',
    COMPAT_DATABASE_URL: 'postgresql://compat:compat-test-only@127.0.0.1:1/oh_bot_compat',
    COMPAT_HISTORY_PATH: path.resolve('.state/memory-history.sqlite'),
    COMPAT_CHAT_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_CHAT_API_KEY: 'fixture-only', COMPAT_CHAT_MODEL: 'fixture-chat',
    COMPAT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_EMBEDDING_API_KEY: 'fixture-only', COMPAT_EMBEDDING_MODEL: 'fixture-embedding', COMPAT_EMBEDDING_DIMENSIONS: '8',
  });
  let caught: unknown;
  await assert.rejects(readPersistedMemory(config, {
    id: '00000000-0000-0000-0000-000000000001', userId: 'owner-a', scopeId: 'scope-a',
    fact: 'synthetic fact', collection: 'compat_memories_connection_failure', historyPath: config.historyPath,
  }), (error: unknown) => {
    caught = error;
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, 'TypeError');
    assert.match(error.message, /ECONNREFUSED|connect|connection/i);
    assert.doesNotMatch(String(error), /Cannot read properties of undefined/);
    return true;
  });
  assert.ok(caught, 'the original database connection error must reach the caller');
});
