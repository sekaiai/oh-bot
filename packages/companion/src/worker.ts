import { createDatabase } from './database/database.js';
import { initializeWorkerQueueSchema, startCompanionWorker } from './worker/worker-service.js';

const databaseUrl = process.env.COMPANION_DATABASE_URL;
const queuePrefix = process.env.COMPANION_WORKER_QUEUE_PREFIX ?? 'companion';
if (!/^[a-z][a-z0-9_-]{0,62}$/.test(queuePrefix)) {
  process.stderr.write('COMPANION_WORKER_QUEUE_PREFIX_INVALID\n');
  process.exit(1);
}
if (!databaseUrl) {
  process.stderr.write('COMPANION_DATABASE_URL_REQUIRED\n');
  process.exit(1);
}
if (process.env.COMPANION_WORKER_QUEUE_SETUP === '1') {
  try {
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    process.exit(0);
  } catch {
    process.stderr.write('COMPANION_QUEUE_SCHEMA_SETUP_FAILED\n');
    process.exit(1);
  }
}
const database = createDatabase(databaseUrl);
let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
let ready = false;
let shutdownRequested = false;
let closing: Promise<void> | undefined;
const close = () => {
  closing ??= (async () => {
    try { await worker?.stop(); } finally { await database.close(); }
  })();
  return closing;
};
const requestShutdown = () => {
  shutdownRequested = true;
  if (!ready) return;
  void close().then(() => process.exit(0), () => {
    process.stderr.write('COMPANION_WORKER_SHUTDOWN_FAILED\n');
    process.exit(1);
  });
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, requestShutdown);
}
try {
  worker = await startCompanionWorker({ database, databaseUrl, queuePrefix });
  if (shutdownRequested) {
    try { await close(); } catch {
      process.stderr.write('COMPANION_WORKER_SHUTDOWN_FAILED\n');
      process.exit(1);
    }
    process.exit(0);
  }
  ready = true;
  process.stdout.write('COMPANION_WORKER_READY\n');
} catch {
  process.stderr.write('COMPANION_WORKER_STARTUP_FAILED\n');
  await database.close();
  process.exit(1);
}
