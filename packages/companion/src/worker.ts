import { createDatabase } from './database/database.js';
import { initializeWorkerQueueSchema, startCompanionWorker } from './worker/worker-service.js';
import { createTurnProcessor } from './application/turn-processor.js';
import { setupCompanionCheckpoint } from './runtime/companion-graph.js';
import { IdentityService } from './identity/identity-service.js';
import { InboundService } from './transactions/inbound-service.js';
import { createOneBotAdapter } from './adapters/onebot/adapter.js';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { commitments, conversationPolicies, conversations } from './database/schema/index.js';
import { createMemoryRuntime, setupMemoryHistory } from './application/memory-runtime.js';
import { ProactiveCommitmentService } from './proactive/proactive-commitment-service.js';
import { DeliveryService } from './transactions/delivery-service.js';
import { checkDatabaseReady } from './admin/health.js';

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
if (process.env.COMPANION_GRAPH_SETUP === '1') {
  try {
    await setupCompanionCheckpoint(databaseUrl);
    process.exit(0);
  } catch {
    process.stderr.write('COMPANION_GRAPH_SCHEMA_SETUP_FAILED\n');
    process.exit(1);
  }
}
if (process.env.COMPANION_MEMORY_HISTORY_SETUP === '1') {
  try { await setupMemoryHistory(); process.exit(0); } catch {
    process.stderr.write('COMPANION_MEMORY_HISTORY_SETUP_FAILED\n');
    process.exit(1);
  }
}
const database = createDatabase(databaseUrl);
let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
let runtime: Awaited<ReturnType<typeof createTurnProcessor>> | undefined;
let oneBot: ReturnType<typeof createOneBotAdapter> | undefined;
let memory: Awaited<ReturnType<typeof createMemoryRuntime>>;
let proactive: ProactiveCommitmentService | undefined;
let deliveries: DeliveryService | undefined;
let maintenanceTimer: NodeJS.Timeout | undefined;
let maintenanceRun: Promise<void> | undefined;
let ready = false;
let shutdownRequested = false;
let closing: Promise<void> | undefined;
const close = () => {
  closing ??= (async () => {
    try { await worker?.stop(); } finally {
      try { await oneBot?.stop(); } finally {
        if (maintenanceTimer) clearInterval(maintenanceTimer);
        try { await maintenanceRun; } catch { /* shutdown joins the final maintenance pass */ }
        try { await memory?.close(); } finally {
          try { await runtime?.close(); } finally { await database.close(); }
        }
      }
    }
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
  if (!await checkDatabaseReady(database)) throw new Error('COMPANION_DATABASE_SCHEMA_UNAVAILABLE');
  memory = await createMemoryRuntime(database);
  runtime = await createTurnProcessor({ database, databaseUrl, memory: memory?.gateway });
  const oneBotEnabled = process.env.COMPANION_ONEBOT_ENABLED === '1';
  if (oneBotEnabled) {
    const characterId = process.env.COMPANION_CHARACTER_ID;
    if (!characterId) throw new Error('onebot_config_invalid');
    const identity = new IdentityService(database);
    const inbound = new InboundService(database, identity);
    oneBot = createOneBotAdapter({
      enabled: true,
      url: process.env.COMPANION_ONEBOT_WS_URL,
      accessToken: process.env.COMPANION_ONEBOT_ACCESS_TOKEN,
      selfId: process.env.COMPANION_ONEBOT_SELF_ID,
      characterId,
      database,
      validateDeliveryContext: async (turnId) => { await runtime!.validatePendingContext(turnId); },
      onInbound: async (event, evidence, metadata) => {
        if (event.conversationKind === 'group') {
          const [policy] = await database.db.select({ triggerMode: conversationPolicies.triggerMode })
            .from(conversations).leftJoin(conversationPolicies, eq(conversationPolicies.conversationId, conversations.id))
            .where(and(eq(conversations.characterId, characterId), eq(conversations.platform, 'qq'), eq(conversations.platformConversationId, event.conversationPlatformId), eq(conversations.kind, 'group'))).limit(1);
          const mode = policy?.triggerMode ?? 'mentioned';
          if (mode === 'disabled' || mode === 'mentioned' && !metadata?.mentionedSelf) return;
        }
        if (event.conversationKind === 'group') {
          const roster = await oneBot!.fetchCompleteRoster(event.conversationPlatformId);
          await inbound.accept(characterId, event, evidence, roster.evidence);
        } else {
          await inbound.accept(characterId, event, evidence);
        }
      },
    });
    await oneBot.start();
    if (process.env.COMPANION_PROACTIVE_ENABLED === '1') {
      proactive = new ProactiveCommitmentService(database);
      deliveries = new DeliveryService(database);
    }
  }
  worker = await startCompanionWorker({
    database, databaseUrl, queuePrefix, processor: runtime.processor,
    ...(oneBot ? { sender: (job) => oneBot!.sendDelivery(job.deliveryId) } : {}),
  });
  if (memory || proactive) {
    const runMaintenance = () => {
      if (maintenanceRun) return;
      maintenanceRun = (async () => {
        if (memory) {
          await memory.gateway.processPending();
          await memory.gateway.processDeletions();
        }
        if (proactive && deliveries && oneBot) {
          await proactive.recoverExpiredClaims();
          const due = await database.db.select({ id: commitments.id }).from(commitments).where(and(
            eq(commitments.status, 'scheduled'), isNull(commitments.jobId), lte(commitments.dueAt, new Date()),
          )).orderBy(commitments.dueAt).limit(20);
          for (const item of due) {
            await proactive.deliverDue(item.id, async ({ operationKey, conversationId, description }) => {
              const deliveryId = await deliveries!.stageStandalone({ conversationId, operationKey, content: { text: description } });
              const result = await deliveries!.dispatchStandalone(deliveryId, `proactive-${worker!.workerId}`, ({ deliveryId: id }) => oneBot!.sendDelivery(id));
              if (!result) return { kind: 'receipt_unknown', errorCode: 'delivery_already_claimed' };
              return result.kind === 'unknown' ? { kind: 'receipt_unknown', errorCode: result.errorCode } : result;
            }, `proactive-${worker!.workerId}`);
          }
        }
      })().catch(() => { process.stderr.write('COMPANION_MAINTENANCE_FAILED\n'); }).finally(() => { maintenanceRun = undefined; });
    };
    runMaintenance();
    maintenanceTimer = setInterval(runMaintenance, 5_000);
    maintenanceTimer.unref();
  }
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
  try { await oneBot?.stop(); } finally {
    try { await runtime?.close(); } finally { await database.close(); }
  }
  process.exit(1);
}
