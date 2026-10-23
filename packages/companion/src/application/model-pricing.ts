import { z } from 'zod';
import type { ChatMessage } from '../models/chat-gateway.js';

const priceSchema = z.record(z.string().trim().min(1).max(128), z.object({
  inputUsdPer1M: z.number().finite().positive().max(1_000_000),
  outputUsdPer1M: z.number().finite().positive().max(1_000_000),
}).strict()).refine((value) => Object.keys(value).length > 0);
type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

/** Explicit operator-supplied provider rates; absent or malformed pricing never becomes zero-cost usage. */
export function createModelPriceEstimators(env: NodeJS.ProcessEnv): {
  estimateCost: (model: string, usage: TokenUsage) => number;
  estimateMaxCost: (model: string, messages: readonly ChatMessage[], maxTokens: number) => number;
  estimateMaxTokens: (model: string, messages: readonly ChatMessage[], maxCompletionTokens: number) => number;
} {
  let prices: z.infer<typeof priceSchema> | undefined;
  try { prices = priceSchema.parse(JSON.parse(env.COMPANION_MODEL_PRICING_JSON ?? '')); }
  catch { prices = undefined; }
  const forModel = (model: string) => {
    const price = prices?.[model];
    if (!price) throw new Error('model_cost_unavailable');
    return price;
  };
  const promptTokenUpperBound = (messages: readonly ChatMessage[]) => Buffer.byteLength(JSON.stringify(messages), 'utf8') + messages.length * 64;
  return {
    estimateCost(model, usage) {
      if (![usage.promptTokens, usage.completionTokens, usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('model_cost_unavailable');
      const price = forModel(model);
      return (usage.promptTokens * price.inputUsdPer1M + usage.completionTokens * price.outputUsdPer1M) / 1_000_000;
    },
    estimateMaxCost(model, messages, maxTokens) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('model_cost_unavailable');
      const price = forModel(model);
      // UTF-8 bytes bound byte-level tokenizers. Extra per-message overhead covers
      // the standard chat envelope; provider rates must still be supplied exactly.
      return (promptTokenUpperBound(messages) * price.inputUsdPer1M + maxTokens * price.outputUsdPer1M) / 1_000_000;
    },
    estimateMaxTokens(model, messages, maxCompletionTokens) {
      forModel(model);
      if (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 0) throw new Error('model_budget_exceeded');
      return promptTokenUpperBound(messages) + maxCompletionTokens;
    },
  };
}
