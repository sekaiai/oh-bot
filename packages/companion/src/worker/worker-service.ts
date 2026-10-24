import { randomUUID } from 'node:crypto';
import { PgBoss, type Job } from 'pg-boss';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { businessOutbox, deliveryOutbox, jobLogs, turns as turnRows } from '../database/schema/index.js';
import { DeliveryService, type DeliveryResult } from '../transactions/delivery-service.js';
import { TurnService } from '../transactions/turn-service.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { JobAttemptService, type JobAttemptToken } from './job-attempt-service.js';
import { checkWorkerQueueReady } from '../admin/health.js';

const processPayload = z.object({ operationKey: z.string().min(1), outboxId: z.string().uuid(), kind: z.literal('process_turn'), payload: z.object({ turnId: z.string().uuid() }).passthrough() }).strict();
const deliveryPayload = z.object({ operationKey: z.string().min(1), outboxId: z.string().uuid(), kind: z.literal('deliver_message'), payload: z.object({ turnId: z.string().uuid(), deliveryId: z.string().uuid() }).strict() }).strict();
const exposedWorkerErrors = new Set(['invalid_job', 'processor_unavailable', 'sender_unavailable', 'turn_busy', 'turn_lease_lost', 'processor_failed', 'outbox_dispatch_inflight', 'delivery_busy']);
function safeWorkerCode(error: unknown): string {
  return error instanceof Error && exposedWorkerErrors.has(error.message)
    ? error.message
    : 'job_failed';
}
async function sanitizedHandler(_jobs: Job<unknown>[], handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (error) {
    throw new Error(safeWorkerCode(error));
  }
}
function attemptFailureCode(error: unknown): string {
  const code = safeWorkerCode(error);
  return code === 'job_failed' ? 'job_attempt_failed' : code;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export type CompanionProcessor = (input: { turnId: string; workerId: string }) => Promise<{ text: string; [key: string]: unknown }>;
export type CompanionSender = (input: { deliveryId: string; content: unknown; operationKey: string }) => Promise<DeliveryResult>;
export type WorkerOptions = { database: Database; databaseUrl: string; processor?: CompanionProcessor; sender?: CompanionSender; workerId?: string; dispatchIntervalMs?: number; boss?: PgBoss; bossFactory?: () => PgBoss; outboxOperationKeys?: readonly string[]; queuePrefix?: string };

export async function initializeWorkerQueueSchema(databaseUrl: string, queuePrefix = 'companion'): Promise<void> {
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) throw new Error('WORKER_DATABASE_REQUIRED');
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(queuePrefix)) throw new Error('COMPANION_WORKER_QUEUE_PREFIX_INVALID');
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: true, createSchema: true });
  try {
    await boss.start();
    await boss.createQueue(`${queuePrefix}.process`);
    await boss.createQueue(`${queuePrefix}.deliver`);
  } finally { await boss.stop({ graceful: true, timeout: 30_000 }); }
}

/** pg-boss orchestrates durable jobs; business state remains fenced by TurnService/DeliveryService. */
export async function startCompanionWorker(options: WorkerOptions) {
  if (!options.database || !/^postgres(?:ql)?:\/\//i.test(options.databaseUrl)) throw new Error('WORKER_DATABASE_REQUIRED');
  if (!await checkWorkerQueueReady(options.database)) throw new Error('COMPANION_QUEUE_SCHEMA_UNAVAILABLE');
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const boss = options.boss ?? options.bossFactory?.() ?? new PgBoss({ connectionString: options.databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  const ownsBoss = !options.boss;
  const queuePrefix = options.queuePrefix ?? 'companion';
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(queuePrefix)) throw new Error('COMPANION_WORKER_QUEUE_PREFIX_INVALID');
  const processQueue = `${queuePrefix}.process`;
  const deliveryQueue = `${queuePrefix}.deliver`;
  const dispatcher = new OutboxDispatcher(options.database, boss, { operationKeys: options.outboxOperationKeys, queuePrefix });
  const turns = new TurnService(options.database);
  const deliveries = new DeliveryService(options.database);
  const attempts = new JobAttemptService(options.database);
  let processWorkerId: string | undefined;
  let deliveryWorkerId: string | undefined;
  const onBossError = (error: unknown) => {
    process.stderr.write(`COMPANION_PG_BOSS_${safeWorkerCode(error).toUpperCase()}\n`);
  };
  const operationStatus = async (operationKey: string) => {
    const [row] = await options.database.db.select({ status: jobLogs.status }).from(jobLogs).where(eq(jobLogs.operationKey, operationKey)).limit(1);
    return row?.status;
  };
  const failAttemptQuietly = async (token: JobAttemptToken, errorCode: string) => {
    try { await attempts.fail(token, errorCode); } catch { /* expired attempts cannot alter a successor */ }
  };
  const assertDispatchedOperation = async (input: { outboxId: string; operationKey: string; kind: string; payload: unknown }): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (true) {
      const [row] = await options.database.db.select().from(businessOutbox).where(eq(businessOutbox.id, input.outboxId)).limit(1);
      if (!row || (row.status !== 'dispatched' && row.status !== 'leased') || row.operationKey !== input.operationKey || row.kind !== input.kind || canonicalJson(row.payload) !== canonicalJson(input.payload)) throw new Error('invalid_job');
      if (row.status === 'dispatched') return;
      if (Date.now() >= deadline) throw new Error('outbox_dispatch_inflight');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let dispatching: Promise<void> = Promise.resolve();
  let errorListenerAdded = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = undefined; }
    try { await dispatching; } catch { /* continue releasing resources */ }
    if (processWorkerId) { try { await boss.offWork(processQueue, { id: processWorkerId, wait: true }); } catch { /* continue releasing resources */ } finally { processWorkerId = undefined; } }
    if (deliveryWorkerId) { try { await boss.offWork(deliveryQueue, { id: deliveryWorkerId, wait: true }); } catch { /* continue releasing resources */ } finally { deliveryWorkerId = undefined; } }
    if (errorListenerAdded) { try { boss.off('error', onBossError); } catch { /* continue releasing resources */ } finally { errorListenerAdded = false; } }
    if (ownsBoss) { try { await boss.stop({ graceful: true, timeout: 30_000 }); } catch { /* cleanup remains best effort */ } }
  })();
  try {
    await deliveries.recoverExpiredSending();
    await boss.start();
    boss.on('error', onBossError);
    errorListenerAdded = true;
    await boss.createQueue(processQueue);
    await boss.createQueue(deliveryQueue);
    processWorkerId = await boss.work(processQueue, { localConcurrency: 4 }, async (jobs: Job<unknown>[]) => sanitizedHandler(jobs, async () => {
      for (const job of jobs) {
        const parsed = processPayload.safeParse(job.data);
        if (!parsed.success) throw new Error('invalid_job');
        await assertDispatchedOperation(parsed.data);
        if (parsed.data.operationKey !== `turn:${parsed.data.payload.turnId}:process`) throw new Error('invalid_job');
        const attempt = await attempts.claim(parsed.data.operationKey, job.id, 60_000);
        if (!attempt) {
          if (await operationStatus(parsed.data.operationKey) === 'completed') continue;
          throw new Error('turn_busy');
        }
        let activeAttempt = attempt;
        let activeLease: NonNullable<Awaited<ReturnType<TurnService['claim']>>>;
        try {
          if (!options.processor) throw new Error('processor_unavailable');
          const lease = await turns.claim(parsed.data.payload.turnId, workerId, 60_000);
          if (!lease) {
            const [state] = await options.database.db.select().from(turnRows).where(eq(turnRows.id, parsed.data.payload.turnId)).limit(1);
            if (state?.status === 'processing' && state.leaseExpiresAt && state.leaseExpiresAt > new Date()) throw new Error('turn_busy');
            if (state?.status === 'failed') await attempts.fail(activeAttempt, 'job_attempt_failed');
            else await attempts.complete(activeAttempt);
            continue;
          }
          activeLease = lease;
          let heartbeatFailure: unknown;
          let renewing: Promise<void> | undefined;
          const heartbeat = setInterval(() => {
            if (renewing || heartbeatFailure) return;
            renewing = Promise.all([
              turns.renew(activeLease, 60_000).then((renewed) => { activeLease = renewed; }),
              attempts.renew(activeAttempt, 60_000).then((renewed) => { activeAttempt = renewed; }),
            ]).then(() => undefined).catch((error: unknown) => { heartbeatFailure = error; }).finally(() => { renewing = undefined; });
          }, 20_000);
          heartbeat.unref?.();
          try {
            const generated = await options.processor({ turnId: lease.turnId, workerId });
            clearInterval(heartbeat);
            await renewing;
            if (heartbeatFailure) throw new Error('turn_lease_lost');
            await turns.persistGenerated(activeLease, generated);
            await attempts.complete(activeAttempt);
          } catch (error) {
            clearInterval(heartbeat);
            await renewing;
            if (!heartbeatFailure) {
              try { await turns.fail(activeLease, 'processor_failed'); } catch { /* lease may have expired or generation already committed */ }
            }
            await failAttemptQuietly(activeAttempt, attemptFailureCode(error));
            throw new Error(error instanceof Error && error.message === 'turn_lease_lost' ? 'turn_lease_lost' : 'processor_failed');
          }
        } catch (error) {
          await failAttemptQuietly(activeAttempt, attemptFailureCode(error));
          throw error;
        }
      }
    }));
    deliveryWorkerId = await boss.work(deliveryQueue, { localConcurrency: 4 }, async (jobs: Job<unknown>[]) => sanitizedHandler(jobs, async () => {
      for (const job of jobs) {
        const parsed = deliveryPayload.safeParse(job.data);
        if (!parsed.success) throw new Error('invalid_job');
        await assertDispatchedOperation(parsed.data);
        if (parsed.data.operationKey !== `turn:${parsed.data.payload.turnId}:deliver`) throw new Error('invalid_job');
        const attempt = await attempts.claim(parsed.data.operationKey, job.id, 60_000);
        if (!attempt) {
          if (await operationStatus(parsed.data.operationKey) === 'completed') continue;
          throw new Error('delivery_busy');
        }
        try {
          if (!options.sender) throw new Error('sender_unavailable');
          const token = await deliveries.claimPending(parsed.data.payload.deliveryId, workerId, 60_000);
          if (!token) {
            const [state] = await options.database.db.select({ status: deliveryOutbox.status }).from(deliveryOutbox).where(eq(deliveryOutbox.id, parsed.data.payload.deliveryId)).limit(1);
            if (state?.status === 'sent' || state?.status === 'receipt_unknown') await attempts.complete(attempt);
            else if (state?.status === 'failed') await attempts.fail(attempt, 'job_attempt_failed');
            else throw new Error('delivery_busy');
            continue;
          }
          const [row] = await options.database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, token.deliveryId)).limit(1);
          if (!row || row.turnId !== parsed.data.payload.turnId || row.operationKey !== parsed.data.operationKey) throw new Error('invalid_job');
          let result: DeliveryResult;
          try { result = await options.sender({ deliveryId: token.deliveryId, content: row.content, operationKey: row.operationKey }); }
          catch { result = { kind: 'unknown', errorCode: 'sender_result_unknown' }; }
          await deliveries.finish(token, result);
          if (result.kind === 'not_sent') await attempts.fail(attempt, 'job_attempt_failed');
          else await attempts.complete(attempt);
        } catch (error) {
          await failAttemptQuietly(attempt, attemptFailureCode(error));
          throw error;
        }
      }
    }));
    const dispatchIntervalMs = options.dispatchIntervalMs ?? 1_000;
    const dispatchOnce = () => {
      if (stopped) return;
      dispatching = dispatching.then(async () => {
        if (stopped) return;
        try {
          await deliveries.recoverExpiredSending();
          await dispatcher.dispatchBatch();
        } catch { /* persisted outbox remains visible and lease expires */ }
      });
    };
    dispatchOnce();
    timer = setInterval(dispatchOnce, dispatchIntervalMs);
    timer.unref?.();
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    workerId,
    boss,
    dispatcher,
    stop: cleanup,
  };
}

