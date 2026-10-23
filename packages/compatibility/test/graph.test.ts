import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { runGraphProbe, verifyGraphProbe } from '../src/graph-probe.js';

const databaseUrl = process.env.COMPAT_DATABASE_URL;
const historyPath = process.env.COMPAT_HISTORY_PATH;
test('PostgresSaver resumes the paused thread in a fresh graph and verifies persisted state read-only', async () => {
  assert.ok(databaseUrl, 'COMPAT_DATABASE_URL is required for graph integration test');
  assert.ok(historyPath, 'COMPAT_HISTORY_PATH is required for graph integration test');
  const config = loadConfig({
    ...process.env,
    COMPAT_MODE: 'protocol-fixture',
    COMPAT_DATABASE_URL: databaseUrl!,
    COMPAT_HISTORY_PATH: historyPath!,
    COMPAT_CHAT_BASE_URL: process.env.COMPAT_CHAT_BASE_URL ?? 'http://127.0.0.1:1/v1',
    COMPAT_CHAT_API_KEY: process.env.COMPAT_CHAT_API_KEY ?? 'fixture-only',
    COMPAT_CHAT_MODEL: process.env.COMPAT_CHAT_MODEL ?? 'fixture-chat',
    COMPAT_EMBEDDING_BASE_URL: process.env.COMPAT_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:1/v1',
    COMPAT_EMBEDDING_API_KEY: process.env.COMPAT_EMBEDDING_API_KEY ?? 'fixture-only',
    COMPAT_EMBEDDING_MODEL: process.env.COMPAT_EMBEDDING_MODEL ?? 'fixture-embedding',
    COMPAT_EMBEDDING_DIMENSIONS: process.env.COMPAT_EMBEDDING_DIMENSIONS ?? '8',
  });
  const report = await runGraphProbe(config);
  assert.equal(report.status, 'passed');
  assert.ok(report.checks.some((check) => check.name === 'fresh-saver-resumes-once' && check.status === 'passed'));
  assert.ok(report.manifest.threadId);
  assert.ok(report.checks.every((check) => !/postgres(?:ql)?:\/\/|api.?key|prompt/i.test(check.detail)));

  const verified = await verifyGraphProbe(config, report.manifest);
  assert.equal(verified.status, 'passed');
  assert.ok(verified.checks.some((check) => check.name === 'read-only-persisted-final-state' && check.status === 'passed'));
  assert.ok(verified.checks.some((check) => check.name === 'read-only-connection' && check.status === 'passed'));

  const missingManifest = { ...report.manifest, threadId: `missing-${randomUUID()}` };
  const missing = await verifyGraphProbe(config, missingManifest);
  assert.equal(missing.status, 'failed', 'a missing checkpoint must not verify as recovered');
  const observer = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    const rows = await observer.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${report.manifest.counterTable} WHERE thread_id = $1`, [missingManifest.threadId]);
    assert.equal(rows.rows[0]?.count, '0', 'verification must not create the counter row');
  } finally { await observer.end(); }
  const manifestPath = path.join(path.dirname(config.historyPath), 'graph-probe-manifest.json');
  assert.ok(existsSync(manifestPath));
  const saved = JSON.parse(readFileSync(manifestPath, 'utf8')) as { threadId?: string };
  assert.equal(saved.threadId, report.manifest.threadId);
});
