import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompatibilityConfig } from './config.js';
import { loadConfig } from './config.js';
import { assertIsolatedDatabase } from './isolation.js';
import { runMemoryProbe, verifyMemoryProbe, type MemoryProbeReport } from './memory-probe.js';
import { runGraphProbe, verifyGraphProbe, type GraphProbeManifest } from './graph-probe.js';

export interface CompatibilityReport {
  type: 'oh-bot-compatibility';
  mode: CompatibilityConfig['mode'];
  status: 'passed' | 'failed';
  checks: Array<{ name: string; status: 'passed' | 'failed'; detail: string }>;
  sdks: { mem0: '3.3.1'; graph: '1.5.1'; postgresSaver: '1.1.0' };
  manifestPath: string;
}

interface CombinedManifest {
  type: 'oh-bot-compatibility-manifest';
  version: 1;
  memory: { id: string; userId: string; scopeId: string; fact: string; collection: string; historyPath: string };
  graph: GraphProbeManifest;
}

const sdkVersions = { mem0: '3.3.1', graph: '1.5.1', postgresSaver: '1.1.0' } as const;

function safeChecks(checks: Array<{ name: string; status: 'passed' | 'failed' }>) {
  return checks.map(({ name, status }) => ({ name, status, detail: status === 'passed' ? '验证通过' : '验证失败' }));
}

export async function runCompatibility(config: CompatibilityConfig): Promise<CompatibilityReport> {
  assertIsolatedDatabase(config.databaseUrl);
  const memory = await runMemoryProbe(config);
  const graph = await runGraphProbe(config);
  const memoryManifest = JSON.parse(readFileSync(memory.state.manifestPath, 'utf8')) as CombinedManifest['memory'];
  const manifest: CombinedManifest = { type: 'oh-bot-compatibility-manifest', version: 1, memory: memoryManifest, graph: graph.manifest };
  const historyDirectory = path.dirname(config.historyPath);
  const stateDirectory = path.basename(historyDirectory) === '.state' ? historyDirectory : path.join(historyDirectory, '.state');
  const manifestPath = path.join(stateDirectory, 'compatibility-manifest.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const checks = [
    ...safeChecks(memory.checks),
    ...safeChecks(graph.checks),
  ];
  return { type: 'oh-bot-compatibility', mode: config.mode, status: memory.status === 'passed' && graph.status === 'passed' ? 'passed' : 'failed', checks, sdks: sdkVersions, manifestPath };
}

function parseManifest(value: unknown): CombinedManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid compatibility manifest');
  const manifest = value as Partial<CombinedManifest>;
  const m = manifest.memory as Partial<CombinedManifest['memory']> | undefined;
  const g = manifest.graph as Partial<GraphProbeManifest> | undefined;
  if (manifest.type !== 'oh-bot-compatibility-manifest' || manifest.version !== 1 ||
      !m || typeof m.id !== 'string' || typeof m.userId !== 'string' || typeof m.scopeId !== 'string' ||
      typeof m.fact !== 'string' || typeof m.collection !== 'string' || typeof m.historyPath !== 'string' ||
      !g || g.version !== 1 || typeof g.threadId !== 'string' || typeof g.resumeValue !== 'string' ||
      typeof g.initialValue !== 'string' || typeof g.nodeOneValue !== 'string' || typeof g.nodeTwoValue !== 'string' ||
      g.counterTable !== 'compatibility_graph_probe_runs' || typeof g.historyPath !== 'string') {
    throw new Error('Invalid compatibility manifest');
  }
  return manifest as CombinedManifest;
}

async function verifyCompatibility(config: CompatibilityConfig, manifestPath: string): Promise<CompatibilityReport> {
  assertIsolatedDatabase(config.databaseUrl);
  let manifest: CombinedManifest;
  try { manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))); }
  catch { throw new Error('Invalid or unreadable compatibility manifest'); }
  const [memory, graph] = await Promise.all([
    verifyMemoryProbe(config, manifest.memory),
    verifyGraphProbe(config, manifest.graph),
  ]);
  const checks = [...safeChecks(memory.checks), ...safeChecks(graph.checks)];
  return { type: 'oh-bot-compatibility', mode: config.mode, status: memory.status === 'passed' && graph.status === 'passed' ? 'passed' : 'failed', checks, sdks: sdkVersions, manifestPath: path.resolve(manifestPath) };
}

function safeError(error: unknown): string {
  if (error instanceof Error && /^Missing or empty configuration: [A-Z0-9_]+$/.test(error.message)) return error.message;
  if (error instanceof Error && error.name === 'IsolatedDatabaseError') return '数据库隔离校验失败；COMPAT_DATABASE_URL 数据库名必须以 _compat 结尾';
  if (error instanceof Error && error.message === 'Invalid or unreadable compatibility manifest') return error.message;
  if (error instanceof Error && /^Invalid mode: COMPAT_MODE$/.test(error.message)) return error.message;
  return 'Compatibility execution failed (details withheld for credential safety)';
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<number> {
  try {
    const config = loadConfig(env);
    let report: CompatibilityReport;
    if (args[0] === '--verify' && args.length === 2) report = await verifyCompatibility(config, args[1]!);
    else if (args.length === 0) report = await runCompatibility(config);
    else throw new Error('Invalid CLI arguments');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; });
}
