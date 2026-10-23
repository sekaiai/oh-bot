import { statSync } from 'node:fs';
import path from 'node:path';

export interface CompatibilityConfig {
  mode: 'protocol-fixture' | 'live-api';
  databaseUrl: string;
  historyPath: string;
  chat: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing or empty configuration: ${key}`);
  }
  return value.trim();
}

function modelEndpoint(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid HTTP(S) endpoint: ${key}`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`Invalid HTTP(S) endpoint without URL credentials: ${key}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): CompatibilityConfig {
  const modeValue = required(env, 'COMPAT_MODE');
  if (modeValue !== 'protocol-fixture' && modeValue !== 'live-api') {
    throw new Error('Invalid mode: COMPAT_MODE');
  }

  const databaseUrl = required(env, 'COMPAT_DATABASE_URL');
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid database URL: COMPAT_DATABASE_URL');
  }
  if (database.protocol !== 'postgres:' && database.protocol !== 'postgresql:') {
    throw new Error('Invalid database protocol: COMPAT_DATABASE_URL');
  }

  const historyPath = required(env, 'COMPAT_HISTORY_PATH');
  const lastPathSegment = historyPath.split(path.sep).at(-1);
  if (
    historyPath.includes('\0') ||
    !path.isAbsolute(historyPath) ||
    path.basename(historyPath) === '' ||
    historyPath.endsWith(path.sep) ||
    lastPathSegment === '.' ||
    lastPathSegment === '..'
  ) {
    throw new Error('Invalid absolute history file path: COMPAT_HISTORY_PATH');
  }

  const normalizedHistoryPath = path.resolve(historyPath);
  let existingHistoryStat;
  try {
    existingHistoryStat = statSync(normalizedHistoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to inspect history file path: COMPAT_HISTORY_PATH');
    }
    // A not-yet-created file is a valid persistent target.
  }
  if (existingHistoryStat?.isDirectory()) {
    throw new Error('Expected a history file path: COMPAT_HISTORY_PATH');
  }

  const dimensionsText = required(env, 'COMPAT_EMBEDDING_DIMENSIONS');
  const dimensions = Number(dimensionsText);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    throw new Error('Invalid embedding dimension (expected integer 1..16000): COMPAT_EMBEDDING_DIMENSIONS');
  }

  return {
    mode: modeValue,
    databaseUrl,
    historyPath: normalizedHistoryPath,
    chat: {
      baseUrl: modelEndpoint(env, 'COMPAT_CHAT_BASE_URL'),
      apiKey: required(env, 'COMPAT_CHAT_API_KEY'),
      model: required(env, 'COMPAT_CHAT_MODEL'),
    },
    embedding: {
      baseUrl: modelEndpoint(env, 'COMPAT_EMBEDDING_BASE_URL'),
      apiKey: required(env, 'COMPAT_EMBEDDING_API_KEY'),
      model: required(env, 'COMPAT_EMBEDDING_MODEL'),
      dimensions,
    },
  };
}
