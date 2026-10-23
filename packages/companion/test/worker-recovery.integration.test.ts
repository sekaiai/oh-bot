import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { createAdminApplication } from '../src/admin/app.js';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { auditEvents, businessOutbox, characters, conversations, deliveryOutbox, jobLogs, messages, people, turns } from '../src/database/schema/index.js';
import { DeliveryService } from '../src/transactions/delivery-service.js';
import { TurnService } from '../src/transactions/turn-service.js';
import { initializeWorkerQueueSchema, startCompanionWorker } from '../src/worker/worker-service.js';
import { OutboxDispatcher } from '../src/worker/outbox-dispatcher.js';
import { requireWorkerDatabaseUrl, uuid } from './helpers.js';

const adminToken = 'f3b-recovery-admin-token-long-enough-32';
const waitFor = async (condition: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${label}_timeout`);
};

async function fixture(database: ReturnType<typeof createDatabase>, label: string) {
  const characterId = uuid();
  const personId = uuid();
  await database.db.insert(characters).values({ id: characterId, name: `${label}-${characterId}` });
  await database.db.insert(people).values({ id: personId, displayName: label });
  const [conversation] = await database.db.insert(conversations).values({ characterId, platform: 'qq', platformConversationId: `${label}-${uuid()}`, kind: 'private' }).returning();
  const [message] = await database.db.insert(messages).values({ conversationId: conversation.id, personId, platform: 'qq', platformEventId: `${label}-${uuid()}`, role: 'user', text: 'synthetic' }).returning();
  const [turn] = await database.db.insert(turns).values({ conversationId: conversation.id, personId, inboundMessageId: message.id, graphThreadId: uuid(), status: 'received' }).returning();
  return { characterId, personId, conversationId: conversation.id, turnId: turn.id };
}

async function cleanup(database: ReturnType<typeof createDatabase>, boss: PgBoss, own: Awaited<ReturnType<typeof fixture>>, queuePrefix: string, operationKeys: string[], jobIds: string[]) {
  for (const id of new Set(jobIds)) {
    for (const queue of [`${queuePrefix}.process`, `${queuePrefix}.deliver`]) {
      try { await boss.deleteJob(queue, id); } catch { /* the id belongs to the other queue */ }
    }
  }
  const logs = operationKeys.length ? await database.db.select({ id: jobLogs.id }).from(jobLogs).where(inArray(jobLogs.operationKey, operationKeys)) : [];
  for (const row of logs) await database.db.delete(auditEvents).where(eq(auditEvents.targetId, row.id));
  if (operationKeys.length) {
    await database.db.delete(jobLogs).where(inArray(jobLogs.operationKey, operationKeys));
    await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, operationKeys));
  }
  await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.turnId, own.turnId));
  await database.db.delete(turns).where(eq(turns.id, own.turnId));
  await database.db.delete(messages).where(eq(messages.conversationId, own.conversationId));
  await database.db.delete(conversations).where(eq(conversations.id, own.conversationId));
  await database.db.delete(people).where(eq(people.id, own.personId));
  await database.db.delete(characters).where(eq(characters.id, own.characterId));
}

test('exhausted unavailable job is audited through HTTP retry, then a new worker generates and a later worker sends', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const queuePrefix = `f3brecover_${uuid().replaceAll('-', '')}`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  let own: Awaited<ReturnType<typeof fixture>> | undefined;
  let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  const operationKeys: string[] = [];
  const jobIds: string[] = [];
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    own = await fixture(database, 'f3b-recover');
    const processKey = `turn:${own.turnId}:process`;
    const deliveryKey = `turn:${own.turnId}:deliver`;
    operationKeys.push(processKey, deliveryKey);
    await database.db.insert(businessOutbox).values({ operationKey: processKey, kind: 'process_turn', payload: { turnId: own.turnId } });
    const originalSend = boss.send.bind(boss);
    boss.send = (async (...args: Parameters<PgBoss['send']>) => {
      const id = await (originalSend as (...parameters: unknown[]) => Promise<string | null>)(args[0], args[1], { ...(args[2] as object), retryLimit: 0 });
      if (id) jobIds.push(id);
      return id;
    }) as PgBoss['send'];
    worker = await startCompanionWorker({ database, databaseUrl, boss, queuePrefix, outboxOperationKeys: [processKey], dispatchIntervalMs: 25 });
    await waitFor(async () => (await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, processKey)))[0]?.status === 'failed', 'unavailable_log');
    const [failed] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, processKey));
    assert.equal(failed.errorCode, 'processor_unavailable');
    assert.equal((await database.db.select().from(turns).where(eq(turns.id, own.turnId)))[0]?.status, 'received');
    assert.ok(failed.pgBossId);
    await waitFor(async () => (await boss.getJobById(`${queuePrefix}.process`, failed.pgBossId!))?.state === 'failed', 'boss_exhausted');
    await worker.stop(); worker = undefined;
    app = await createAdminApplication({ database, adminToken });
    const headers = { authorization: `Bearer ${adminToken}` };
    const badStatus = await app.inject({ method: 'GET', url: '/admin/job-logs?status=bogus', headers });
    assert.equal(badStatus.statusCode, 400);
    const filtered = await app.inject({ method: 'GET', url: `/admin/job-logs?status=failed&limit=100`, headers });
    assert.equal(filtered.statusCode, 200, filtered.body);
    assert.ok(filtered.json().some((row: { id: string }) => row.id === failed.id));
    assert.ok(filtered.json().every((row: { status: string }) => row.status === 'failed'));
    await database.db.update(jobLogs).set({ leaseExpiresAt: new Date(Date.now() + 30_000) }).where(eq(jobLogs.id, failed.id));
    assert.equal((await app.inject({ method: 'POST', url: `/admin/job-logs/${failed.id}/retry`, headers, payload: {} })).statusCode, 409);
    await database.db.update(jobLogs).set({ leaseExpiresAt: null }).where(eq(jobLogs.id, failed.id));
    await database.db.update(businessOutbox).set({ status: 'leased', leaseOwner: 'other-dispatcher', leaseExpiresAt: new Date(Date.now() + 30_000) }).where(eq(businessOutbox.operationKey, processKey));
    assert.equal((await app.inject({ method: 'POST', url: `/admin/job-logs/${failed.id}/retry`, headers, payload: {} })).statusCode, 409);
    await database.db.update(businessOutbox).set({ status: 'dispatched', leaseOwner: null, leaseExpiresAt: null }).where(eq(businessOutbox.operationKey, processKey));
    await database.db.update(turns).set({ leaseOwner: 'other-processor', leaseExpiresAt: new Date(Date.now() + 30_000) }).where(eq(turns.id, own.turnId));
    assert.equal((await app.inject({ method: 'POST', url: `/admin/job-logs/${failed.id}/retry`, headers, payload: {} })).statusCode, 409);
    await database.db.update(turns).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(turns.id, own.turnId));
    const retry = await app.inject({ method: 'POST', url: `/admin/job-logs/${failed.id}/retry`, headers, payload: {} });
    assert.equal(retry.statusCode, 201, retry.body);
    const [reset] = await database.db.select().from(jobLogs).where(eq(jobLogs.id, failed.id));
    assert.equal(reset.status, 'pending');
    assert.equal(reset.nextRunAt, null);
    assert.ok(reset.version > failed.version);
    assert.equal((await database.db.select().from(auditEvents).where(eq(auditEvents.targetId, failed.id))).filter((row) => row.action === 'job_retried').length, 1);
    let processCalls = 0;
    worker = await startCompanionWorker({ database, databaseUrl, boss, queuePrefix, outboxOperationKeys: [processKey], dispatchIntervalMs: 25, processor: async () => { processCalls += 1; return { text: 'persisted after retry' }; } });
    await waitFor(async () => (await database.db.select().from(turns).where(eq(turns.id, own!.turnId)))[0]?.status === 'generated', 'generated');
    await worker.stop(); worker = undefined;
    assert.equal(processCalls, 1);
    const [delivery] = await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.turnId, own.turnId));
    assert.equal(delivery.status, 'pending');
    let senderCalls = 0;
    worker = await startCompanionWorker({ database, databaseUrl, boss, queuePrefix, outboxOperationKeys: [deliveryKey], dispatchIntervalMs: 25, sender: async () => { senderCalls += 1; return { kind: 'receipt', receipt: 'synthetic-receipt' }; } });
    await waitFor(async () => (await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, delivery.id)))[0]?.status === 'sent', 'sent');
    assert.equal(senderCalls, 1);
    const [deliveryLog] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, deliveryKey));
    assert.equal((await app.inject({ method: 'POST', url: `/admin/job-logs/${deliveryLog.id}/retry`, headers, payload: {} })).statusCode, 409);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await worker?.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await app?.close(); } catch (error) { if (!primaryError) primaryError = error; }
    try { if (own) await cleanup(database, boss, own, queuePrefix, operationKeys, jobIds); } catch (error) { if (!primaryError) primaryError = error; }
    try { await boss.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await database.close(); } catch (error) { if (!primaryError) primaryError = error; }
    if (primaryError) throw primaryError;
  }
});

test('successful queue send with failed finalize can be dispatched again with one business action', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const queuePrefix = `f3bcrash_${uuid().replaceAll('-', '')}`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  let own: Awaited<ReturnType<typeof fixture>> | undefined;
  let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
  const jobIds: string[] = [];
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    await boss.start();
    own = await fixture(database, 'f3b-crash');
    const operationKey = `turn:${own.turnId}:process`;
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId: own.turnId } });
    const originalSend = boss.send.bind(boss);
    let sends = 0;
    boss.send = (async (...args: Parameters<PgBoss['send']>) => {
      const id = await (originalSend as (...parameters: unknown[]) => Promise<string | null>)(...args);
      if (id) jobIds.push(id);
      sends += 1;
      if (sends === 1) await new Promise((resolve) => setTimeout(resolve, 160));
      return id;
    }) as PgBoss['send'];
    const dispatcher = new OutboxDispatcher(database, boss, { leaseMs: 100, queuePrefix, operationKeys: [operationKey] });
    assert.equal(await dispatcher.dispatchBatch(), 1);
    const [afterFirst] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    assert.equal(afterFirst.status, 'leased');
    assert.equal((await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey))).length, 0);
    assert.equal(await dispatcher.dispatchBatch(), 1);
    assert.equal(jobIds.length, 2);
    let processorCalls = 0;
    worker = await startCompanionWorker({ database, databaseUrl, boss, queuePrefix, outboxOperationKeys: [operationKey], dispatchIntervalMs: 25, processor: async () => { processorCalls += 1; return { text: 'single persisted generation' }; } });
    await waitFor(async () => (await database.db.select().from(turns).where(eq(turns.id, own!.turnId)))[0]?.status === 'generated', 'crash_window_generation');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(processorCalls, 1);
    assert.equal((await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.turnId, own.turnId))).length, 1);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await worker?.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { if (own) await cleanup(database, boss, own, queuePrefix, [`turn:${own.turnId}:process`, `turn:${own.turnId}:deliver`], jobIds); } catch (error) { if (!primaryError) primaryError = error; }
    try { await boss.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await database.close(); } catch (error) { if (!primaryError) primaryError = error; }
    if (primaryError) throw primaryError;
  }
});

test('expired sending is recovered on startup and is never delivered automatically', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const queuePrefix = `f3bunknown_${uuid().replaceAll('-', '')}`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  let own: Awaited<ReturnType<typeof fixture>> | undefined;
  let ownPeriodic: Awaited<ReturnType<typeof fixture>> | undefined;
  let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    own = await fixture(database, 'f3b-unknown');
    const turnService = new TurnService(database);
    const token = await turnService.claim(own.turnId, 'recovery-test', 1_000);
    assert.ok(token);
    const generated = await turnService.persistGenerated(token, { text: 'saved content' });
    const expiredClock = new Date(Date.now() - 5_000);
    const deliveryService = new DeliveryService(database, { now: () => expiredClock });
    assert.ok(await deliveryService.claimPending(generated.deliveryId, 'crashed-sender', 100));
    let senderCalls = 0;
    worker = await startCompanionWorker({ database, databaseUrl, boss, queuePrefix, outboxOperationKeys: [`turn:${own.turnId}:deliver`], dispatchIntervalMs: 25, sender: async () => { senderCalls += 1; return { kind: 'receipt', receipt: 'must-not-send' }; } });
    const [delivery] = await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, generated.deliveryId));
    assert.equal(delivery.status, 'receipt_unknown');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(senderCalls, 0);
    ownPeriodic = await fixture(database, 'f3b-periodic-unknown');
    const periodicToken = await turnService.claim(ownPeriodic.turnId, 'periodic-recovery-test', 1_000);
    assert.ok(periodicToken);
    const periodicGenerated = await turnService.persistGenerated(periodicToken, { text: 'saved periodic content' });
    assert.ok(await deliveryService.claimPending(periodicGenerated.deliveryId, 'periodic-crashed-sender', 100));
    await waitFor(async () => (await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, periodicGenerated.deliveryId)))[0]?.status === 'receipt_unknown', 'periodic_unknown');
    assert.equal(senderCalls, 0);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await worker?.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { if (own) {
      const key = `turn:${own.turnId}:deliver`;
      const logs = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, key));
      await cleanup(database, boss, own, queuePrefix, [key], logs.flatMap((row) => row.pgBossId ? [row.pgBossId] : []));
    } } catch (error) { if (!primaryError) primaryError = error; }
    try { if (ownPeriodic) await cleanup(database, boss, ownPeriodic, queuePrefix, [`turn:${ownPeriodic.turnId}:deliver`], []); } catch (error) { if (!primaryError) primaryError = error; }
    try { await boss.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await database.close(); } catch (error) { if (!primaryError) primaryError = error; }
    if (primaryError) throw primaryError;
  }
});

test('admin retry takes outbox before job log so dispatcher finalize cannot deadlock it', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const queuePrefix = `f3block_${uuid().replaceAll('-', '')}`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  let own: Awaited<ReturnType<typeof fixture>> | undefined;
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  const holder = await database.pool.connect();
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    own = await fixture(database, 'f3b-lock-dispatch');
    const operationKey = `turn:${own.turnId}:process`;
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId: own.turnId } });
    const [log] = await database.db.insert(jobLogs).values({ operationKey, queueName: `${queuePrefix}.process`, status: 'failed', attempts: 1, errorCode: 'processor_unavailable' }).returning();
    app = await createAdminApplication({ database, adminToken });
    await holder.query('begin');
    await holder.query('select id from companion.business_outbox where operation_key = $1 for update', [operationKey]);
    const holderPid = Number((await holder.query('select pg_backend_pid() as pid')).rows[0]?.pid);
    const retryPromise = app.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
    await waitFor(async () => {
      const result = await database.pool.query("select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))", [holderPid]);
      return Number(result.rows[0]?.count) > 0;
    }, 'retry_waits_for_dispatch_outbox');
    // Dispatcher finalize holds outbox first, then upserts this same job log.
    await holder.query('update companion.job_logs set updated_at = clock_timestamp() where operation_key = $1', [operationKey]);
    await holder.query('commit');
    const response = await retryPromise;
    assert.ok(response.statusCode === 201 || response.statusCode === 409, response.body);
    assert.notEqual(response.statusCode, 500, response.body);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await holder.query('rollback'); } catch (error) { if (!primaryError) primaryError = error; }
    holder.release();
    try { await app?.close(); } catch (error) { if (!primaryError) primaryError = error; }
    try { if (own) await cleanup(database, boss, own, queuePrefix, [`turn:${own.turnId}:process`], []); } catch (error) { if (!primaryError) primaryError = error; }
    try { await boss.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await database.close(); } catch (error) { if (!primaryError) primaryError = error; }
    if (primaryError) throw primaryError;
  }
});

test('process retry takes delivery before turn so delivery completion cannot deadlock it', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const queuePrefix = `f3bturnlock_${uuid().replaceAll('-', '')}`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  let own: Awaited<ReturnType<typeof fixture>> | undefined;
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  const holder = await database.pool.connect();
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    own = await fixture(database, 'f3b-lock-delivery');
    const operationKey = `turn:${own.turnId}:process`;
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId: own.turnId } });
    const [log] = await database.db.insert(jobLogs).values({ operationKey, queueName: `${queuePrefix}.process`, status: 'failed', attempts: 1, errorCode: 'processor_unavailable' }).returning();
    const [delivery] = await database.db.insert(deliveryOutbox).values({ turnId: own.turnId, conversationId: own.conversationId, operationKey: `turn:${own.turnId}:deliver`, content: { text: 'already generated' }, status: 'sending', leaseOwner: 'delivery-finish-test', leaseExpiresAt: new Date(Date.now() + 30_000) }).returning();
    assert.ok(delivery);
    await database.db.update(turns).set({ status: 'failed' }).where(eq(turns.id, own.turnId));
    app = await createAdminApplication({ database, adminToken });
    await holder.query('begin');
    await holder.query('select id from companion.delivery_outbox where id = $1 for update', [delivery.id]);
    const holderPid = Number((await holder.query('select pg_backend_pid() as pid')).rows[0]?.pid);
    const retryPromise = app.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
    await waitFor(async () => {
      const result = await database.pool.query("select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))", [holderPid]);
      return Number(result.rows[0]?.count) > 0;
    }, 'retry_waits_for_delivery');
    // DeliveryService.finish owns delivery first, then updates the turn.
    await holder.query("update companion.turns set status = 'sent', updated_at = clock_timestamp() where id = $1", [own.turnId]);
    await holder.query('commit');
    const response = await retryPromise;
    assert.equal(response.statusCode, 409, response.body);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await holder.query('rollback'); } catch (error) { if (!primaryError) primaryError = error; }
    holder.release();
    try { await app?.close(); } catch (error) { if (!primaryError) primaryError = error; }
    try { if (own) await cleanup(database, boss, own, queuePrefix, [`turn:${own.turnId}:process`, `turn:${own.turnId}:deliver`], []); } catch (error) { if (!primaryError) primaryError = error; }
    try { await boss.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await database.close(); } catch (error) { if (!primaryError) primaryError = error; }
    if (primaryError) throw primaryError;
  }
});

test('delivery retry does not deadlock with a reconcile holding delivery before outbox', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const queuePrefix = `f3breconcilelock_${uuid().replaceAll('-', '')}`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  let own: Awaited<ReturnType<typeof fixture>> | undefined;
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  const holder = await database.pool.connect();
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl, queuePrefix);
    own = await fixture(database, 'f3b-reconcile-lock');
    const operationKey = `turn:${own.turnId}:deliver`;
    const [delivery] = await database.db.insert(deliveryOutbox).values({ turnId: own.turnId, conversationId: own.conversationId, operationKey, content: { text: 'uncertain send' }, status: 'receipt_unknown', errorCode: 'receipt_unknown' }).returning();
    assert.ok(delivery);
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'deliver_message', payload: { turnId: own.turnId, deliveryId: delivery.id } });
    const [log] = await database.db.insert(jobLogs).values({ operationKey, queueName: `${queuePrefix}.deliver`, status: 'completed', attempts: 1 }).returning();
    assert.ok(log);
    app = await createAdminApplication({ database, adminToken });
    await holder.query('begin');
    await holder.query('select id from companion.delivery_outbox where id = $1 for update', [delivery.id]);
    const holderPid = Number((await holder.query('select pg_backend_pid() as pid')).rows[0]?.pid);
    const retryPromise = app.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
    await waitFor(async () => {
      const result = await database.pool.query("select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))", [holderPid]);
      return Number(result.rows[0]?.count) > 0;
    }, 'retry_waits_for_reconcile_delivery');
    // Reconcile owns delivery first and then updates its business outbox/job log.
    await holder.query("update companion.delivery_outbox set status = 'sent', platform_receipt = 'test-receipt', error_code = null where id = $1", [delivery.id]);
    await holder.query("update companion.turns set status = 'sent', updated_at = clock_timestamp() where id = $1", [own.turnId]);
    await holder.query("update companion.business_outbox set status = 'dispatched', updated_at = clock_timestamp() where operation_key = $1", [operationKey]);
    await holder.query("update companion.job_logs set status = 'completed', updated_at = clock_timestamp() where operation_key = $1", [operationKey]);
    await holder.query('commit');
    const response = await retryPromise;
    assert.equal(response.statusCode, 409, response.body);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await holder.query('rollback'); } catch (error) { if (!primaryError) primaryError = error; }
    holder.release();
    try { await app?.close(); } catch (error) { if (!primaryError) primaryError = error; }
    try { if (own) await cleanup(database, boss, own, queuePrefix, [`turn:${own.turnId}:deliver`], []); } catch (error) { if (!primaryError) primaryError = error; }
    try { await boss.stop(); } catch (error) { if (!primaryError) primaryError = error; }
    try { await database.close(); } catch (error) { if (!primaryError) primaryError = error; }
    if (primaryError) throw primaryError;
  }
});
