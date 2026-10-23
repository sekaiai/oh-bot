import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPriceEstimators } from '../src/application/model-pricing.js';

test('model pricing uses configured rates for actual usage and reserves an input/output upper bound', () => {
  const pricing = createModelPriceEstimators({ COMPANION_MODEL_PRICING_JSON: JSON.stringify({ model: { inputUsdPer1M: 1, outputUsdPer1M: 2 } }) });
  assert.equal(pricing.estimateCost('model', { promptTokens: 2, completionTokens: 1, totalTokens: 3 }), 0.000004);
  assert.ok(pricing.estimateMaxCost('model', [{ role: 'user', content: 'hi' }], 8) > 0);
  assert.throws(() => pricing.estimateCost('unknown', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }), /model_cost_unavailable/);
});

test('missing and malformed pricing fail closed rather than estimating zero', () => {
  for (const env of [{}, { COMPANION_MODEL_PRICING_JSON: '{broken' }]) {
    const pricing = createModelPriceEstimators(env);
    assert.throws(() => pricing.estimateCost('model', { promptTokens: 1, completionTokens: 0, totalTokens: 1 }), /model_cost_unavailable/);
    assert.throws(() => pricing.estimateMaxCost('model', [{ role: 'user', content: 'hi' }], 8), /model_cost_unavailable/);
  }
});
