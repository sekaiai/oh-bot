import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { initializeWorkerQueueSchema } from '../src/worker/worker-service.js';
import { requireWorkerDatabaseUrl } from './helpers.js';
import { randomUUID } from 'node:crypto';

test('built ESM worker starts against PostgreSQL and closes pg-boss and its pool on SIGTERM', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const queuePrefix = `f3bmain_${randomUUID().replaceAll('-', '')}`;
  const database = createDatabase(databaseUrl);
  try { await migrateDatabase(database); } finally { await database.close(); }
  await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
  const entry = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, COMPANION_DATABASE_URL: databaseUrl, COMPANION_WORKER_QUEUE_PREFIX: queuePrefix },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker startup timed out: ${stderr}`)), 10_000);
      const onExit = () => { clearTimeout(timer); reject(new Error(`worker exited before ready: ${stderr}`)); };
      child.once('exit', onExit);
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (value: string) => {
        stdout += value;
        if (!stdout.includes('COMPANION_WORKER_READY')) return;
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve();
      });
    });
    assert.equal(child.exitCode, null, stderr);
    child.kill('SIGTERM');
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker shutdown timed out')), 10_000);
      child.once('exit', (exitCode, exitSignal) => { clearTimeout(timer); resolve([exitCode, exitSignal]); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.equal(stderr.includes(databaseUrl), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('built ESM worker rejects an invalid queue prefix before connecting', async () => {
  const entry = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, COMPANION_WORKER_QUEUE_PREFIX: 'invalid.prefix' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('invalid queue prefix startup timed out')); }, 10_000);
    child.once('exit', (exitCode, exitSignal) => { clearTimeout(timer); resolve([exitCode, exitSignal]); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.equal(stderr, 'COMPANION_WORKER_QUEUE_PREFIX_INVALID\n');
});
