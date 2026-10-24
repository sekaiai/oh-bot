import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { createAdminApplication } from '../src/admin/app.js';
import { createModelPriceEstimators } from '../src/application/model-pricing.js';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { requireCompatDatabaseUrl } from './helpers.js';
import { auditEvents, characters, modelProfiles, modelRoleBindings, modelUsage } from '../src/database/schema/index.js';
import { ModelProfileGateway } from '../src/models/profile-gateway.js';
import { PostgresMonthlyUsageStore } from '../src/models/monthly-usage-store.js';

const adminToken = 'profile-lifecycle-test-admin-token-long-enough';

test('HTTP profile create, test, enable, bind and persistent gateway lifecycle uses only a local model fixture', { timeout: 30_000 }, async () => {
  const databaseUrl = requireCompatDatabaseUrl();
  let calls = 0;
  let failCalls = 0;
  let releaseSecond!: () => void;
  let secondSeen!: () => void;
  const secondRequest = new Promise<void>((resolve) => { secondSeen = resolve; });
  const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const fixture = createServer(async (request, response) => {
    calls += 1;
    if (request.headers.authorization !== 'Bearer profile-test-secret') {
      response.writeHead(401).end();
      return;
    }
    if (failCalls > 0) {
      failCalls -= 1;
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'provider-secret-must-not-leak' } }));
      return;
    }
    if (calls === 2) {
      secondSeen();
      await holdSecond;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: `fixture-${calls}`,
      object: 'chat.completion',
      created: 1,
      model: 'fixture-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  const previousCredential = process.env.PROFILE_LIFECYCLE_FIXTURE_KEY;
  const previousPricing = process.env.COMPANION_MODEL_PRICING_JSON;
  process.env.PROFILE_LIFECYCLE_FIXTURE_KEY = 'profile-test-secret';
  process.env.COMPANION_MODEL_PRICING_JSON = JSON.stringify({ 'fixture-chat': { inputUsdPer1M: 1, outputUsdPer1M: 2 } });

  const database = createDatabase(databaseUrl);
  const suffix = randomUUID().replaceAll('-', '');
  const characterId = randomUUID();
  const profileName = `profile-lifecycle-${suffix}`;
  let profileId: string | undefined;
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({ id: characterId, name: `profile-lifecycle-${suffix}` });
    app = await createAdminApplication({ database, adminToken });
    const headers = { authorization: `Bearer ${adminToken}` };
    const create = await app.inject({ method: 'POST', url: '/admin/model-profiles', headers, payload: {
      name: profileName, purpose: 'chat', provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'fixture-chat', credentialRef: 'PROFILE_LIFECYCLE_FIXTURE_KEY', maxTokens: 16, timeoutMs: 3000, monthlyBudgetUsd: '1',
    } });
    assert.equal(create.statusCode, 201, create.body);
    const createdProfileId = create.json().id as string;
    profileId = createdProfileId;
    assert.equal(create.json().enabled, false);
    assert.equal(JSON.stringify(create.json()).includes('profile-test-secret'), false);

    const enableTooEarly = await app.inject({ method: 'PUT', url: `/admin/model-profiles/${createdProfileId}/enabled`, headers, payload: { version: 1, enabled: true, auditReason: 'Enable after model test' } });
    assert.equal(enableTooEarly.statusCode, 409);
    assert.equal(enableTooEarly.json().code, 'profile_test_required');

    const firstTest = await app.inject({ method: 'POST', url: `/admin/model-profiles/${createdProfileId}/test`, headers, payload: { version: 1 } });
    assert.equal(firstTest.statusCode, 201);
    assert.equal(firstTest.json().lastTestStatus, 'passed', firstTest.body);
    assert.ok(firstTest.json().usage.costUsd > 0);
    assert.equal(calls, 1);

    const staleTestPromise = app.inject({ method: 'POST', url: `/admin/model-profiles/${createdProfileId}/test`, headers, payload: { version: 2 } });
    await secondRequest;
    assert.equal(calls, 2);
    const duplicateTest = await app.inject({ method: 'POST', url: `/admin/model-profiles/${createdProfileId}/test`, headers, payload: { version: 2 } });
    assert.equal(duplicateTest.statusCode, 409);
    assert.equal(duplicateTest.json().code, 'version_conflict');
    assert.equal(calls, 2, 'duplicate old-version test must not call the provider');
    await database.db.update(modelProfiles).set({ version: 4, lastTestStatus: 'never' }).where(and(eq(modelProfiles.id, createdProfileId), eq(modelProfiles.version, 3)));
    releaseSecond();
    const staleTest = await staleTestPromise;
    assert.equal(staleTest.statusCode, 409);
    assert.equal(staleTest.json().code, 'version_conflict');

    const retest = await app.inject({ method: 'POST', url: `/admin/model-profiles/${createdProfileId}/test`, headers, payload: { version: 4 } });
    assert.equal(retest.statusCode, 201);
    assert.equal(retest.json().lastTestStatus, 'passed', retest.body);
    assert.equal(retest.json().version, 5);
    assert.equal(calls, 3);
    const enabled = await app.inject({ method: 'PUT', url: `/admin/model-profiles/${createdProfileId}/enabled`, headers, payload: { version: 5, enabled: true, auditReason: 'Enable after successful fixture test' } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().enabled, true);

    const bound = await app.inject({ method: 'PUT', url: `/admin/characters/${characterId}/model-bindings`, headers, payload: { purpose: 'chat', profileId: createdProfileId } });
    assert.equal(bound.statusCode, 200, bound.body);
    const gateway = await ModelProfileGateway.fromCharacterBinding(database, characterId, 'chat', {
      ...createModelPriceEstimators(process.env), monthlyUsage: new PostgresMonthlyUsageStore(database),
    });
    const reply = await gateway.completeBound({
      characterId, purpose: 'chat', messages: [{ role: 'user', content: 'Persistent chat fixture request' }],
      budget: { maxSteps: 1, maxToolCalls: 1, maxTokens: 1024, maxCostUsd: 1, timeoutMs: 3000 },
      signal: new AbortController().signal, tokensUsed: 0, costUsdUsed: 0,
      invocationId: `persistent-chat:${suffix}`, consume: () => undefined,
    });
    assert.equal(reply.text, 'OK');
    assert.equal(calls, 4);

    failCalls = 10;
    const failedRetest = await app.inject({ method: 'POST', url: `/admin/model-profiles/${createdProfileId}/test`, headers, payload: { version: 6 } });
    assert.equal(failedRetest.statusCode, 201);
    assert.equal(failedRetest.json().lastTestStatus, 'failed');
    assert.equal(failedRetest.body.includes('provider-secret-must-not-leak'), false);
    assert.ok(calls > 4);
    const disabledProfile = await database.db.select().from(modelProfiles).where(eq(modelProfiles.id, createdProfileId));
    assert.equal(disabledProfile[0]?.enabled, false);
    const disabledGateway = await ModelProfileGateway.fromCharacterBinding(database, characterId, 'chat', {
      ...createModelPriceEstimators(process.env), monthlyUsage: new PostgresMonthlyUsageStore(database),
    });
    await assert.rejects(() => disabledGateway.completeBound({
      characterId, purpose: 'chat', messages: [{ role: 'user', content: 'Disabled fixture request' }],
      budget: { maxSteps: 1, maxToolCalls: 1, maxTokens: 1024, maxCostUsd: 1, timeoutMs: 3000 },
      signal: new AbortController().signal, tokensUsed: 0, costUsdUsed: 0,
      invocationId: `disabled-chat:${suffix}`, consume: () => undefined,
    }), /model_not_configured/);
    assert.ok(calls > 4);
    const enableAfterFailedTest = await app.inject({ method: 'PUT', url: `/admin/model-profiles/${createdProfileId}/enabled`, headers, payload: { version: 7, enabled: true, auditReason: 'Failed test keeps profile disabled' } });
    assert.equal(enableAfterFailedTest.statusCode, 409);
    assert.equal(enableAfterFailedTest.json().code, 'profile_test_required');

    const audits = await database.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, createdProfileId), eq(auditEvents.action, 'model_profile_tested')));
    assert.equal(audits.length, 3);
    assert.equal(JSON.stringify(audits).includes('profile-test-secret'), false);
  } finally {
    releaseSecond();
    await app?.close();
    if (profileId) {
      await database.db.delete(modelRoleBindings).where(eq(modelRoleBindings.characterId, characterId));
      await database.db.delete(modelUsage).where(eq(modelUsage.profileId, profileId));
      await database.db.delete(auditEvents).where(eq(auditEvents.targetId, profileId));
      await database.db.delete(modelProfiles).where(eq(modelProfiles.id, profileId));
    }
    await database.db.delete(characters).where(eq(characters.id, characterId));
    await database.close();
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    if (previousCredential === undefined) delete process.env.PROFILE_LIFECYCLE_FIXTURE_KEY;
    else process.env.PROFILE_LIFECYCLE_FIXTURE_KEY = previousCredential;
    if (previousPricing === undefined) delete process.env.COMPANION_MODEL_PRICING_JSON;
    else process.env.COMPANION_MODEL_PRICING_JSON = previousPricing;
  }
});
