import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertIsolatedDatabase, IsolatedDatabaseError } from './isolation.js';

const config = JSON.parse(process.env.COMPAT_WORKER_CONFIG ?? '{}');
const action = JSON.parse(process.env.COMPAT_WORKER_ACTION ?? '{}');
process.env.MEM0_TELEMETRY = 'false';

try {
  assertIsolatedDatabase(config.databaseUrl);
  process.env.MEM0_DIR = path.dirname(config.historyPath);
  mkdirSync(process.env.MEM0_DIR, { recursive: true });
  const { Memory } = await import('mem0ai/oss');
  const memory = new Memory({
    embedder: { provider: 'openai', config: { apiKey: config.embedding.apiKey, model: config.embedding.model, baseURL: config.embedding.baseUrl, embeddingDims: config.embedding.dimensions } },
    llm: { provider: 'openai', config: { apiKey: config.chat.apiKey, model: config.chat.model, baseURL: config.chat.baseUrl, timeout: 10000, maxTokens: 300 } },
    vectorStore: { provider: 'pgvector', config: { connectionString: config.databaseUrl, collectionName: config.collectionName ?? 'compat_memories', embeddingModelDims: config.embedding.dimensions } },
    historyStore: { provider: 'sqlite', config: { historyDbPath: config.historyPath } },
  });
  let result: any;
  process.stderr.write(`operation:${action.op}:start\n`);
  switch (action.op) {
    case 'add': {
      const added = await memory.add(action.text, { userId: action.user_id, filters: { user_id: action.user_id, ...(action.metadata?.scope_id ? { scope_id: action.metadata.scope_id } : {}) }, metadata: action.metadata, infer: action.infer });
      result = { id: added.results?.[0]?.id };
      if (!result.id) throw new Error(`Mem0 add returned no memory id (count=${added.results?.length ?? 'none'})`);
      break;
    }
    case 'search': result = await memory.search(action.query, { filters: action.filters, topK: 20 }); break;
    case 'update': result = await memory.update(action.id, { text: action.text }); break;
    case 'delete': result = await memory.delete(action.id); break;
    case 'get-history-search': result = { memory: await memory.get(action.id), history: await memory.history(action.id), search: await memory.search(action.query, { filters: action.filters, topK: 20 }) }; break;
    default: throw new Error('Unknown worker operation');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
} catch (error) {
  const detail = error instanceof IsolatedDatabaseError ? error.message : `worker-error:${error instanceof Error ? error.constructor.name : 'UnknownError'}`;
  process.stderr.write(`${detail}\n`, () => process.exit(1));
}
