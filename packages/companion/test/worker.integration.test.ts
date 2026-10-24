import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { createAdminApplication } from '../src/admin/app.js';
import { TurnService } from '../src/transactions/turn-service.js';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { auditEvents, businessOutbox, characters, conversations, deliveryOutbox, jobLogs, messages, people, turns } from '../src/database/schema/index.js';
import { OutboxDispatcher } from '../src/worker/outbox-dispatcher.js';
import { initializeWorkerQueueSchema, startCompanionWorker } from '../src/worker/worker-service.js';
import { JobAttemptService, type JobAttemptToken } from '../src/worker/job-attempt-service.js';
import { requireWorkerDatabaseUrl, uuid } from './helpers.js';

const adminToken = 'f3b-worker-admin-token-with-at-least-32-bytes';

test('real pg-boss persists work across reconnect and processing produces recoverable pending delivery once', async () => {
  const database = createDatabase(requireWorkerDatabaseUrl());
  const bossOptions = { connectionString: requireWorkerDatabaseUrl(), schema: 'companion_jobs', migrate: false, createSchema: false };
  const boss = new PgBoss(bossOptions);
  const characterId = uuid();
  const personId = uuid();
  const ids: string[] = [];
  const operationKeys: string[] = [];
  const queueJobIds: string[] = [];
  let recoveredBoss: PgBoss | undefined;
  let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
  let releaseProcessor: () => void = () => {};
  let bossWasStopped = false;
  let primaryError: unknown;
  let processorStarted!: () => void;
  const processorReady = new Promise<void>((resolve) => { processorStarted = resolve; });
  const processorGate = new Promise<void>((resolve) => { releaseProcessor = resolve; });
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(requireWorkerDatabaseUrl());
    await boss.start();
    await boss.createQueue('companion.process');
    const [character] = await database.db.insert(characters).values({ id: characterId, name: `f3b-${characterId}` }).returning();
    ids.push(character.id);
    const [person] = await database.db.insert(people).values({ id: personId, displayName: 'f3b test' }).returning();
    ids.push(person.id);
    const [conversation] = await database.db.insert(conversations).values({ characterId, platform: 'qq', platformConversationId: `f3b-${uuid()}`, kind: 'private' }).returning();
    ids.push(conversation.id);
    const [message] = await database.db.insert(messages).values({ conversationId: conversation.id, personId, platform: 'qq', platformEventId: `f3b-${uuid()}`, role: 'user', text: 'synthetic' }).returning();
    ids.push(message.id);
    const [turn] = await database.db.insert(turns).values({ conversationId: conversation.id, personId, inboundMessageId: message.id, graphThreadId: uuid(), status: 'received' }).returning();
    ids.push(turn.id);
    const operationKey = `turn:${turn.id}:process`;
    operationKeys.push(operationKey);
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId: turn.id } });
    const dispatcher = new OutboxDispatcher(database, boss, { operationKeys: [operationKey] });
    assert.equal(await dispatcher.dispatchBatch(), 1);
    assert.equal(await dispatcher.dispatchBatch(), 0);
    const [outbox] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    assert.equal(outbox.status, 'dispatched', JSON.stringify(outbox));
    await boss.stop();
    bossWasStopped = true;
    recoveredBoss = new PgBoss(bossOptions);
    const processorCalls: string[] = [];
    worker = await startCompanionWorker({
      database,
      databaseUrl: requireWorkerDatabaseUrl(),
      boss: recoveredBoss,
      processor: async ({ turnId }) => {
        processorCalls.push(turnId);
        processorStarted();
        await processorGate;
        return { text: 'synthetic generated output' };
      },
      dispatchIntervalMs: 25,
      outboxOperationKeys: [operationKey, `turn:${turn.id}:deliver`],
    });
    await Promise.race([
      processorReady,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('worker_processor_start_timeout')), 5_000)),
    ]);
    const [runningLog] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
    assert.equal(runningLog.status, 'running');
    assert.ok(runningLog.leaseOwner);
    assert.ok(runningLog.leaseExpiresAt);
    const staleToken: JobAttemptToken = {
      operationKey,
      bossId: runningLog.pgBossId!,
      owner: runningLog.leaseOwner!,
      version: runningLog.version,
      expiresAt: runningLog.leaseExpiresAt!,
    };
    releaseProcessor();
    const deadline = Date.now() + 5_000;
    let generated = false;
    while (Date.now() < deadline) {
      const [row] = await database.db.select().from(turns).where(eq(turns.id, turn.id));
      const [currentLog] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
      if (row?.status === 'generated' && currentLog?.status === 'completed') { generated = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(generated, true);
    const [delivery] = await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.turnId, turn.id));
    assert.equal(delivery?.status, 'pending');
    operationKeys.push(`turn:${turn.id}:deliver`);
    assert.deepEqual(processorCalls, [turn.id]);
    const [processLog] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
    assert.equal(processLog.status, 'completed');
    assert.ok(processLog.attempts >= 1);
    const completedAttempt = processLog;
    await assert.rejects(new JobAttemptService(database).fail(staleToken, 'late_failure'), /attempt_lost/);
    const [afterLateFailure] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
    assert.deepEqual(afterLateFailure, completedAttempt);
    await worker.dispatcher.dispatchBatch();
    const [deliveryOutboxRow] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, `turn:${turn.id}:deliver`));
    assert.ok(deliveryOutboxRow);
    assert.ok(['pending', 'leased', 'dispatched'].includes(deliveryOutboxRow.status));
    const [processOutboxAfterDeliveryDispatch] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    assert.equal(processOutboxAfterDeliveryDispatch.status, 'dispatched');
    assert.equal(processOutboxAfterDeliveryDispatch.attempts, 1);
    const duplicateJobId = await recoveredBoss.send('companion.process', { operationKey, outboxId: outbox.id, kind: 'process_turn', payload: { turnId: turn.id } });
    if (duplicateJobId) queueJobIds.push(duplicateJobId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(processorCalls, [turn.id]);
    await worker.stop();
    worker = undefined;
    await recoveredBoss.stop();
    recoveredBoss = undefined;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    releaseProcessor();
    try { await worker?.stop(); } catch (error) { if (!primaryError) throw error; }
    try { await recoveredBoss?.stop(); } catch (error) { if (!primaryError) throw error; }
    try {
      if (!bossWasStopped) await boss.stop();
    } catch (error) {
      if (!primaryError) throw error;
    }
    try {
      const logs = await database.db.select().from(jobLogs);
      const ours = logs.filter((log) => operationKeys.includes(log.operationKey) && log.pgBossId);
      if (ours.length || queueJobIds.length) {
        if (bossWasStopped) await boss.start();
        for (const log of ours) await boss.deleteJob(log.queueName, log.pgBossId!);
        for (const id of queueJobIds) await boss.deleteJob('companion.process', id);
        await boss.stop();
      }
      for (const operationKey of operationKeys) {
        await database.db.delete(auditEvents).where(eq(auditEvents.targetId, operationKey));
        await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, operationKey));
        await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
      }
      if (ids[4]) {
        await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.turnId, ids[4]!));
        await database.db.delete(turns).where(eq(turns.id, ids[4]!));
      }
      if (ids[2]) await database.db.delete(messages).where(eq(messages.conversationId, ids[2]!));
      if (ids[2]) await database.db.delete(conversations).where(eq(conversations.id, ids[2]!));
      if (ids[1]) await database.db.delete(people).where(eq(people.id, ids[1]!));
      if (ids[0]) await database.db.delete(characters).where(eq(characters.id, ids[0]!));
    } finally {
      await database.close();
    }
  }
});

test('admin HTTP retry audits failed processing and refuses malformed or unauthorized retries', async () => {
  const database = createDatabase(requireWorkerDatabaseUrl());
  const characterId = uuid();
  const personId = uuid();
  let operationKey = '';
  const created: { character?: string; person?: string; conversation?: string; turn?: string; log?: string } = {};
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const [character] = await database.db.insert(characters).values({ id: characterId, name: `f3b-retry-${characterId}` }).returning();
    created.character = character.id;
    const [person] = await database.db.insert(people).values({ id: personId, displayName: 'f3b retry' }).returning();
    created.person = person.id;
    const [conversation] = await database.db.insert(conversations).values({ characterId, platform: 'qq', platformConversationId: `retry-${uuid()}`, kind: 'private' }).returning();
    created.conversation = conversation.id;
    const [message] = await database.db.insert(messages).values({ conversationId: conversation.id, personId, platform: 'qq', platformEventId: `retry-${uuid()}`, role: 'user', text: 'synthetic' }).returning();
    const [turn] = await database.db.insert(turns).values({ conversationId: conversation.id, personId, inboundMessageId: message.id, graphThreadId: uuid(), status: 'failed', errorCode: 'processor_failed' }).returning();
    created.turn = turn.id;
    operationKey = `turn:${turn.id}:process`;
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId: turn.id }, status: 'dispatched' });
    const [log] = await database.db.insert(jobLogs).values({ operationKey, queueName: 'companion.process', status: 'failed', attempts: 1, errorCode: 'job_attempt_failed' }).returning();
    created.log = log.id;
    app = await createAdminApplication({ database, adminToken });
    const denied = await app.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, payload: {} });
    assert.equal(denied.statusCode, 401);
    const headers = { authorization: `Bearer ${adminToken}` };
    const malformed = await app.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, headers, payload: { force: true } });
    assert.equal(malformed.statusCode, 400);
    const retried = await app.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, headers, payload: {} });
    assert.equal(retried.statusCode, 201);
    const [updatedTurn] = await database.db.select().from(turns).where(eq(turns.id, turn.id));
    const [updatedOutbox] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    const [updatedLog] = await database.db.select().from(jobLogs).where(eq(jobLogs.id, log.id));
    assert.equal(updatedTurn.status, 'received');
    assert.equal(updatedOutbox.status, 'pending');
    assert.equal(updatedLog.status, 'pending');
    assert.equal((await database.db.select().from(auditEvents).where(eq(auditEvents.targetId, log.id))).length, 1);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { await app?.close(); } catch (error) { cleanupError = error; }
    try {
      if (created.log) await database.db.delete(auditEvents).where(eq(auditEvents.targetId, created.log));
      await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, operationKey));
      await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
      if (created.turn) await database.db.delete(turns).where(eq(turns.id, created.turn));
      if (created.conversation) await database.db.delete(messages).where(eq(messages.conversationId, created.conversation));
      if (created.conversation) await database.db.delete(conversations).where(eq(conversations.id, created.conversation));
      if (created.person) await database.db.delete(people).where(eq(people.id, created.person));
      if (created.character) await database.db.delete(characters).where(eq(characters.id, created.character));
    } catch (error) { cleanupError ??= error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('expired dispatcher lease is taken over and the stale owner cannot finalize after queue send', async () => {
  const database = createDatabase(requireWorkerDatabaseUrl());
  const boss = new PgBoss({ connectionString: requireWorkerDatabaseUrl(), schema: 'companion_jobs', migrate: false, createSchema: false });
  const operationKey = `f3b-lease:${uuid()}`;
  const queueJobIds: string[] = [];
  let primaryError: unknown;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstSendStarted!: () => void;
  let secondSendStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>((resolve) => { firstSendStarted = resolve; });
  const secondStarted = new Promise<void>((resolve) => { secondSendStarted = resolve; });
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(requireWorkerDatabaseUrl());
    await boss.start();
    await boss.createQueue('companion.process');
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId: uuid() } });
    const originalSend = boss.send.bind(boss);
    let sendCalls = 0;
    boss.send = (async (...args: Parameters<PgBoss['send']>) => {
      sendCalls += 1;
      if (sendCalls === 1) {
        firstSendStarted();
        await firstGate;
      } else if (sendCalls === 2) {
        secondSendStarted();
        await secondGate;
      }
      const id = await (originalSend as (...parameters: unknown[]) => Promise<string | null>)(...args);
      if (id) queueJobIds.push(id);
      return id;
    }) as PgBoss['send'];
    const baseTime = new Date();
    let dispatcherNow = baseTime;
    const firstDispatcher = new OutboxDispatcher(database, boss, { leaseMs: 100, now: () => dispatcherNow, operationKeys: [operationKey] });
    const firstDispatch = firstDispatcher.dispatchBatch();
    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 150));
    dispatcherNow = new Date(baseTime.getTime() + 200);
    const secondDispatch = firstDispatcher.dispatchBatch();
    await secondStarted;
    releaseFirst();
    assert.equal(await firstDispatch, 1);
    const [takenOver] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    assert.equal(takenOver.status, 'leased');
    assert.equal(takenOver.attempts, 2);
    releaseSecond();
    assert.equal(await secondDispatch, 1);
    const [final] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    assert.equal(final.status, 'dispatched');
    assert.equal((await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey))).length, 1);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    releaseFirst();
    releaseSecond();
    let cleanupError: unknown;
    try {
      for (const id of queueJobIds) await boss.deleteJob('companion.process', id);
      await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, operationKey));
      await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    } catch (error) { cleanupError = error; }
    try { await boss.stop(); } catch (error) { cleanupError ??= error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

async function verifyDispatcherFinalizeWaitsForLeaseExpiry(sendFails: boolean): Promise<void> {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  const operationKey = `f3b-finalize-lock:${uuid()}`;
  let pgBossId: string | undefined;
  let blocker: import('pg').PoolClient | undefined;
  let lockedRow!: () => void;
  const locked = new Promise<void>((resolve) => { lockedRow = resolve; });
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl);
    await boss.start();
    await boss.createQueue('companion.process');
    const [outbox] = await database.db.insert(businessOutbox).values({
      operationKey,
      kind: 'process_turn',
      payload: { turnId: uuid() },
    }).returning();

    const originalSend = boss.send.bind(boss);
    boss.send = (async (...args: Parameters<PgBoss['send']>) => {
      if (!sendFails) {
        pgBossId = await (originalSend as (...parameters: unknown[]) => Promise<string | null>)(...args) ?? undefined;
      }
      const lockClient = await database.pool.connect();
      blocker = lockClient;
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT id FROM companion.business_outbox WHERE id = $1 FOR UPDATE', [outbox.id]);
      lockedRow();
      if (sendFails) throw new Error('synthetic_send_failure');
      return pgBossId ?? null;
    }) as PgBoss['send'];

    const dispatcher = new OutboxDispatcher(database, boss, { leaseMs: 150, operationKeys: [operationKey] });
    const dispatch = dispatcher.dispatchBatch();
    await locked;
    let waiting = false;
    let waitDiagnostics: unknown;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const result = await database.pool.query<{ waiting: boolean; activity: unknown }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting, (SELECT json_agg(json_build_object('wait', wait_event_type, 'query', query)) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS activity`,
      );
      waitDiagnostics = result.rows[0]?.activity;
      if (result.rows[0]?.waiting) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, `dispatcher finalize should wait for the outbox row lock: ${JSON.stringify(waitDiagnostics)}`);
    const [claimed] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.id, outbox.id));
    assert.ok(claimed.leaseExpiresAt);
    const remaining = claimed.leaseExpiresAt!.getTime() - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 30));
    const activeBlocker = blocker;
    assert.ok(activeBlocker);
    await activeBlocker.query('ROLLBACK');
    activeBlocker.release();
    blocker = undefined;
    await dispatch;

    const [final] = await database.db.select().from(businessOutbox).where(eq(businessOutbox.id, outbox.id));
    const logs = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
    assert.equal(final.status, 'leased');
    assert.equal(logs.length, 0);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); } } catch { /* preserve primary error */ }
    let cleanupError: unknown;
    try {
      if (pgBossId) await boss.deleteJob('companion.process', pgBossId);
      await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, operationKey));
      await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
    } catch (error) { cleanupError = error; }
    try { await boss.stop(); } catch (error) { cleanupError ??= error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
}

test('dispatcher success finalize waits for the row lock and refuses an expired lease', async () => {
  await verifyDispatcherFinalizeWaitsForLeaseExpiry(false);
});

test('dispatcher failure finalize waits for the row lock and refuses an expired lease', async () => {
  await verifyDispatcherFinalizeWaitsForLeaseExpiry(true);
});

test('sender success, unknown, and definite failure follow distinct states; only audited not-sent retry resends the saved delivery', async () => {
  const database = createDatabase(requireWorkerDatabaseUrl());
  const databaseUrl = requireWorkerDatabaseUrl();
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  const characterId = uuid();
  const personId = uuid();
  const createdTurnIds: string[] = [];
  const operationKeys: string[] = [];
  const queueJobIds: string[] = [];
  let conversationId: string | undefined;
  let adminApp: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl);
    await database.db.insert(characters).values({ id: characterId, name: `f3b-delivery-${characterId}` });
    await database.db.insert(people).values({ id: personId, displayName: 'f3b delivery test' });
    const [conversation] = await database.db.insert(conversations).values({ characterId, platform: 'qq', platformConversationId: `delivery-${uuid()}`, kind: 'private' }).returning();
    conversationId = conversation.id;
    const turnService = new TurnService(database);
    const deliveryIds = new Map<string, string>();
    for (const label of ['sent', 'unknown', 'not-sent']) {
      const [message] = await database.db.insert(messages).values({ conversationId: conversation.id, personId, platform: 'qq', platformEventId: `delivery-${label}-${uuid()}`, role: 'user', text: 'synthetic' }).returning();
      const [turn] = await database.db.insert(turns).values({ conversationId: conversation.id, personId, inboundMessageId: message.id, graphThreadId: uuid(), status: 'received' }).returning();
      createdTurnIds.push(turn.id);
      const lease = await turnService.claim(turn.id, `f3b-delivery-${label}`, 10_000);
      assert.ok(lease);
      const generated = await turnService.persistGenerated(lease, { text: `saved ${label} content` });
      deliveryIds.set(label, generated.deliveryId);
      operationKeys.push(`turn:${turn.id}:deliver`);
    }
    const originalSend = boss.send.bind(boss);
    boss.send = (async (...args: Parameters<PgBoss['send']>) => {
      const id = await (originalSend as (...parameters: unknown[]) => Promise<string | null>)(...args);
      if (id) queueJobIds.push(id);
      return id;
    }) as PgBoss['send'];
    const calls = new Map<string, number>();
    worker = await startCompanionWorker({
      database,
      databaseUrl,
      boss,
      dispatchIntervalMs: 25,
      outboxOperationKeys: operationKeys,
      sender: async ({ deliveryId }) => {
        const attempt = (calls.get(deliveryId) ?? 0) + 1;
        calls.set(deliveryId, attempt);
        if (deliveryId === deliveryIds.get('sent')) return { kind: 'receipt', receipt: 'synthetic-receipt' };
        if (deliveryId === deliveryIds.get('unknown')) return { kind: 'unknown', errorCode: 'synthetic_unknown' };
        return attempt === 1 ? { kind: 'not_sent', errorCode: 'synthetic_not_sent' } : { kind: 'receipt', receipt: 'synthetic-retry-receipt' };
      },
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await database.db.select().from(deliveryOutbox);
      const byId = new Map(rows.map((row) => [row.id, row.status]));
      const ownLogs = await database.db.select().from(jobLogs);
      const terminalLogs = [...deliveryIds.values()].every((_, index) => {
        const log = ownLogs.find((item) => item.operationKey === `turn:${createdTurnIds[index]}:deliver`);
        return log?.status === 'completed' || log?.status === 'failed';
      });
      if (terminalLogs && [...deliveryIds.values()].every((id) => ['sent', 'receipt_unknown', 'failed'].includes(byId.get(id) ?? ''))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const sentId = deliveryIds.get('sent')!;
    const unknownId = deliveryIds.get('unknown')!;
    const failedId = deliveryIds.get('not-sent')!;
    const readDelivery = async (id: string) => (await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, id)))[0]!;
    assert.equal((await readDelivery(sentId)).status, 'sent');
    assert.equal((await readDelivery(unknownId)).status, 'receipt_unknown');
    assert.equal((await readDelivery(failedId)).status, 'failed');
    const logs = await database.db.select().from(jobLogs);
    const logFor = (id: string) => logs.find((row) => row.operationKey === `turn:${createdTurnIds[[...deliveryIds.values()].indexOf(id)]}:deliver`)!;
    const sentLog = logFor(sentId);
    const unknownLog = logFor(unknownId);
    const failedLog = logFor(failedId);
    assert.equal(sentLog.status, 'completed');
    assert.equal(unknownLog.status, 'completed');
    assert.equal(failedLog.status, 'failed');
    adminApp = await createAdminApplication({ database, adminToken });
    const headers = { authorization: `Bearer ${adminToken}` };
    for (const log of [sentLog, unknownLog]) {
      const retryConflictResponse: { statusCode: number } = await adminApp.inject({ method: 'POST', url: `/admin/job-logs/${log.id}/retry`, headers, payload: {} });
      assert.equal(retryConflictResponse.statusCode, 409);
    }
    const retried = await adminApp.inject({ method: 'POST', url: `/admin/job-logs/${failedLog.id}/retry`, headers, payload: {} });
    assert.equal(retried.statusCode, 201);
    const deadlineAfterRetry = Date.now() + 5_000;
    const failedOperationKey = `turn:${createdTurnIds[[...deliveryIds.values()].indexOf(failedId)]}:deliver`;
    while (Date.now() < deadlineAfterRetry) {
      const [retryLog] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, failedOperationKey));
      if ((await readDelivery(failedId)).status === 'sent' && retryLog?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await readDelivery(failedId)).status, 'sent');
    assert.equal(calls.get(failedId), 2);
    for (const turnId of createdTurnIds) {
      const [generatedMessage] = await database.db.select().from(messages).where(eq(messages.platformEventId, `generated:${turnId}`));
      assert.ok(generatedMessage);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { await worker?.stop(); } catch (error) { cleanupError = error; }
    try { await adminApp?.close(); } catch (error) { cleanupError ??= error; }
    try {
      const ownLogs = await database.db.select().from(jobLogs);
      for (const log of ownLogs.filter((row) => operationKeys.includes(row.operationKey))) {
        if (log.pgBossId) queueJobIds.push(log.pgBossId);
        await database.db.delete(auditEvents).where(eq(auditEvents.targetId, log.id));
      }
      for (const id of new Set(queueJobIds)) await boss.deleteJob('companion.deliver', id);
      if (operationKeys.length) {
        await database.db.delete(jobLogs).where(inArray(jobLogs.operationKey, operationKeys));
        await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, operationKeys));
      }
      if (createdTurnIds.length) {
        await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId, createdTurnIds));
        await database.db.delete(turns).where(inArray(turns.id, createdTurnIds));
      }
      if (conversationId) await database.db.delete(messages).where(eq(messages.conversationId, conversationId));
      if (conversationId) await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      await database.db.delete(people).where(eq(people.id, personId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError ??= error; }
    try { await boss.stop(); } catch (error) { cleanupError ??= error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('processor exceptions with sensitive text are sanitized before pg-boss persistence and admin display', async () => {
  const databaseUrl = requireWorkerDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'companion_jobs', migrate: false, createSchema: false });
  const characterId = uuid();
  const personId = uuid();
  let operationKey = '';
  const secretSentinel = 'synthetic-secret-message-must-not-persist';
  let conversationId: string | undefined;
  let turnId: string | undefined;
  let logId: string | undefined;
  let pgBossId: string | undefined;
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let worker: Awaited<ReturnType<typeof startCompanionWorker>> | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await initializeWorkerQueueSchema(databaseUrl);
    const [character] = await database.db.insert(characters).values({ id: characterId, name: `f3b-secret-${characterId}` }).returning();
    const [person] = await database.db.insert(people).values({ id: personId, displayName: 'f3b secret' }).returning();
    const [conversation] = await database.db.insert(conversations).values({ characterId: character.id, platform: 'qq', platformConversationId: `secret-${uuid()}`, kind: 'private' }).returning();
    conversationId = conversation.id;
    const [message] = await database.db.insert(messages).values({ conversationId, personId: person.id, platform: 'qq', platformEventId: `secret-${uuid()}`, role: 'user', text: 'synthetic only' }).returning();
    const [turn] = await database.db.insert(turns).values({ conversationId, personId: person.id, inboundMessageId: message.id, graphThreadId: uuid(), status: 'received' }).returning();
    turnId = turn.id;
    operationKey = `turn:${turn.id}:process`;
    await database.db.insert(businessOutbox).values({ operationKey, kind: 'process_turn', payload: { turnId } });
    worker = await startCompanionWorker({
      database,
      databaseUrl,
      boss,
      processor: async () => { throw new Error(secretSentinel); },
      dispatchIntervalMs: 25,
      outboxOperationKeys: [operationKey],
    });
    await worker.dispatcher.dispatchBatch();
    const deadline = Date.now() + 5_000;
    let log: typeof jobLogs.$inferSelect | undefined;
    while (Date.now() < deadline) {
      [log] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
      if (log?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(log?.status, 'failed', JSON.stringify({ log, job: log?.pgBossId ? await boss.getJobById('companion.process', log.pgBossId) : null }));
    assert.equal(log?.errorCode, 'job_attempt_failed');
    assert.ok(log?.pgBossId);
    logId = log!.id;
    pgBossId = log!.pgBossId ?? undefined;
    const storedJob = await boss.getJobById('companion.process', pgBossId!);
    assert.equal(JSON.stringify(storedJob).includes(secretSentinel), false);
    app = await createAdminApplication({ database, adminToken });
    const response = await app.inject({ method: 'GET', url: `/admin/job-logs/${logId}`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes(secretSentinel), false);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { await worker?.stop(); } catch (error) { cleanupError = error; }
    try { await app?.close(); } catch (error) { cleanupError ??= error; }
    try {
      for (const job of await boss.findJobs('companion.process', { data: { operationKey } })) await boss.deleteJob('companion.process', job.id);
      if (pgBossId) await boss.deleteJob('companion.process', pgBossId);
      if (logId) await database.db.delete(auditEvents).where(eq(auditEvents.targetId, logId));
      await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, operationKey));
      await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, operationKey));
      if (turnId) await database.db.delete(turns).where(eq(turns.id, turnId));
      if (conversationId) await database.db.delete(messages).where(eq(messages.conversationId, conversationId));
      if (conversationId) await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      await database.db.delete(people).where(eq(people.id, personId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError ??= error; }
    try { await boss.stop(); } catch (error) { cleanupError ??= error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});
