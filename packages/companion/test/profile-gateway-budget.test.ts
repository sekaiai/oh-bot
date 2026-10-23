import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProfileGateway } from '../src/models/profile-gateway.js';
import type { MonthlyUsageStore } from '../src/models/monthly-usage-store.js';

const profile = {
  id: '00000000-0000-4000-8000-000000000071',
  characterId: '00000000-0000-4000-8000-000000000072',
  enabled: true,
  purpose: 'chat' as const,
  provider: 'openai' as const,
  baseUrl: 'https://provider.test/v1',
  model: 'metered-fixture',
  credentialRef: 'CHAT_KEY',
  maxTokens: 64,
  timeoutMs: 2_000,
  monthlyBudgetUsd: '10',
};

const input = (signal: AbortSignal) => ({
  profileId: profile.id,
  characterId: profile.characterId,
  purpose: 'chat' as const,
  messages: [{ role: 'user' as const, content: 'bounded request' }],
  budget: { maxSteps: 2, maxToolCalls: 1, maxTokens: 100, maxCostUsd: 1, timeoutMs: 2_000 },
  signal,
  tokensUsed: 0,
  costUsdUsed: 0,
  invocationId: 'turn:abort-reservation:compose:0',
  consume: () => {},
});

const estimators = {
  estimateCost: () => 0.01,
  estimateMaxCost: () => 0.02,
  estimateMaxTokens: (_model: string, _messages: readonly { role: string; content: string }[], output: number) => output,
};

test('an abort while the monthly reservation waits never starts the provider', async () => {
  let enteredReserve!: () => void;
  let releaseReserve!: (result: { kind: 'execute' }) => void;
  const entered = new Promise<void>((resolve) => { enteredReserve = resolve; });
  const pendingReservation = new Promise<{ kind: 'execute' }>((resolve) => { releaseReserve = resolve; });
  const store: MonthlyUsageStore = {
    reserve: async () => { enteredReserve(); return pendingReservation; },
    settle: async () => ({ overReserved: false }),
  };
  let providerCalls = 0;
  const controller = new AbortController();
  const gateway = new ModelProfileGateway([profile], {
    env: { CHAT_KEY: 'fixture' },
    ...estimators,
    monthlyUsage: store,
    createModel: () => ({ invoke: async () => { providerCalls++; return { content: 'unexpected' }; } }),
  });

  const completion = gateway.complete(input(controller.signal));
  await entered;
  controller.abort();
  await assert.rejects(completion, /model_timeout/);
  releaseReserve({ kind: 'execute' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 0);
});

test('a null monthly ceiling still preflights maximum request cost against the turn budget', async () => {
  const noMonthlyProfile = { ...profile, monthlyBudgetUsd: null };
  let providerCalls = 0;
  const gateway = new ModelProfileGateway([noMonthlyProfile], {
    env: { CHAT_KEY: 'fixture' },
    ...estimators,
    estimateMaxCost: () => 2,
    createModel: () => ({ invoke: async () => { providerCalls++; return { content: 'unexpected' }; } }),
  });

  await assert.rejects(gateway.complete(input(new AbortController().signal)), /model_budget_exceeded/);
  assert.equal(providerCalls, 0);
});
