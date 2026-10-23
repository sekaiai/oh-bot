import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { modelProfiles, modelUsage } from '../src/database/schema/index.js';
import { PostgresMonthlyUsageStore } from '../src/models/monthly-usage-store.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';

const databaseUrl = process.env.CORE_TEST_DATABASE_URL;

test('monthly model reservations serialize, retain unknown cost and fence conflicting replay inputs', { skip: !databaseUrl }, async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const profileId = uuid();
  const month = '2026-10';
  const shared = { profileId, month };
  try {
    await migrateDatabase(database);
    await database.db.insert(modelProfiles).values({
      id: profileId,
      name: `monthly-usage-${profileId}`,
      purpose: 'chat',
      provider: 'openai',
      baseUrl: 'https://provider.test/v1',
      model: 'metered-fixture',
      credentialRef: 'METERED_FIXTURE_KEY',
      enabled: true,
      maxTokens: 64,
      timeoutMs: 1000,
      monthlyBudgetUsd: '0.05',
    });

    const store = new PostgresMonthlyUsageStore(database);
    const contenders = await Promise.allSettled([
      store.reserve({ ...shared, invocationId: 'concurrent-a', amountUsd: 0.04, inputHash: 'a'.repeat(64) }),
      store.reserve({ ...shared, invocationId: 'concurrent-b', amountUsd: 0.04, inputHash: 'a'.repeat(64) }),
    ]);
    assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(contenders.filter((result) => result.status === 'rejected' && /model_monthly_budget_exceeded/.test(String(result.reason))).length, 1);

    const winnerId = contenders[0].status === 'fulfilled' ? 'concurrent-a' : 'concurrent-b';
    const settled = new PostgresMonthlyUsageStore(database);
    await settled.settle({ ...shared, invocationId: winnerId, actualUsd: 0.01 });
    assert.deepEqual(await settled.reserve({ ...shared, invocationId: winnerId, amountUsd: 0.04, inputHash: 'a'.repeat(64) }), { kind: 'unknown' });
    await assert.rejects(settled.reserve({ ...shared, invocationId: winnerId, amountUsd: 0.04, inputHash: 'b'.repeat(64) }), /model_usage_invocation_conflict/);

    await settled.reserve({ ...shared, invocationId: 'october-uncertain', amountUsd: 0.01, inputHash: '1'.repeat(64) });
    assert.deepEqual(await settled.reserve({ ...shared, month: '2026-11', invocationId: 'october-uncertain', amountUsd: 0.01, inputHash: '1'.repeat(64) }), { kind: 'unknown' });
    await assert.rejects(settled.reserve({ ...shared, month: '2026-11', invocationId: 'october-uncertain', amountUsd: 0.01, inputHash: '2'.repeat(64) }), /model_usage_invocation_conflict/);
    await settled.settle({ ...shared, invocationId: 'october-uncertain', actualUsd: 0.008 });
    const [originalBucket] = await database.db.select({ usageMonth: modelUsage.usageMonth, actualUsd: modelUsage.actualUsd }).from(modelUsage)
      .where(eq(modelUsage.invocationId, 'october-uncertain')).limit(1);
    assert.equal(originalBucket?.usageMonth, '2026-10');
    assert.equal(Number(originalBucket?.actualUsd), 0.008);

    await settled.reserve({ ...shared, invocationId: 'crashed-inflight', amountUsd: 0.01, inputHash: 'c'.repeat(64) });
    const afterRestart = new PostgresMonthlyUsageStore(database);
    assert.deepEqual(await afterRestart.reserve({ ...shared, invocationId: 'crashed-inflight', amountUsd: 0.01, inputHash: 'c'.repeat(64) }), { kind: 'unknown' });
    await assert.rejects(afterRestart.reserve({ ...shared, invocationId: 'over-limit', amountUsd: 0.03, inputHash: 'd'.repeat(64) }), /model_monthly_budget_exceeded/);
    await afterRestart.reserve({ ...shared, invocationId: 'under-reserved', amountUsd: 0.005, inputHash: 'e'.repeat(64) });
    assert.deepEqual(await afterRestart.settle({ ...shared, invocationId: 'under-reserved', actualUsd: 0.03 }), { overReserved: true });
    await assert.rejects(afterRestart.reserve({ ...shared, invocationId: 'after-overspend', amountUsd: 0.001, inputHash: 'f'.repeat(64) }), /model_monthly_budget_exceeded/);
  } finally {
    await database.db.delete(modelUsage).where(eq(modelUsage.profileId, profileId));
    await database.db.delete(modelProfiles).where(eq(modelProfiles.id, profileId));
    await database.close();
  }
});
