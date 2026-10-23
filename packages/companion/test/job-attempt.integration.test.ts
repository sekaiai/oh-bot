import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { jobLogs } from '../src/database/schema/index.js';
import { JobAttemptService, type JobAttemptToken } from '../src/worker/job-attempt-service.js';
import { requireWorkerDatabaseUrl } from './helpers.js';

test('job attempts fence concurrency, retries, expiry, completion, and row-lock timing', async () => {
  const database = createDatabase(requireWorkerDatabaseUrl());
  const operationKey = `attempt-test:${randomUUID()}`;
  const legacyOperationKey = `attempt-test-legacy:${randomUUID()}`;
  const failureOperationKey = `attempt-test-fail:${randomUUID()}`;
  const expiredOperationKey = `attempt-test-expired:${randomUUID()}`;
  let now = new Date('2026-10-22T12:00:00.000Z');
  const service = new JobAttemptService(database, { now: () => new Date(now) });
  try {
    await migrateDatabase(database);
    await assert.rejects(service.claim('', 'boss-id', 5_000), /invalid_job/);
    await assert.rejects(service.claim(operationKey, 'boss-id', 99), /invalid_attempt_lease/);
    await database.db.insert(jobLogs).values([
      { operationKey, queueName: 'companion.process', status: 'pending', attempts: 0 },
      { operationKey: legacyOperationKey, queueName: 'companion.process', status: 'running', attempts: 2 },
      { operationKey: failureOperationKey, queueName: 'companion.process', status: 'pending', attempts: 0 },
      { operationKey: expiredOperationKey, queueName: 'companion.process', status: 'pending', attempts: 0 },
    ]);

    const legacy = await service.claim(legacyOperationKey, 'legacy-boss-id', 5_000);
    assert.ok(legacy);
    assert.equal((await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, legacyOperationKey)))[0]?.attempts, 3);
    const failureAttempt = await service.claim(failureOperationKey, 'failure-boss-id', 5_000);
    assert.ok(failureAttempt);
    const renewedFailureAttempt = await service.renew(failureAttempt, 5_000);
    assert.equal(renewedFailureAttempt.version, failureAttempt.version + 1);
    const beforeStaleRenewedFail = await snapshot(database, failureOperationKey);
    await assert.rejects(service.fail(failureAttempt, 'job_attempt_failed'), /attempt_lost/);
    assert.deepEqual(await snapshot(database, failureOperationKey), beforeStaleRenewedFail);
    const retryAt = new Date(now.getTime() + 10_000);
    await service.fail(renewedFailureAttempt, 'job_attempt_failed', retryAt);
    const failed = (await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, failureOperationKey)))[0]!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.leaseOwner, null);
    assert.equal(failed.leaseExpiresAt, null);
    assert.equal(failed.nextRunAt?.getTime(), retryAt.getTime());

    const claims = await Promise.all([
      service.claim(operationKey, 'same-boss-id', 5_000),
      service.claim(operationKey, 'same-boss-id', 5_000),
    ]);
    const winner = claims.find((claim) => claim !== null)!;
    assert.ok(winner);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await service.claim(operationKey, 'same-boss-id', 5_000), null);
    const firstAttemptRow = (await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey)))[0]!;
    assert.equal(firstAttemptRow.attempts, 1);
    assert.equal(firstAttemptRow.leaseOwner, winner.owner);

    const client = await database.pool.connect();
    let replacement: JobAttemptToken | null = null;
    await client.query('begin');
    try {
      await client.query('select id from companion.job_logs where operation_key = $1 for update', [operationKey]);
      const replacementPromise = service.claim(operationKey, 'same-boss-id', 5_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      now = new Date(winner.expiresAt.getTime() + 1);
      await client.query('commit');
      replacement = await replacementPromise;
    } finally { client.release(); }
    assert.ok(replacement);
    assert.notEqual(replacement.owner, winner.owner);
    assert.equal(replacement.version, winner.version + 1);
    const beforeStaleComplete = await snapshot(database, operationKey);
    await assert.rejects(service.complete(winner), /attempt_lost/);
    assert.deepEqual(await snapshot(database, operationKey), beforeStaleComplete);
    const beforeStaleFail = await snapshot(database, operationKey);
    await assert.rejects(service.fail(winner, 'late_failure'), /attempt_lost/);
    assert.deepEqual(await snapshot(database, operationKey), beforeStaleFail);
    const beforeStaleRenew = await snapshot(database, operationKey);
    await assert.rejects(service.renew(winner, 5_000), /attempt_lost/);
    assert.deepEqual(await snapshot(database, operationKey), beforeStaleRenew);
    const beforeLate = (await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey)))[0]!;
    assert.equal(beforeLate.leaseOwner, replacement.owner);
    assert.equal(beforeLate.status, 'running');

    await service.complete(replacement);
    const completed = (await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey)))[0]!;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.leaseOwner, null);
    assert.equal(await service.claim(operationKey, 'same-boss-id', 5_000), null);
    assert.equal(completed.attempts, 2);

    const expiredToken = await service.claim(expiredOperationKey, 'expired-boss-id', 100);
    assert.ok(expiredToken);
    now = new Date(expiredToken.expiresAt.getTime() + 1);
    const beforeExpiredCallbacks = await snapshot(database, expiredOperationKey);
    await assert.rejects(service.complete(expiredToken), /attempt_lost/);
    assert.deepEqual(await snapshot(database, expiredOperationKey), beforeExpiredCallbacks);
    await assert.rejects(service.fail(expiredToken, 'late_failure'), /attempt_lost/);
    assert.deepEqual(await snapshot(database, expiredOperationKey), beforeExpiredCallbacks);
    await assert.rejects(service.renew(expiredToken, 5_000), /attempt_lost/);
    assert.deepEqual(await snapshot(database, expiredOperationKey), beforeExpiredCallbacks);
  } finally {
    await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, operationKey));
    await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, legacyOperationKey));
    await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, failureOperationKey));
    await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, expiredOperationKey));
    await database.close();
  }
});

async function snapshot(database: ReturnType<typeof createDatabase>, operationKey: string) {
  const [row] = await database.db.select().from(jobLogs).where(eq(jobLogs.operationKey, operationKey));
  assert.ok(row);
  return row;
}
