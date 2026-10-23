import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const validEnv = (): NodeJS.ProcessEnv => ({
  COMPAT_MODE: 'protocol-fixture',
  COMPAT_DATABASE_URL: 'postgresql://compat_user:db-secret@localhost:5432/compat',
  COMPAT_HISTORY_PATH: '/var/lib/oh-bot/compat/history.sqlite',
  COMPAT_CHAT_BASE_URL: 'https://chat.example.test/v1',
  COMPAT_CHAT_API_KEY: 'chat-secret',
  COMPAT_CHAT_MODEL: 'chat-model',
  COMPAT_EMBEDDING_BASE_URL: 'https://embed.example.test/v1',
  COMPAT_EMBEDDING_API_KEY: 'embedding-secret',
  COMPAT_EMBEDDING_MODEL: 'embedding-model',
  COMPAT_EMBEDDING_DIMENSIONS: '1536',
});

test('loads an explicit protocol-fixture configuration', () => {
  assert.deepEqual(loadConfig(validEnv()), {
    mode: 'protocol-fixture',
    databaseUrl: 'postgresql://compat_user:db-secret@localhost:5432/compat',
    historyPath: '/var/lib/oh-bot/compat/history.sqlite',
    chat: {
      baseUrl: 'https://chat.example.test/v1',
      apiKey: 'chat-secret',
      model: 'chat-model',
    },
    embedding: {
      baseUrl: 'https://embed.example.test/v1',
      apiKey: 'embedding-secret',
      model: 'embedding-model',
      dimensions: 1536,
    },
  });
});

test('loads an explicit live-api configuration', () => {
  const env = validEnv();
  env.COMPAT_MODE = 'live-api';
  assert.equal(loadConfig(env).mode, 'live-api');
});

test('reports each missing field by name without exposing any supplied values', () => {
  const required = [
    'COMPAT_MODE', 'COMPAT_DATABASE_URL', 'COMPAT_HISTORY_PATH',
    'COMPAT_CHAT_BASE_URL', 'COMPAT_CHAT_API_KEY', 'COMPAT_CHAT_MODEL',
    'COMPAT_EMBEDDING_BASE_URL', 'COMPAT_EMBEDDING_API_KEY',
    'COMPAT_EMBEDDING_MODEL', 'COMPAT_EMBEDDING_DIMENSIONS',
  ];
  for (const key of required) {
    const env = validEnv();
    delete env[key];
    assert.throws(() => loadConfig(env), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(key));
      for (const secret of ['db-secret', 'chat-secret', 'embedding-secret', 'compat_user']) {
        assert.ok(!error.message.includes(secret));
      }
      return true;
    }, `missing ${key}`);
  }
});

test('rejects unsupported mode and database protocols without echoing input', () => {
  const modeEnv = validEnv();
  modeEnv.COMPAT_MODE = 'debug-secret-mode';
  assert.throws(() => loadConfig(modeEnv), /COMPAT_MODE/);
  const dbEnv = validEnv();
  dbEnv.COMPAT_DATABASE_URL = 'mysql://db-secret.invalid/private';
  assert.throws(() => loadConfig(dbEnv), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /COMPAT_DATABASE_URL/);
    assert.ok(!error.message.includes('mysql://'));
    assert.ok(!error.message.includes('db-secret'));
    return true;
  });
});

test('requires a non-empty absolute history file path', () => {
  for (const path of ['', 'relative/history.sqlite', '/tmp']) {
    const env = validEnv();
    env.COMPAT_HISTORY_PATH = path;
    assert.throws(() => loadConfig(env), /COMPAT_HISTORY_PATH/);
  }
});

test('rejects normalized directory paths and paths containing NUL', () => {
  for (const historyPath of ['/nonexistent-review-path/.', '/nonexistent-review-path/..', '/tmp/history\0.sqlite']) {
    const env = validEnv();
    env.COMPAT_HISTORY_PATH = historyPath;
    assert.throws(() => loadConfig(env), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /COMPAT_HISTORY_PATH/);
      assert.ok(!error.message.includes(historyPath));
      return true;
    });
  }
});

test('reports non-ENOENT history stat errors using only the field name', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'compat-history-config-'));
  try {
    const notDirectory = path.join(root, 'file-parent');
    writeFileSync(notDirectory, '');
    const invalidFile = path.join(notDirectory, 'history.sqlite');
    const env = validEnv();
    env.COMPAT_HISTORY_PATH = invalidFile;
    assert.throws(() => loadConfig(env), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /COMPAT_HISTORY_PATH/);
      assert.ok(!error.message.includes(invalidFile));
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires HTTP(S) model endpoints and rejects URL credentials without echoing secrets', () => {
  for (const url of [
    'ftp://embed.example.test/model',
    'https://user:pass@embed.example.test/v1',
  ]) {
    const env = validEnv();
    env.COMPAT_EMBEDDING_BASE_URL = url;
    assert.throws(() => loadConfig(env), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /COMPAT_EMBEDDING_BASE_URL/);
      assert.ok(!error.message.includes('secret'));
      assert.ok(!error.message.includes('user:pass'));
      return true;
    });
  }
});

test('accepts only integer embedding dimensions from 1 through 16000', () => {
  for (const dimensions of ['0', '-1', '1.5', 'not-a-number', '16001']) {
    const env = validEnv();
    env.COMPAT_EMBEDDING_DIMENSIONS = dimensions;
    assert.throws(() => loadConfig(env), /COMPAT_EMBEDDING_DIMENSIONS/);
  }
  const env = validEnv();
  env.COMPAT_EMBEDDING_DIMENSIONS = '16000';
  assert.equal(loadConfig(env).embedding.dimensions, 16000);
});
