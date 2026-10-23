import { z } from 'zod';
import type { ActorContext, Budget } from '../domain/contracts.js';

export type ToolInvocationStore = Readonly<{
  beginTool(input: {
    turnId: string;
    agentRunId?: string;
    name: string;
    operationKey: string;
    permission: 'read' | 'external_action';
    input: unknown;
    actor: ActorContext;
    budget: Budget;
  }): Promise<
    | { kind: 'execute'; runId: string }
    | { kind: 'cached'; runId: string; result: unknown }
    | { kind: 'unknown'; runId?: string }
  >;
  finishTool(input: {
    runId: string;
    operationKey: string;
    result?: unknown;
    errorCode?: string;
    unknown: boolean;
    usage?: Readonly<Record<string, number>>;
  }): Promise<void>;
  beginAgent(input: {
    turnId: string;
    actor: ActorContext;
    name: string;
    threadId: string;
    task: unknown;
    budget: Budget;
    usage?: Readonly<Record<string, number>>;
  }): Promise<string>;
  finishAgent(input: {
    runId: string;
    result?: unknown;
    errorCode?: string;
    cancelled?: boolean;
    usage?: Readonly<Record<string, number>>;
  }): Promise<void>;
}>;

export type ToolContext = Readonly<{
  permissions: ReadonlySet<string>;
  budget: Budget;
  signal: AbortSignal;
  operationKey: string;
  turnId?: string;
  threadId?: string;
  actor?: ActorContext;
  agentRunId?: string;
  store?: ToolInvocationStore;
  usageSnapshot?: () => Readonly<Record<string, number>>;
  consume: (kind: 'toolCalls' | 'steps' | 'tokens' | 'costUsd', amount: number) => void;
  /** Stable within a logical route/agent attempt and reset when that attempt replays. */
  nextOrdinal?: (scope: string) => number;
  /** Refresh authorization and visible persona/memory before sensitive boundaries. */
  revalidate?: () => Promise<void>;
}>;

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('tool_cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('tool_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface ToolExecutor {
  names(): readonly string[];
  execute(name: string, input: unknown, context: ToolContext): Promise<unknown>;
}

export type ToolDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> = Readonly<{
  name: string;
  permission: string;
  input: Input;
  output: Output;
  externalAction?: boolean;
  run: (input: z.infer<Input>, context: ToolContext) => Promise<z.infer<Output>>;
}>;

export class ToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, ToolDefinition>();

  register<Input extends z.ZodType, Output extends z.ZodType>(definition: ToolDefinition<Input, Output>): void {
    if (
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(definition.name) ||
      this.tools.has(definition.name) ||
      !definition.permission.trim()
    ) throw new Error('tool_invalid_config');
    this.tools.set(definition.name, Object.freeze(definition));
  }

  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, rawInput: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error('tool_unavailable');
    if (!context.permissions.has(tool.permission)) throw new Error('tool_forbidden');
    if (context.signal.aborted) throw new Error('tool_cancelled');
    if (tool.externalAction && (!context.store || !context.turnId || !context.actor)) {
      throw new Error('tool_persistence_required');
    }

    context.consume('toolCalls', 1);
    const input = tool.input.parse(rawInput);
    await context.revalidate?.();
    const ordinal = context.nextOrdinal?.(name) ?? 0;
    const operationKey = `${context.operationKey}:tool:${name}:${ordinal}`;
    const invocation = Object.freeze({ ...context, operationKey });
    const run = context.store && context.turnId && context.actor
      ? await context.store.beginTool({
        turnId: context.turnId,
        ...(context.agentRunId ? { agentRunId: context.agentRunId } : {}),
        name,
        operationKey,
        permission: tool.externalAction ? 'external_action' : 'read',
        input,
        actor: context.actor,
        budget: context.budget,
      })
      : undefined;

    if (run?.kind === 'cached') return tool.output.parse(run.result);
    if (run?.kind === 'unknown') throw new Error('tool_receipt_unknown');

    try {
      if (context.signal.aborted) throw new Error('tool_cancelled');
      await context.revalidate?.();
      const result = tool.output.parse(await bounded(tool.run(input, invocation), context.signal));
      if (context.signal.aborted) throw new Error('tool_cancelled');
      await context.revalidate?.();
      if (run) await context.store!.finishTool({
        runId: run.runId,
        operationKey,
        result,
        unknown: false,
        usage: context.usageSnapshot?.(),
      });
      return result;
    } catch (error) {
      if (run) {
        await context.store!.finishTool({
          runId: run.runId,
          operationKey,
          errorCode: error instanceof Error && error.message === 'tool_cancelled' ? 'tool_cancelled' : 'tool_failed',
          unknown: Boolean(tool.externalAction),
          usage: context.usageSnapshot?.(),
        });
      }
      throw error;
    }
  }
}

export type AgentDefinition = Readonly<{
  name: string;
  permissions: readonly string[];
  tools: readonly string[];
  input: z.ZodType;
  output: z.ZodType;
  run: (input: unknown, context: ToolContext, tools: ToolExecutor) => Promise<unknown>;
}>;

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(agent.name) || this.agents.has(agent.name)) {
      throw new Error('agent_invalid_config');
    }
    this.agents.set(agent.name, Object.freeze(agent));
  }

  async run(name: string, input: unknown, context: ToolContext, tools: ToolRegistry): Promise<unknown> {
    const agent = this.agents.get(name);
    if (!agent) throw new Error('agent_unavailable');
    if (agent.permissions.some((permission) => !context.permissions.has(permission))) {
      throw new Error('tool_forbidden');
    }
    if (context.signal.aborted) throw new Error('tool_cancelled');

    const parsedInput = agent.input.parse(input);
    const allowedTools = new Set(agent.tools);
    const agentOrdinal = context.nextOrdinal?.(`agent:${name}`) ?? 0;
    const childOrdinals = new Map<string, number>();
    const agentRunId = context.store && context.turnId && context.actor
      ? await context.store.beginAgent({
        turnId: context.turnId,
        actor: context.actor,
        name,
        threadId: `${context.threadId ?? context.operationKey}:agent:${name}:${agentOrdinal}`,
        task: parsedInput,
        budget: context.budget,
        usage: context.usageSnapshot?.(),
      })
      : undefined;
    const childContext: ToolContext = Object.freeze({
      ...context,
      budget: Object.freeze({ ...context.budget }),
      ...(agentRunId ? { agentRunId } : {}),
      permissions: new ImmutableSet([...context.permissions].filter((permission) => agent.permissions.includes(permission))),
      operationKey: agentRunId ? `${context.operationKey}:agent:${agentRunId}` : `${context.operationKey}:agent:${name}`,
      nextOrdinal: (scope) => {
        if (context.nextOrdinal) return context.nextOrdinal(`agent:${name}:${agentOrdinal}:${scope}`);
        const ordinal = childOrdinals.get(scope) ?? 0;
        childOrdinals.set(scope, ordinal + 1);
        return ordinal;
      },
    });
    const scopedTools: ToolExecutor = {
      names: () => tools.names().filter((toolName) => allowedTools.has(toolName)),
      execute: (toolName, rawInput, _child) => !context.signal.aborted && allowedTools.has(toolName)
        ? tools.execute(toolName, rawInput, childContext)
        : Promise.reject(new Error(context.signal.aborted ? 'tool_cancelled' : 'tool_forbidden')),
    };

    try {
      await context.revalidate?.();
      const result = agent.output.parse(await bounded(agent.run(parsedInput, childContext, scopedTools), context.signal));
      await context.revalidate?.();
      if (context.signal.aborted) throw new Error('tool_cancelled');
      if (agentRunId) await context.store!.finishAgent({ runId: agentRunId, result, usage: context.usageSnapshot?.() });
      return result;
    } catch (error) {
      if (agentRunId) {
        await context.store!.finishAgent({
          runId: agentRunId,
          errorCode: error instanceof Error && error.message === 'tool_cancelled' ? 'tool_cancelled' : 'agent_failed',
          cancelled: context.signal.aborted,
          usage: context.usageSnapshot?.(),
        });
      }
      throw error;
    }
  }
}

class ImmutableSet<T> implements ReadonlySet<T> {
  readonly #data: Set<T>;
  constructor(values: Iterable<T>) { this.#data = new Set(values); Object.freeze(this); }
  get size(): number { return this.#data.size; }
  has(value: T): boolean { return this.#data.has(value); }
  union<U>(other: SetLike<U>): Set<T | U> { return new Set([...this.#data, ...setLikeValues(other)]); }
  intersection<U>(other: SetLike<U>): Set<T & U> {
    const result = new Set<T & U>();
    for (const value of this.#data) if (hasSetLikeValue(other, value)) result.add(value);
    return result;
  }
  difference<U>(other: SetLike<U>): Set<T> {
    const result = new Set<T>();
    for (const value of this.#data) if (!hasSetLikeValue(other, value)) result.add(value);
    return result;
  }
  symmetricDifference<U>(other: SetLike<U>): Set<T | U> {
    const result = new Set<T | U>();
    for (const value of this.#data) if (!hasSetLikeValue(other, value)) result.add(value);
    for (const value of setLikeValues(other)) if (!hasSetLikeValue(this.#data, value)) result.add(value);
    return result;
  }
  isSubsetOf(other: SetLike<unknown>): boolean {
    for (const value of this.#data) if (!hasSetLikeValue(other, value)) return false;
    return true;
  }
  isSupersetOf(other: SetLike<unknown>): boolean {
    for (const value of setLikeValues(other)) if (!hasSetLikeValue(this.#data, value)) return false;
    return true;
  }
  isDisjointFrom(other: SetLike<unknown>): boolean {
    for (const value of setLikeValues(other)) if (hasSetLikeValue(this.#data, value)) return false;
    return true;
  }
  entries(): SetIterator<[T, T]> { return this.#data.entries(); }
  keys(): SetIterator<T> { return this.#data.keys(); }
  values(): SetIterator<T> { return this.#data.values(); }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#data.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
  [Symbol.iterator](): SetIterator<T> { return this.#data[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return 'ImmutableSet'; }
}

type SetLike<T> = Readonly<{ size: number; has(value: T): boolean; keys(): Iterator<T> }>;

function* setLikeValues<T>(setLike: SetLike<T>): IterableIterator<T> {
  const iterator = setLike.keys();
  while (true) {
    const item = iterator.next();
    if (item.done) return;
    yield item.value;
  }
}

function hasSetLikeValue<T>(setLike: SetLike<T>, value: unknown): value is T {
  for (const candidate of setLikeValues(setLike)) {
    if (candidate === value || candidate !== candidate && value !== value) return true;
  }
  return false;
}

export const unavailableSearchSchema = z.object({
  status: z.literal('unavailable'),
  results: z.array(z.never()),
}).strict();

export function unavailableSearchTool(): ToolDefinition {
  return {
    name: 'search',
    permission: 'search',
    input: z.object({ query: z.string().trim().min(1).max(500) }).strict(),
    output: unavailableSearchSchema,
    run: async () => ({ status: 'unavailable', results: [] }),
  };
}
