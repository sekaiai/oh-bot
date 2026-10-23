import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(directory, '..');
const setup = process.argv.includes('--setup');

export type ManagedChild = Readonly<{ script: string; env?: NodeJS.ProcessEnv }>;
export type SupervisorOptions = Readonly<{
  executable?: string;
  cwd?: string;
  children: readonly ManagedChild[];
  spawnChild?: typeof spawn;
  graceMs?: number;
  signal?: AbortSignal;
}>;

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

async function terminate(children: readonly ChildProcess[], graceMs: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of running) { try { child.kill(signal); } catch { /* an exiting child is joined below */ } }
  if (!running.length) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(running.map(childExit)),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
  for (const child of running) if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* join */ } }
  await Promise.all(running.map(childExit));
}

/** Starts peer services as a unit: any failed exit stops and joins every sibling. */
export async function superviseChildren(options: SupervisorOptions): Promise<number> {
  const executable = options.executable ?? process.execPath;
  const spawnChild = options.spawnChild ?? spawn;
  const graceMs = options.graceMs ?? 5_000;
  const children: ChildProcess[] = [];
  const exits: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>[] = [];
  try {
    for (const item of options.children) {
      const child = spawnChild(executable, [path.resolve(options.cwd ?? dist, item.script)], {
        stdio: 'inherit', env: item.env ?? process.env,
      } as SpawnOptions);
      children.push(child);
      exits.push(childExit(child));
    }
  } catch {
    await terminate(children, graceMs);
    return 1;
  }
  if (!children.length) return 1;
  const first = options.signal?.aborted
    ? { code: null, signal: null }
    : await Promise.race([
      ...exits,
      ...(options.signal ? [new Promise<{ code: null; signal: null }>((resolve) => options.signal!.addEventListener('abort', () => resolve({ code: null, signal: null }), { once: true }))] : []),
    ]);
  await terminate(children, graceMs);
  if (first.error || first.code !== 0 || first.signal !== null) return 1;
  return 0;
}

export async function runSetup(options: {
  run?: (script: string, env?: NodeJS.ProcessEnv) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  stopRequested?: () => boolean;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  const run = options.run ?? (async (script, childEnv = env) => {
    const status = await superviseChildren({ children: [{ script, env: childEnv }], graceMs: 5_000, signal: options.signal });
    if (status !== 0) throw new Error('child_failed');
  });
  const check = () => { if (options.stopRequested?.()) throw new Error('shutdown_requested'); };
  check();
  await run('database/migrate-cli.js'); check();
  await run('worker.js', { ...env, COMPANION_WORKER_QUEUE_SETUP: '1' }); check();
  await run('worker.js', { ...env, COMPANION_GRAPH_SETUP: '1' }); check();
  if (env.COMPANION_MEMORY_CHAT_API_URL || env.COMPANION_MEMORY_EMBEDDING_API_URL) {
    await run('worker.js', { ...env, COMPANION_MEMORY_HISTORY_SETUP: '1' }); check();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let requestedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => { requestedSignal ??= signal; };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  try {
    if (setup) {
      const shutdown = new AbortController();
      process.once('SIGINT', () => shutdown.abort());
      process.once('SIGTERM', () => shutdown.abort());
      await runSetup({ stopRequested: () => requestedSignal !== undefined, signal: shutdown.signal });
    } else {
      process.exitCode = await superviseChildren({ children: [{ script: 'main.js' }, { script: 'worker.js' }] });
    }
    if (requestedSignal) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`COMPANION_START_FAILED ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  }
}
