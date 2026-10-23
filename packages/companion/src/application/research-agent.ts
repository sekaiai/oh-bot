import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { agentDefinitions } from '../database/schema/index.js';
import { and, eq } from 'drizzle-orm';
import type { ChatMessage } from '../models/chat-gateway.js';
import { ModelProfileGateway } from '../models/profile-gateway.js';
import type { AgentDefinition, ToolExecutor } from '../tools/registry.js';
import { createModelPriceEstimators } from './model-pricing.js';

const QueryPlan = z.object({ queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3) }).strict();
const Source = z.object({ title: z.string(), url: z.string(), snippet: z.string() }).strict();
const ResearchResult = z.object({ status: z.enum(['available', 'unavailable']), sources: z.array(Source).max(10) }).strict();
const ResearchState = Annotation.Root({
  query: Annotation<string>(),
  queries: Annotation<readonly string[]>({ default: () => [], value: (_old, next) => next }),
  sources: Annotation<readonly z.infer<typeof Source>[]>({ default: () => [], value: (_old, next) => next }),
  status: Annotation<'available' | 'unavailable'>({ default: () => 'unavailable', value: (_old, next) => next }),
});

/** A bounded LangGraph research subgraph. It gathers structured sources; its parent remains the only speaker. */
export function createResearchAgent(database: Database, pricing = createModelPriceEstimators(process.env)): AgentDefinition {
  return {
    name: 'research', permissions: ['search'], tools: ['search'],
    input: z.object({ query: z.string().trim().min(1).max(500) }).strict(), output: ResearchResult,
    run: async (raw, context, tools: ToolExecutor) => {
      const input = z.object({ query: z.string().trim().min(1).max(500) }).strict().parse(raw);
      const assertEnabled = async () => {
        await context.revalidate?.();
        const [definition] = await database.db.select({ enabled: agentDefinitions.enabled }).from(agentDefinitions)
          .where(and(eq(agentDefinitions.name, 'research'), eq(agentDefinitions.enabled, true))).limit(1);
        if (!definition?.enabled) throw new Error('agent_disabled');
      };
      await assertEnabled();
      let queryGateway: ModelProfileGateway | undefined;
      try { queryGateway = await ModelProfileGateway.fromCharacterBinding(database, context.actor!.characterId, 'search', pricing); } catch { /* no search planner configured */ }
      const graph = new StateGraph(ResearchState)
        .addNode('plan', async ({ query }) => {
          if (!queryGateway) return { queries: [query] };
          const messages: ChatMessage[] = [
            { role: 'system', content: 'Create a concise research plan. Return strict JSON only: {"queries":["..."]}; provide 1 to 3 distinct search queries, each directly related to the user question.' },
            { role: 'user', content: query },
          ];
          try {
            const usage = context.usageSnapshot?.() ?? {};
            const reply = await queryGateway!.completeBound({ characterId: context.actor!.characterId, purpose: 'search', messages, budget: context.budget, signal: context.signal,
              tokensUsed: usage.tokens ?? 0, costUsdUsed: usage.costUsd ?? 0, consume: context.consume,
              invocationId: `${context.operationKey}:research-plan:${context.nextOrdinal?.('research-profile-call') ?? 0}` });
            return { queries: QueryPlan.parse(JSON.parse(reply.text)).queries };
          } catch (error) {
            if (error instanceof Error && ['budget_exceeded', 'model_budget_exceeded', 'model_monthly_budget_exceeded', 'model_usage_unknown', 'model_cost_unavailable', 'model_usage_unavailable', 'model_monthly_budget_unavailable'].includes(error.message)) throw error;
            return { queries: [query] };
          }
        })
        .addNode('search', async ({ queries }) => {
          const sources: z.infer<typeof Source>[] = [];
          for (const query of [...new Set(queries)].slice(0, 3)) {
            if (context.signal.aborted) throw new Error('tool_cancelled');
            await assertEnabled();
            context.consume('steps', 1);
            const result = await tools.execute('search', { query }, context) as { status?: unknown; results?: unknown };
            const parsed = z.object({ status: z.enum(['available', 'unavailable']), results: z.array(Source).max(10) }).strict().safeParse(result);
            if (parsed.success && parsed.data.status === 'available') sources.push(...parsed.data.results);
          }
          const unique = [...new Map(sources.map((source) => [source.url, source])).values()].slice(0, 10);
          return { sources: unique, status: unique.length ? 'available' as const : 'unavailable' as const };
        })
        .addEdge(START, 'plan')
        .addEdge('plan', 'search')
        .addEdge('search', END)
        .compile();
      const result = await graph.invoke({ query: input.query });
      if (context.signal.aborted) throw new Error('tool_cancelled');
      return ResearchResult.parse({ status: result.status, sources: result.sources });
    },
  };
}
