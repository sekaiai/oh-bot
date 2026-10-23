import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { CompatibilityConfig } from './config.js';
import { assertIsolatedDatabase } from './isolation.js';

export interface GraphProbeManifest {
  version: 1;
  threadId: string;
  resumeValue: string;
  initialValue: string;
  nodeOneValue: string;
  nodeTwoValue: string;
  counterTable: 'compatibility_graph_probe_runs';
  historyPath: string;
}

export interface GraphProbeReport {
  status: 'passed' | 'failed';
  checks: Array<{ name: string; status: 'passed' | 'failed'; detail: string }>;
  manifest: GraphProbeManifest;
  statePath: string;
  sdk: 'langgraph 1.5.1 / checkpoint-postgres 1.1.0';
}

export interface GraphVerifyReport {
  status: 'passed' | 'failed';
  checks: Array<{ name: string; status: 'passed' | 'failed'; detail: string }>;
}

type ProbeState = { initialValue?: string; nodeOneValue?: string; nodeTwoValue?: string; resumeValue?: string };
const State = Annotation.Root({
  initialValue: Annotation<string>(),
  nodeOneValue: Annotation<string>(),
  nodeTwoValue: Annotation<string>(),
  resumeValue: Annotation<string>(),
});
const counterTable = 'compatibility_graph_probe_runs' as const;

function createPool(connectionString: string, readOnly = false): Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    idleTimeoutMillis: 5_000,
    max: 3,
    ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  });
}

async function createGraph(config: CompatibilityConfig, table: string, threadId: string, options: { setup?: boolean; readOnly?: boolean } = {}) {
  // Guard before constructing the pool or PostgresSaver.
  assertIsolatedDatabase(config.databaseUrl);
  const pool = createPool(config.databaseUrl, options.readOnly);
  const saver = new PostgresSaver(pool);
  try {
    if (options.setup !== false) await saver.setup();
    const graph = new StateGraph(State)
      .addNode('node1', async (state: ProbeState) => {
        await pool.query(`INSERT INTO ${table} (thread_id, execution_count) VALUES ($1, 1)`, [threadId]);
        return { nodeOneValue: `node1:${state.initialValue}` };
      })
      .addNode('node2', async (state: ProbeState) => {
        const resumed = interrupt({ prompt: 'resume graph probe' }) as string;
        return { nodeTwoValue: `node2:${resumed}`, resumeValue: resumed };
      })
      .addEdge(START, 'node1')
      .addEdge('node1', 'node2')
      .addEdge('node2', END)
      .compile({ checkpointer: saver });
    return { pool, saver, graph };
  } catch (error) {
    await saver.end().catch(() => undefined);
    throw error;
  }
}

function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

function stateMatches(state: ProbeState | undefined, manifest: GraphProbeManifest): boolean {
  return state?.initialValue === manifest.initialValue && state.nodeOneValue === manifest.nodeOneValue &&
    state.nodeTwoValue === manifest.nodeTwoValue && state.resumeValue === manifest.resumeValue;
}

export async function runGraphProbe(config: CompatibilityConfig): Promise<GraphProbeReport> {
  assertIsolatedDatabase(config.databaseUrl);
  const statePath = path.dirname(config.historyPath);
  mkdirSync(statePath, { recursive: true });
  const manifest: GraphProbeManifest = {
    version: 1,
    threadId: randomUUID(),
    resumeValue: `resume:${randomUUID()}`,
    initialValue: `initial:${randomUUID()}`,
    nodeOneValue: '',
    nodeTwoValue: '',
    counterTable,
    historyPath: path.resolve(config.historyPath),
  };
  manifest.nodeOneValue = `node1:${manifest.initialValue}`;
  manifest.nodeTwoValue = `node2:${manifest.resumeValue}`;
  const bootstrap = createPool(config.databaseUrl);
  try {
    await bootstrap.query(`CREATE TABLE IF NOT EXISTS ${counterTable} (thread_id text PRIMARY KEY, execution_count integer NOT NULL)`);
  } finally { await bootstrap.end(); }

  const first = await createGraph(config, counterTable, manifest.threadId);
  let paused = false;
  let counterAfterPause = 0;
  try {
    const firstState = await first.graph.invoke({ initialValue: manifest.initialValue }, threadConfig(manifest.threadId));
    const snapshot = await first.graph.getState(threadConfig(manifest.threadId));
    paused = Boolean(snapshot.tasks.some((task) => task.interrupts?.length));
    const result = await first.pool.query<{ execution_count: number }>(`SELECT execution_count FROM ${counterTable} WHERE thread_id = $1`, [manifest.threadId]);
    counterAfterPause = Number(result.rows[0]?.execution_count ?? 0);
    if (!paused || !firstState || counterAfterPause !== 1) throw new Error('Graph failed to persist the paused state');
  } finally {
    await first.saver.end();
  }

  const second = await createGraph(config, counterTable, manifest.threadId);
  let finalState: ProbeState | undefined;
  let counterAfterResume = 0;
  try {
    const before = await second.graph.getState(threadConfig(manifest.threadId));
    if (!before.tasks.some((task) => task.interrupts?.length)) throw new Error('Fresh saver did not read the saved interrupt');
    finalState = await second.graph.invoke(new Command({ resume: manifest.resumeValue }), threadConfig(manifest.threadId));
    const result = await second.pool.query<{ execution_count: number }>(`SELECT execution_count FROM ${counterTable} WHERE thread_id = $1`, [manifest.threadId]);
    counterAfterResume = Number(result.rows[0]?.execution_count ?? 0);
    const otherThread = await second.graph.getState(threadConfig(`${manifest.threadId}:other`));
    if (counterAfterResume !== 1 || otherThread.values.initialValue !== undefined) throw new Error('Graph resume duplicated node1 or mixed thread state');
  } finally { await second.saver.end(); }

  const checks = [
    { name: 'fresh-saver-resumes-once', status: paused && counterAfterPause === 1 && counterAfterResume === 1 && stateMatches(finalState, manifest) ? 'passed' as const : 'failed' as const, detail: `paused=${paused}; executionsBeforeResume=${counterAfterPause}; executionsAfterResume=${counterAfterResume}` },
    { name: 'thread-state-isolation', status: 'passed' as const, detail: 'unseen thread has no persisted probe state' },
  ];
  const manifestPath = path.join(statePath, 'graph-probe-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed', checks, manifest, statePath: manifestPath, sdk: 'langgraph 1.5.1 / checkpoint-postgres 1.1.0' };
}

export async function verifyGraphProbe(config: CompatibilityConfig, manifest: GraphProbeManifest): Promise<GraphVerifyReport> {
  assertIsolatedDatabase(config.databaseUrl);
  if (manifest.version !== 1 || manifest.counterTable !== counterTable || !manifest.threadId || path.resolve(config.historyPath) !== path.resolve(manifest.historyPath)) {
    throw new Error('Invalid graph recovery manifest');
  }
  const reopened = await createGraph(config, counterTable, manifest.threadId, { setup: false, readOnly: true });
  try {
    const readOnly = await reopened.pool.query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only');
    const snapshot = await reopened.graph.getState(threadConfig(manifest.threadId));
    const query = await reopened.pool.query<{ execution_count: number }>(`SELECT execution_count FROM ${counterTable} WHERE thread_id = $1`, [manifest.threadId]);
    const count = Number(query.rows[0]?.execution_count ?? 0);
    const readOnlyPassed = readOnly.rows[0]?.default_transaction_read_only === 'on';
    const statePassed = stateMatches(snapshot.values as ProbeState, manifest) && count === 1;
    const checks = [
      { name: 'read-only-connection', status: readOnlyPassed ? 'passed' as const : 'failed' as const, detail: `default_transaction_read_only=${readOnly.rows[0]?.default_transaction_read_only ?? 'unknown'}` },
      { name: 'read-only-persisted-final-state', status: statePassed ? 'passed' as const : 'failed' as const, detail: `threadId=${manifest.threadId}; executions=${count}; stateMatches=${stateMatches(snapshot.values as ProbeState, manifest)}` },
    ];
    return { status: readOnlyPassed && statePassed ? 'passed' : 'failed', checks };
  } finally { await reopened.saver.end(); }
}
