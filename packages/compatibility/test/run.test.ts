import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const entry = path.resolve('src/run.ts');
const baseEnv = {
  PATH: process.env.PATH,
  COMPAT_MODE: 'protocol-fixture',
  COMPAT_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55432/oh_bot_compat',
  COMPAT_HISTORY_PATH: path.join(os.tmpdir(), 'oh-bot-cli-test', 'memory.sqlite'),
  COMPAT_CHAT_BASE_URL: 'http://127.0.0.1:1/v1',
  COMPAT_CHAT_API_KEY: 'synthetic-secret',
  COMPAT_CHAT_MODEL: 'synthetic-chat',
  COMPAT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1',
  COMPAT_EMBEDDING_API_KEY: 'synthetic-secret',
  COMPAT_EMBEDDING_MODEL: 'synthetic-embedding',
  COMPAT_EMBEDDING_DIMENSIONS: '8',
};

function cli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { cwd: path.dirname(entry), env, encoding: 'utf8', timeout: 15_000 });
}

test('CLI fails closed on missing live configuration and names only the missing field', () => {
  const result = cli([], { PATH: process.env.PATH, COMPAT_MODE: 'live-api' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /COMPAT_DATABASE_URL/);
  assert.doesNotMatch(result.stderr, /synthetic-secret|postgres(?:ql)?:\/\//i);
});

test('CLI rejects an invalid --verify manifest without seeding or exposing configuration', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oh-bot-invalid-manifest-'));
  const file = path.join(directory, 'bad.json');
  writeFileSync(file, '{"private":"synthetic-secret"}');
  try {
    const result = cli(['--verify', file], { ...process.env, ...baseEnv });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid or unreadable compatibility manifest/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-secret|postgres(?:ql)?:\/\//i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI rejects unsupported invocation with nonzero exit', () => {
  const result = cli(['--unknown'], { ...process.env, ...baseEnv });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-secret|postgres(?:ql)?:\/\//i);
});
