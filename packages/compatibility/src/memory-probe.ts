import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompatibilityConfig } from './config.js';
import { assertIsolatedDatabase } from './isolation.js';
import { readPersistedMemory } from './read-only-memory.js';
import { startProtocolFixture } from '../test/protocol-fixture.js';

export interface MemoryProbeReport {
  status: 'passed' | 'failed' | 'blocked';
  checks: Array<{ name: string; status: 'passed' | 'failed'; detail: string }>;
  fixtureCalls: { chat: number; embeddings: number; dimensions?: number; encodingFormat?: string };
  state: { historyPath: string; manifestPath: string; collection: string };
}

async function worker(config: CompatibilityConfig, action: Record<string, unknown>): Promise<any> {
  assertIsolatedDatabase(config.databaseUrl);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./memory-worker.ts', import.meta.url))], {
    env: { ...process.env, MEM0_TELEMETRY: 'false', MEM0_DIR: path.dirname(config.historyPath), COMPAT_WORKER_CONFIG: JSON.stringify(config), COMPAT_WORKER_ACTION: JSON.stringify(action) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  const outcome = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Mem0 worker timed out during ${String(action.op)}`)); }, 30000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); resolve(code ?? 1); });
  });
  if (outcome !== 0) {
    const stage = stderr.match(/^operation:([a-z-]+):start/m)?.[1] ?? String(action.op);
    throw new Error(`Mem0 worker failed during ${stage}`);
  }
  try { return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}'); } catch { throw new Error('Mem0 worker returned invalid structured output'); }
}

export async function runMemoryProbe(config: CompatibilityConfig, options: { fixtureChatFact?: string } = {}): Promise<MemoryProbeReport> {
  assertIsolatedDatabase(config.databaseUrl);
  mkdirSync(path.dirname(config.historyPath), { recursive: true });
  const fixture = config.mode === 'protocol-fixture' ? await startProtocolFixture({ chatFact: options.fixtureChatFact }) : undefined;
  const collection = `compat_memories_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const actual = { ...config, collectionName: collection, ...(fixture ? { chat: { ...config.chat, baseUrl: fixture.baseUrl }, embedding: { ...config.embedding, baseUrl: fixture.baseUrl } } : {}) } as CompatibilityConfig;
  try {
    const checks: MemoryProbeReport['checks'] = [];
    const state = { historyPath: config.historyPath, manifestPath: path.join(path.dirname(config.historyPath), 'memory-probe-manifest.json'), collection };
    const fact = '我喜欢清晨喝热茶。';
    let added: any;
    try { added = await worker(actual, { op: 'add', text: fact, infer: true, user_id: 'owner-a', metadata: { source: 'compat-fixture', visibility: 'private', scope_id: 'private-owner-a', circle_id: 'circle-a' } }); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : 'add failed'}; fixtureCalls=${JSON.stringify(fixture?.calls)}`); }
    const id = added.id as string;
    const owner = await worker(actual, { op: 'search', query: '清晨 热茶', filters: { user_id: 'owner-a' } });
    checks.push({ name: 'infer-add-search-source-metadata', status: owner.results?.some((item: any) => item.id === id && item.metadata?.source === 'compat-fixture') ? 'passed' : 'failed', detail: `memoryId=${id}; infer=true` });
    const inferred = owner.results?.find((item: any) => item.id === id);
    const coreFactMatches = config.mode === 'protocol-fixture'
      ? inferred?.memory === '用户喜欢清晨喝热茶。'
      : typeof inferred?.memory === 'string' && inferred.memory.includes('清晨') && inferred.memory.includes('热茶');
    checks.push({ name: 'inferred-chinese-fact-content', status: coreFactMatches ? 'passed' : 'failed', detail: `fixtureExact=${config.mode === 'protocol-fixture'}; expected core concepts=清晨/热茶` });
    const userB = await worker(actual, { op: 'search', query: '清晨 热茶', filters: { user_id: 'owner-b' } });
    const circleAdded = await worker(actual, { op: 'add', text: '我喜欢清晨喝热茶。', infer: false, user_id: 'owner-a', metadata: { source: 'compat-fixture', visibility: 'circle', scope_id: 'circle-a' } });
    const otherCircle = await worker(actual, { op: 'search', query: '清晨 热茶', filters: { user_id: 'owner-a', scope_id: 'circle-b' } });
    const sameCircle = await worker(actual, { op: 'search', query: '清晨 热茶', filters: { user_id: 'owner-a', scope_id: 'circle-a' } });
    checks.push({ name: 'identity-and-circle-filters', status: Array.isArray(userB.results) && userB.results.length === 0 && Array.isArray(otherCircle.results) && otherCircle.results.length === 0 && Array.isArray(sameCircle.results) && sameCircle.results.length === 1 && sameCircle.results[0]?.id === circleAdded.id && !sameCircle.results.some((item: any) => item.id === id) ? 'passed' : 'failed', detail: 'SDK metadata filter capability only' });
    const sentinel = await worker(actual, { op: 'add', text: fact, infer: false, user_id: 'owner-a', metadata: { source: 'compat-sentinel', visibility: 'private', scope_id: 'sentinel-owner-a' } });
    const reopened = await worker(actual, { op: 'get-history-search', id: sentinel.id, query: fact, filters: { user_id: 'owner-a', scope_id: 'sentinel-owner-a' } });
    checks.push({ name: 'new-process-pg-and-sqlite-recovery', status: reopened.memory?.id === sentinel.id && reopened.memory?.memory === fact && reopened.history?.some((e: any) => String(e.action ?? e.event).toUpperCase() === 'ADD') ? 'passed' : 'failed', detail: JSON.stringify({ current: reopened.memory?.memory, history: reopened.history }) });
    const updatedText = '我更喜欢傍晚喝乌龙茶。';
    const changed = await worker(actual, { op: 'add', text: '我喜欢清晨喝热茶。', infer: false, user_id: 'owner-a', metadata: { source: 'compat-update-delete', scope_id: 'mutable-owner-a' } });
    const changedId = changed.id as string;
    await worker(actual, { op: 'update', id: changedId, text: updatedText });
    const afterUpdate = await worker(actual, { op: 'get-history-search', id: changedId, query: '清晨 热茶', filters: { user_id: 'owner-a', scope_id: 'mutable-owner-a' } });
    const newSearch = await worker(actual, { op: 'search', query: '傍晚 乌龙茶', filters: { user_id: 'owner-a', scope_id: 'mutable-owner-a' } });
    checks.push({ name: 'update-replaces-current-memory', status: afterUpdate.memory?.memory === updatedText && !afterUpdate.search?.results?.some((item: any) => item.memory === '我喜欢清晨喝热茶。') && newSearch.results?.some((item: any) => item.id === changedId && item.memory === updatedText) && afterUpdate.history?.some((e: any) => String(e.action ?? e.event).toUpperCase() === 'UPDATE') ? 'passed' : 'failed', detail: JSON.stringify({ current: afterUpdate.memory?.memory, oldContentReturned: afterUpdate.search?.results?.some((item: any) => item.memory === '我喜欢清晨喝热茶。'), newContentReturned: newSearch.results?.some((item: any) => item.id === changedId && item.memory === updatedText), history: afterUpdate.history }) });
    await worker(actual, { op: 'delete', id: changedId });
    const deleted = await worker(actual, { op: 'get-history-search', id: changedId, query: '傍晚 乌龙茶', filters: { user_id: 'owner-a', scope_id: 'mutable-owner-a' } });
    checks.push({ name: 'delete-current-memory-and-log', status: deleted.memory === null && !deleted.search?.results?.some((item: any) => item.id === changedId) && deleted.history?.some((e: any) => String(e.action ?? e.event).toUpperCase() === 'DELETE') ? 'passed' : 'failed', detail: `historyEvents=${deleted.history?.length ?? 0}; deletion-log retains source event` });
    if (fixture && (fixture.calls.chat < 1 || fixture.calls.embeddings < 1 || fixture.calls.dimensions !== config.embedding.dimensions || fixture.calls.encodingFormat !== 'float')) checks.push({ name: 'fixture-http-used', status: 'failed', detail: JSON.stringify(fixture.calls) });
    else if (fixture) checks.push({ name: 'fixture-http-used', status: 'passed', detail: JSON.stringify(fixture.calls) });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(state.manifestPath, JSON.stringify({ id: sentinel.id, userId: 'owner-a', scopeId: 'sentinel-owner-a', fact, collection: state.collection, historyPath: state.historyPath }, null, 2), { mode: 0o600 });
    return { status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed', checks, fixtureCalls: fixture?.calls ?? { chat: 0, embeddings: 0 }, state };
  } finally {
    if (fixture) await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
}

export async function verifyMemoryProbe(config: CompatibilityConfig, manifest: { id: string; userId: string; scopeId: string; fact: string; collection: string; historyPath: string }): Promise<{ status: 'passed' | 'failed'; checks: MemoryProbeReport['checks'] }> {
  assertIsolatedDatabase(config.databaseUrl);
  if (path.resolve(config.historyPath) !== path.resolve(manifest.historyPath)) throw new Error('Manifest history path does not match configured history path');
  const reopened = await readPersistedMemory(config, manifest);
  const matches = reopened.memory?.id === manifest.id && reopened.memory.memory === manifest.fact &&
    reopened.memory.metadata.user_id === manifest.userId && reopened.memory.metadata.scope_id === manifest.scopeId &&
    reopened.history.some((event) => String(event.action).toUpperCase() === 'ADD');
  const checks = [{ name: 'read-only-restart-sentinel', status: matches ? 'passed' as const : 'failed' as const, detail: `memoryId=${manifest.id}; historyEvents=${reopened.history.length}` }];
  return { status: matches ? 'passed' : 'failed', checks };
}
