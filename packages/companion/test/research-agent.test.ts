import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../src/database/database.js';
import type { ToolContext } from '../src/tools/registry.js';
import { ModelProfileGateway } from '../src/models/profile-gateway.js';
import { createResearchAgent } from '../src/application/research-agent.js';

const budget = { maxSteps: 4, maxToolCalls: 4, maxTokens: 500, maxCostUsd: 0.5, timeoutMs: 2_000 };
const actor = {
  personId: 'person', characterId: 'character', conversationId: 'conversation', platformIdentityId: 'identity',
  conversationKind: 'private' as const, isPartner: false, circleIds: [], participantIds: [], linkedPersonIds: [], participantsComplete: true,
};

function database(enabled = true): Database {
  const query = {
    from() { return this; },
    where() { return this; },
    limit: async () => enabled ? [{ enabled: true }] : [],
  };
  return { db: { select: () => query } } as unknown as Database;
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    permissions: new Set(['search']), budget, signal: new AbortController().signal,
    operationKey: 'research:test', actor, consume: () => {}, ...overrides,
  };
}

const source = (url: string, title = url) => ({ title, url, snippet: `snippet ${title}` });

test('research falls back to the original query and preserves unavailable search status', async () => {
  const calls: unknown[] = [];
  const result = await createResearchAgent(database()).run({ query: '  direct question  ' }, context(), {
    names: () => ['search'], execute: async (_name, input) => { calls.push(input); return { status: 'unavailable', results: [] }; },
  });

  assert.deepEqual(calls, [{ query: 'direct question' }]);
  assert.deepEqual(result, { status: 'unavailable', sources: [] });
});

test('research keeps the latest source for each URL and caps output at ten', async () => {
  const original = ModelProfileGateway.fromCharacterBinding;
  const plannerCalls: Array<Record<string, unknown>> = [];
  ModelProfileGateway.fromCharacterBinding = async () => ({
    completeBound: async (input: Record<string, unknown>) => {
      plannerCalls.push(input);
      return { text: JSON.stringify({ queries: ['first', 'second', 'third'] }) };
    },
  } as unknown as ModelProfileGateway);
  const searchCalls: string[] = [];
  try {
    const result = await createResearchAgent(database()).run({ query: 'question' }, context({
      usageSnapshot: () => ({ tokens: 12, costUsd: 0.02 }),
      nextOrdinal: () => 7,
    }), {
      names: () => ['search'],
      execute: async (_name, input) => {
        const query = (input as { query: string }).query;
        searchCalls.push(query);
        const results = query === 'first'
          ? Array.from({ length: 10 }, (_, index) => source(`https://source.test/${index}`))
          : query === 'second'
            ? [source('https://source.test/0', 'updated'), source('https://source.test/10')]
            : [source('https://source.test/11')];
        return { status: 'available', results };
      },
    });

    assert.deepEqual(searchCalls, ['first', 'second', 'third']);
    assert.equal(plannerCalls.length, 1);
    assert.equal(plannerCalls[0]?.budget, budget);
    assert.equal(plannerCalls[0]?.signal instanceof AbortSignal, true);
    assert.equal(plannerCalls[0]?.tokensUsed, 12);
    assert.equal(plannerCalls[0]?.costUsdUsed, 0.02);
    assert.equal(plannerCalls[0]?.invocationId, 'research:test:research-plan:7');
    assert.deepEqual(result, {
      status: 'available',
      sources: [source('https://source.test/0', 'updated'), ...Array.from({ length: 9 }, (_, index) => source(`https://source.test/${index + 1}`))],
    });
  } finally {
    ModelProfileGateway.fromCharacterBinding = original;
  }
});

test('research refuses a disabled agent before calling search', async () => {
  let calls = 0;
  await assert.rejects(createResearchAgent(database(false)).run({ query: 'question' }, context(), {
    names: () => ['search'], execute: async () => { calls++; return { status: 'unavailable', results: [] }; },
  }), /agent_disabled/);
  assert.equal(calls, 0);
});

test('research cancellation and step-budget exhaustion prevent a search call', async () => {
  let calls = 0;
  const tools = { names: () => ['search'], execute: async () => { calls++; return { status: 'unavailable', results: [] }; } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createResearchAgent(database()).run({ query: 'cancelled' }, context({ signal: controller.signal }), tools), /tool_cancelled/);
  await assert.rejects(createResearchAgent(database()).run({ query: 'over budget' }, context({ consume: () => { throw new Error('budget_exceeded'); } }), tools), /budget_exceeded/);
  assert.equal(calls, 0);
});

test('planner budget errors propagate instead of silently falling back', async () => {
  const original = ModelProfileGateway.fromCharacterBinding;
  ModelProfileGateway.fromCharacterBinding = async () => ({
    completeBound: async () => { throw new Error('model_budget_exceeded'); },
  } as unknown as ModelProfileGateway);
  let calls = 0;
  try {
    await assert.rejects(createResearchAgent(database()).run({ query: 'question' }, context(), {
      names: () => ['search'], execute: async () => { calls++; return { status: 'unavailable', results: [] }; },
    }), /model_budget_exceeded/);
    assert.equal(calls, 0);
  } finally {
    ModelProfileGateway.fromCharacterBinding = original;
  }
});
