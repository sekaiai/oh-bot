import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { startProtocolFixture } from './protocol-fixture.js';
import { assertIsolatedDatabase } from '../src/isolation.js';

test('direct worker entry rejects non-compat database before SDK initialization or network access', async () => {
  const config = {
    mode: 'protocol-fixture', databaseUrl: 'postgresql://compat:secret@127.0.0.1:1/production_db', historyPath: path.resolve('.state/guard.sqlite'),
    chat: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'secret', model: 'fixture-chat' },
    embedding: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'secret', model: 'fixture-embedding', dimensions: 8 },
  };
  assert.throws(() => assertIsolatedDatabase(config.databaseUrl), /must end with _compat/);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/memory-worker.ts', import.meta.url))], {
    env: { ...process.env, COMPAT_WORKER_CONFIG: JSON.stringify(config), COMPAT_WORKER_ACTION: JSON.stringify({ op: 'add', text: 'synthetic', user_id: 'test', infer: false }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('worker guard test timed out')); }, 3000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code ?? 1); });
  });
  assert.notEqual(code, 0);
  assert.match(output, /COMPAT_DATABASE_URL database name must end with _compat/);
  assert.ok(!output.includes('secret'));
});

test('worker errors do not disclose endpoint, API key or provider error text', async () => {
  const databaseUrl = process.env.COMPAT_DATABASE_URL;
  if (!databaseUrl) throw new Error('COMPAT_DATABASE_URL must be explicitly set for integration tests');
  const privateSentinel = 'synthetic-provider-secret-do-not-print';
  const fixture = await startProtocolFixture({ embeddingError: privateSentinel });
  try {
    const config = loadConfig({
      COMPAT_MODE: 'protocol-fixture', COMPAT_DATABASE_URL: databaseUrl,
      COMPAT_HISTORY_PATH: path.resolve('.state/worker-error.sqlite'),
      COMPAT_CHAT_BASE_URL: fixture.baseUrl, COMPAT_CHAT_API_KEY: privateSentinel, COMPAT_CHAT_MODEL: 'fixture-chat',
      COMPAT_EMBEDDING_BASE_URL: fixture.baseUrl, COMPAT_EMBEDDING_API_KEY: privateSentinel, COMPAT_EMBEDDING_MODEL: 'fixture-embedding', COMPAT_EMBEDDING_DIMENSIONS: '8',
    });
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/memory-worker.ts', import.meta.url))], {
      env: { ...process.env, MEM0_TELEMETRY: 'false', COMPAT_WORKER_CONFIG: JSON.stringify({ ...config, collectionName: `compat_error_${Date.now()}` }), COMPAT_WORKER_ACTION: JSON.stringify({ op: 'add', text: 'synthetic safe fact', user_id: 'sanitization-user', infer: false, metadata: { scope_id: 'private' } }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('worker error test timed out')); }, 15000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); resolve(code ?? 1); });
    });
    assert.notEqual(code, 0);
    assert.match(output, /worker-error:.*Error/);
    assert.ok(!output.includes(privateSentinel), 'provider and credential sentinel must not be printed');
    assert.ok(!output.includes(fixture.baseUrl), 'endpoint must not be printed');
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve()));
  }
});
