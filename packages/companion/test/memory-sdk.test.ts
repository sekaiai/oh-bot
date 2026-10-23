import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mem0ConfigSchema, createMem0Memory, assertExistingHistoryFile } from '../src/memory/mem0-adapter.js';
import { requireCompatDatabaseUrl } from './helpers.js';

test('Mem0 adapter requires explicit isolated chat, embedding, PG, and SQLite settings', async () => {
  const input = {
    chat: { baseUrl: 'http://127.0.0.1:4111/v1', apiKey: 'fixture-chat', model: 'fixture-chat' },
    embedding: { baseUrl: 'http://127.0.0.1:4111/v1', apiKey: 'fixture-embedding', model: 'fixture-embed', dimensions: 8 },
    databaseUrl: requireCompatDatabaseUrl(), historyPath: '/tmp/companion-memory-sdk-test/history.db', collectionName: 'companion_memory_test',
  };
  assert.throws(() => mem0ConfigSchema.parse({ ...input, embedding: { ...input.embedding, dimensions: 0 } }));
  const config = mem0ConfigSchema.parse(input);
  assert.equal(config.embedding.dimensions, 8);
  await assert.rejects(createMem0Memory({ ...config, historyPath: '/tmp/companion-memory-history-that-does-not-exist.db' }), /missing or corrupt/);
  assert.throws(() => mem0ConfigSchema.parse({ ...input, chat: { ...input.chat, baseUrl: 'https://user:secret@example.test/v1' } }));
});

test('public exact history erasure survives SDK restart and retains other memory history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mem0-history-'));
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body || '{}').input;
    const values = Array.isArray(input) ? input : [input];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: values.map((_, index) => ({ object: 'embedding', index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const id = randomUUID().replaceAll('-', '');
  const config = mem0ConfigSchema.parse({
    chat: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-chat', model: 'fixture-chat' },
    embedding: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-embedding', model: 'fixture-embed', dimensions: 8 },
    databaseUrl: requireCompatDatabaseUrl(), historyPath: path.join(directory, 'history.db'), collectionName: `companion_memory_${id}`, initializeHistory: true,
  });
  const corruptPath = path.join(directory, 'corrupt.db');
  await writeFile(corruptPath, 'not a sqlite database');
  await assert.rejects(assertExistingHistoryFile(corruptPath), /missing or corrupt/);
  await assert.rejects(createMem0Memory({ ...config, historyPath: corruptPath, initializeHistory: false }), /missing or corrupt/);
  const opened: Array<{ close(): Promise<void> }> = [];
  try {
    const memory = await createMem0Memory(config);
    opened.push(memory);
    const first = await memory.add('我喜欢喝茶。', { userId: `test-${id}`, infer: false });
    const second = await memory.add('我喜欢看书。', { userId: `test-${id}`, infer: false });
    const firstId = first.results[0]?.id, secondId = second.results[0]?.id;
    assert.ok(firstId && secondId);
    await memory.delete(firstId);
    assert.ok((await memory.history(firstId)).length > 0);
    assert.ok((await memory.deleteHistory(firstId)) > 0);
    assert.deepEqual(await memory.history(firstId), []);
    assert.ok((await memory.history(secondId)).length > 0);
    const restarted = await createMem0Memory({ ...config, initializeHistory: false });
    opened.push(restarted);
    assert.deepEqual(await restarted.history(firstId), []);
    assert.ok((await restarted.history(secondId)).length > 0);
  } finally {
    await Promise.all(opened.map((memory) => memory.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
