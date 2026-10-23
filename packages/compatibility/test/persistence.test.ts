import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { runMemoryProbe } from '../src/memory-probe.js';
import { runCompatibility } from '../src/run.js';
import { assertIsolatedDatabase } from '../src/isolation.js';

test('Mem0 persists inferred memories, scopes, corrections, deletions and history in real PG/SQLite', async () => {
  const databaseUrl = process.env.COMPAT_DATABASE_URL;
  if (!databaseUrl) throw new Error('COMPAT_DATABASE_URL must be explicitly set for integration tests');
  assertIsolatedDatabase(databaseUrl);
  const historyPath = process.env.COMPAT_HISTORY_PATH ?? path.resolve('.state/memory-history.sqlite');
  const config = loadConfig({
    COMPAT_MODE: 'protocol-fixture', COMPAT_DATABASE_URL: databaseUrl, COMPAT_HISTORY_PATH: historyPath,
    COMPAT_CHAT_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_CHAT_API_KEY: 'fixture-key', COMPAT_CHAT_MODEL: 'fixture-chat',
    COMPAT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_EMBEDDING_API_KEY: 'fixture-key', COMPAT_EMBEDDING_MODEL: 'fixture-embedding', COMPAT_EMBEDDING_DIMENSIONS: '8',
  });
  const report = await runCompatibility(config);
  assert.equal(report.status, 'passed', JSON.stringify(report.checks));
  assert.equal(report.checks.length, 9);
  assert.ok(report.checks.every(check => check.status === 'passed'), JSON.stringify(report.checks));
  assert.ok(report.checks.find(check => check.name === 'fixture-http-used')?.status === 'passed', 'infer=true and embeddings must use HTTP fixture');
  assert.ok(report.checks.find(check => check.name === 'fresh-saver-resumes-once')?.status === 'passed');
  const manifest = JSON.parse(readFileSync(report.manifestPath, 'utf8'));
  assert.equal(manifest.type, 'oh-bot-compatibility-manifest');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/run.ts'), '--verify', report.manifestPath], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env, COMPAT_MODE: 'protocol-fixture', COMPAT_DATABASE_URL: databaseUrl, COMPAT_HISTORY_PATH: historyPath,
      COMPAT_CHAT_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_CHAT_API_KEY: 'fixture-key', COMPAT_CHAT_MODEL: 'fixture-chat',
      COMPAT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_EMBEDDING_API_KEY: 'fixture-key', COMPAT_EMBEDDING_MODEL: 'fixture-embedding', COMPAT_EMBEDDING_DIMENSIONS: '8',
    },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'passed');
});

test('inferred fact check fails when fixture returns unrelated content', async () => {
  const databaseUrl = process.env.COMPAT_DATABASE_URL;
  if (!databaseUrl) throw new Error('COMPAT_DATABASE_URL must be explicitly set for integration tests');
  assertIsolatedDatabase(databaseUrl);
  const config = loadConfig({
    COMPAT_MODE: 'protocol-fixture', COMPAT_DATABASE_URL: databaseUrl, COMPAT_HISTORY_PATH: path.resolve('.state/wrong-fact.sqlite'),
    COMPAT_CHAT_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_CHAT_API_KEY: 'fixture-key', COMPAT_CHAT_MODEL: 'fixture-chat',
    COMPAT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1', COMPAT_EMBEDDING_API_KEY: 'fixture-key', COMPAT_EMBEDDING_MODEL: 'fixture-embedding', COMPAT_EMBEDDING_DIMENSIONS: '8',
  });
  const report = await runMemoryProbe(config, { fixtureChatFact: '用户喜欢吃火锅。' });
  const contentCheck = report.checks.find(check => check.name === 'inferred-chinese-fact-content');
  assert.equal(contentCheck?.status, 'failed', JSON.stringify(report.checks));
  assert.equal(report.status, 'failed');
});
