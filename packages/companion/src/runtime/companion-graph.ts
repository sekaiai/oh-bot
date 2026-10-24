import { createHash } from 'node:crypto';
import { Annotation, Command, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Pool } from 'pg';
import { z } from 'zod';
import { budgetSchema, type ActorContext, type Budget, type Principal } from '../domain/contracts.js';
import { AgentRegistry, ToolRegistry, type ToolContext, type ToolInvocationStore } from '../tools/registry.js';

export type CompanionGraphRequest = Readonly<{
  turnId: string;
  principal: Principal;
  actor: ActorContext;
  conversationId: string;
  characterId: string;
  userText: string;
  budget: Budget;
  permissions: readonly string[];
  signal?: AbortSignal;
  resume?: string;
}>;

const graphActorSchema = z.object({
  personId: z.string().uuid(),
  characterId: z.string().uuid(),
  conversationId: z.string().uuid(),
  platformIdentityId: z.string().min(1).max(512),
  conversationKind: z.enum(['private', 'group']),
  isPartner: z.boolean(),
  circleIds: z.array(z.string().uuid()).max(100),
  participantIds: z.array(z.string().max(512)).max(500),
  linkedPersonIds: z.array(z.string().uuid()).max(100),
  participantsComplete: z.boolean(),
}).strict();

const graphRequestSchema = z.object({
  turnId: z.string().uuid(),
  conversationId: z.string().uuid(),
  characterId: z.string().uuid(),
  userText: z.string().min(1).max(32_000),
  budget: budgetSchema,
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)).max(100),
  principal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('person'), actor: graphActorSchema }).strict(),
    z.object({ kind: z.literal('admin'), auditActorId: z.string().min(1).max(128) }).strict(),
  ]),
  actor: graphActorSchema,
  signal: z.custom<AbortSignal>((value) => value === undefined || value instanceof AbortSignal).optional(),
  resume: z.string().max(32_000).optional(),
}).strict();

export const routeDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer') }).strict(),
  z.object({ kind: z.literal('tool'), name: z.string().min(1).max(64), input: z.unknown() }).strict(),
  z.object({ kind: z.literal('agent'), name: z.string().min(1).max(64), input: z.unknown() }).strict(),
]);
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

export type GraphHooks = Readonly<{
  authorize: (request: CompanionGraphRequest) => Promise<{ actor: ActorContext; permissions: readonly string[] }>;
  loadPersona: (actor: ActorContext, signal?: AbortSignal) => Promise<string>;
  readMemory: (actor: ActorContext, query: string, signal?: AbortSignal, turnId?: string) => Promise<readonly unknown[]>;
  route: (
    input: { text: string; persona: string; memory: readonly unknown[]; actor: ActorContext },
    context: ToolContext,
  ) => Promise<RouteDecision>;
  compose: (input: {
    userText: string;
    persona: string;
    memory: readonly unknown[];
    routed: unknown;
    actor: ActorContext;
    signal: AbortSignal;
    context: ToolContext;
  }) => Promise<string>;
  /** Idempotently enqueue delivery using operationKey; this hook must never send directly. */
  deliver: (input: {
    turnId: string;
    conversationId: string;
    content: string;
    operationKey: string;
    actor: ActorContext;
    permissions: readonly string[];
    signal: AbortSignal;
  }) => Promise<{ status: 'staged' | 'already_staged' | 'receipt_unknown' }>;
  finalize?: (input: { turnId: string; content: string; deliveryStatus: string; operationKey: string }) => Promise<void>;
}>;

type BudgetUsage = Readonly<{ toolCalls: number; steps: number; tokens: number; costUsd: number }>;
const emptyUsage: BudgetUsage = { toolCalls: 0, steps: 0, tokens: 0, costUsd: 0 };
const GraphState = Annotation.Root({
  request: Annotation<CompanionGraphRequest>(),
  actor: Annotation<ActorContext>(),
  permissions: Annotation<readonly string[]>(),
  persona: Annotation<string>(),
  memory: Annotation<readonly unknown[]>(),
  contextFingerprint: Annotation<string>(),
  routed: Annotation<unknown>(),
  budgetUsage: Annotation<BudgetUsage>({ default: () => emptyUsage, value: (_old, next) => next }),
  content: Annotation<string>(),
  deliveryStatus: Annotation<string>(),
  finalized: Annotation<boolean>(),
  deadlineAt: Annotation<number>(),
});

export type CompanionGraphOptions = Readonly<{
  databaseUrl: string;
  hooks: GraphHooks;
  tools?: ToolRegistry;
  agents?: AgentRegistry;
  runStore?: ToolInvocationStore;
  pool?: Pool;
  setup?: boolean;
}>;

export async function setupCompanionCheckpoint(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const saver = new PostgresSaver(pool);
  try {
    await saver.setup();
  } finally {
    await saver.end();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('graph_cancelled'));
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => signal.addEventListener(
      'abort', () => reject(new Error(signal.reason === 'graph_timeout' ? 'graph_timeout' : 'graph_cancelled')),
      { once: true },
    )),
  ]);
}

/** Build the sole conversation orchestration graph over a real PostgreSQL checkpointer. */
export async function createCompanionGraph(options: CompanionGraphOptions) {
  if (!/^postgres(?:ql)?:\/\//i.test(options.databaseUrl)) throw new Error('graph_database_required');
  const pool = options.pool ?? new Pool({ connectionString: options.databaseUrl });
  const saver = new PostgresSaver(pool);

  try {
    if (options.setup) await saver.setup();
    const tools = options.tools ?? new ToolRegistry();
    const agents = options.agents ?? new AgentRegistry();
    const activeSignals = new Map<string, AbortSignal>();
    const activeTurns = new Set<string>();
    const signalFor = (request: CompanionGraphRequest) => activeSignals.get(request.turnId) ?? request.signal;
    const requestForHook = (request: CompanionGraphRequest): CompanionGraphRequest => ({
      ...request,
      signal: signalFor(request),
    });
    const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
    const actorBinding = (actor: ActorContext) => ({
      personId: actor.personId,
      characterId: actor.characterId,
      conversationId: actor.conversationId,
      platformIdentityId: actor.platformIdentityId,
    });
    const principalBinding = (principal: Principal) => principal.kind === 'person'
      ? { kind: 'person', personId: principal.actor.personId }
      : { kind: 'admin', auditActorId: principal.auditActorId };
    const sameActor = (left: ActorContext, right: ActorContext) =>
      canonical(actorBinding(left)) === canonical(actorBinding(right));

    const currentBaselines = new Map<string, { request: CompanionGraphRequest; actor: ActorContext; permissions: readonly string[]; fingerprint?: string }>();
    const refreshTrustedContext = async (request: CompanionGraphRequest, signal: AbortSignal): Promise<void> => {
      const baseline = currentBaselines.get(request.turnId);
      if (!baseline) throw new Error('graph_checkpoint_invalid');
      const fresh = await bounded(options.hooks.authorize(requestForHook(request)), signal);
      if (!sameActor(fresh.actor, baseline.actor) || canonical([...fresh.permissions].sort()) !== canonical([...baseline.permissions].sort())) {
        throw new Error('graph_forbidden');
      }
      const [persona, memory] = await Promise.all([
        bounded(options.hooks.loadPersona(fresh.actor, signal), signal),
        bounded(options.hooks.readMemory(fresh.actor, request.userText, signal, request.turnId), signal),
      ]);
      const freshFingerprint = fingerprint({ actor: fresh.actor, persona, memory, userText: request.userText, permissions: [...fresh.permissions].sort() });
      if (baseline.fingerprint && freshFingerprint !== baseline.fingerprint) throw new Error('graph_context_changed');
      baseline.fingerprint ??= freshFingerprint;
    };

    const makeToolContext = (
      request: CompanionGraphRequest,
      actor: ActorContext,
      permissions: readonly string[],
      prior: BudgetUsage,
      signal: AbortSignal,
    ): { context: ToolContext; usage: { toolCalls: number; steps: number; tokens: number; costUsd: number } } => {
      const budget = { ...request.budget };
      const usage = { ...prior };
      const limits = {
        toolCalls: budget.maxToolCalls,
        steps: budget.maxSteps,
        tokens: budget.maxTokens,
        costUsd: budget.maxCostUsd,
      };
      const context: ToolContext = {
        permissions: new ImmutablePermissions(permissions),
        budget: Object.freeze(budget),
        signal,
        operationKey: `turn:${request.turnId}`,
        turnId: request.turnId,
        threadId: `turn:${request.turnId}`,
        actor,
        ...(options.runStore ? { store: options.runStore } : {}),
        usageSnapshot: () => Object.freeze({ ...usage }),
        nextOrdinal: (() => { const ordinals = new Map<string, number>(); return (scope: string) => { const ordinal = ordinals.get(scope) ?? 0; ordinals.set(scope, ordinal + 1); return ordinal; }; })(),
        revalidate: () => refreshTrustedContext(request, signal),
        consume: (kind, amount) => {
          if (!Number.isFinite(amount) || amount < 0) throw new Error('budget_invalid');
          usage[kind] += amount;
          if (usage[kind] > limits[kind]) throw new Error('budget_exceeded');
        },
      };
      return { context: Object.freeze(context), usage };
    };

    const graph = new StateGraph(GraphState)
      .addNode('identity', async ({ request }) => {
        const signal = signalFor(request)!;
        const trusted = await bounded(options.hooks.authorize(requestForHook(request)), signal);
        return { actor: trusted.actor, permissions: [...trusted.permissions].sort() };
      })
      .addNode('context', async ({ request, actor }) => ({
        persona: await bounded(options.hooks.loadPersona(actor, signalFor(request)!), signalFor(request)!),
      }))
      .addNode('memory_lookup', async ({ request, actor, persona }) => {
        const memory = await bounded(options.hooks.readMemory(actor, request.userText, signalFor(request)!, request.turnId), signalFor(request)!);
        const baseline = currentBaselines.get(request.turnId);
        const contextFingerprint = fingerprint({ actor, persona, memory, userText: request.userText, permissions: baseline?.permissions });
        if (baseline) baseline.fingerprint = contextFingerprint;
        return { memory, contextFingerprint };
      })
      .addNode('route', async ({ request, actor, permissions, persona, memory, budgetUsage }) => {
        const signal = signalFor(request)!;
        const { context, usage } = makeToolContext(request, actor, permissions, budgetUsage, signal);
        context.consume('steps', 1);
        await context.revalidate?.();
        const decision = await bounded(options.hooks.route({ text: request.userText, persona, memory, actor }, context), signal);
        await context.revalidate?.();
        return { routed: routeDecisionSchema.parse(decision), budgetUsage: usage };
      })
      .addNode('tool_agent', async ({ request, actor, permissions, routed, budgetUsage }) => {
        const decision = routeDecisionSchema.parse(routed);
        const signal = signalFor(request)!;
        const { context, usage } = makeToolContext(request, actor, permissions, budgetUsage, signal);
        context.consume('steps', 1);
        if (decision.kind === 'tool') {
          if (!options.runStore) throw new Error('tool_persistence_required');
          return { routed: await bounded(tools.execute(decision.name, decision.input, context), signal), budgetUsage: usage };
        }
        if (decision.kind === 'agent') {
          if (!options.runStore) throw new Error('tool_persistence_required');
          const result = await bounded(agents.run(decision.name, decision.input, context, tools), signal);
          await context.revalidate?.();
          return { routed: result, budgetUsage: usage };
        }
        return { routed: decision, budgetUsage: usage };
      })
      .addNode('compose', async ({ request, actor, permissions, persona, memory, routed, budgetUsage }) => {
        const signal = signalFor(request)!;
        const { context, usage } = makeToolContext(request, actor, permissions, budgetUsage, signal);
        await context.revalidate?.();
        const content = await bounded(options.hooks.compose({
          userText: request.userText,
          persona,
          memory,
          routed,
          actor,
          signal,
          context,
        }), signal);
        await context.revalidate?.();
        return { content, budgetUsage: usage };
      })
      .addNode('deliver', async ({ request, actor, permissions, content }) => {
        const signal = signalFor(request)!;
        await refreshTrustedContext(request, signal);
        const receipt = await bounded(options.hooks.deliver({
          turnId: request.turnId,
          conversationId: request.conversationId,
          content,
          actor,
          permissions,
          signal,
          operationKey: `turn:${request.turnId}:deliver`,
        }), signal);
        return { deliveryStatus: receipt.status };
      })
      .addNode('finalize', async ({ request, content, deliveryStatus }) => {
        const signal = signalFor(request)!;
        await bounded(options.hooks.finalize?.({ turnId: request.turnId, content, deliveryStatus, operationKey: `turn:${request.turnId}:finalize` }) ?? Promise.resolve(), signal);
        return { finalized: true };
      })
      .addEdge(START, 'identity')
      .addEdge('identity', 'context')
      .addEdge('context', 'memory_lookup')
      .addEdge('memory_lookup', 'route')
      .addEdge('route', 'tool_agent')
      .addEdge('tool_agent', 'compose')
      .addEdge('compose', 'deliver')
      .addEdge('deliver', 'finalize')
      .addEdge('finalize', END)
      .compile({ checkpointer: saver });

    return {
      invoke: async (rawRequest: CompanionGraphRequest) => {
        const parsed = graphRequestSchema.safeParse(rawRequest);
        if (!parsed.success) throw new Error('graph_invalid_input');
        const request = parsed.data as CompanionGraphRequest;
        if (request.principal.kind !== 'person') throw new Error('graph_forbidden');
        const threadId = `turn:${request.turnId}`;
        const config = { configurable: { thread_id: threadId } };
        const snapshot = await graph.getState(config);
        const saved = snapshot.values as Partial<{
          request: CompanionGraphRequest;
          actor: ActorContext;
          permissions: readonly string[];
          persona: string;
          memory: readonly unknown[];
          contextFingerprint: string;
          content: string;
          deliveryStatus: string;
          finalized: boolean;
          deadlineAt: number;
        }>;
        const pending = Array.isArray(snapshot.next) ? snapshot.next as string[] : [];
        const identityPending = pending.includes('identity');
        const deadlineAt = saved.deadlineAt ?? Date.now() + request.budget.timeoutMs;
        const deadlineController = new AbortController();
        const externalAbort = () => deadlineController.abort('graph_cancelled');
        if (request.signal?.aborted) throw new Error('graph_cancelled');
        request.signal?.addEventListener('abort', externalAbort, { once: true });
        const deadlineTimer = setTimeout(() => deadlineController.abort('graph_timeout'), Math.max(0, deadlineAt - Date.now()));
        const signal = deadlineController.signal;
        if (activeTurns.has(request.turnId)) {
          clearTimeout(deadlineTimer);
          request.signal?.removeEventListener('abort', externalAbort);
          throw new Error('graph_turn_busy');
        }
        activeTurns.add(request.turnId);
        activeSignals.set(request.turnId, signal);
        try {
          if (signal.aborted) throw new Error('graph_timeout');
          const trusted = await bounded(options.hooks.authorize(requestForHook(request)), signal);
          const actor = trusted.actor;
          const permissions = [...new Set(trusted.permissions)].sort();
          if (
            !sameActor(actor, request.actor) || request.principal.actor.personId !== actor.personId ||
            actor.characterId !== request.characterId || actor.conversationId !== request.conversationId
          ) throw new Error('graph_forbidden');
          if (saved.request && (
            !saved.request.principal || saved.request.turnId !== request.turnId ||
            saved.request.characterId !== request.characterId || saved.request.conversationId !== request.conversationId ||
            saved.request.userText !== request.userText || !sameActor(saved.request.actor, actor) ||
            (saved.actor !== undefined && !sameActor(saved.actor, actor)) ||
            canonical(principalBinding(saved.request.principal)) !== canonical(principalBinding(request.principal)) ||
            canonical(saved.request.budget) !== canonical(request.budget) ||
            (saved.permissions !== undefined && canonical([...saved.permissions].sort()) !== canonical(permissions)) ||
            ((!saved.actor || !saved.permissions) && !identityPending)
          )) throw new Error('graph_forbidden');

          const persistableRequest: CompanionGraphRequest = {
            ...request,
            actor,
            permissions,
            signal: undefined,
            resume: undefined,
          };
          let update: Record<string, unknown> = {
            request: persistableRequest,
            actor,
            permissions,
            deadlineAt,
          };
          let freshFingerprint: string | undefined;
          if (saved.contextFingerprint) {
            if (typeof saved.persona !== 'string' || !Array.isArray(saved.memory)) throw new Error('graph_checkpoint_invalid');
            const [persona, memory] = await Promise.all([
              bounded(options.hooks.loadPersona(actor, signal), signal),
              bounded(options.hooks.readMemory(actor, request.userText, signal, request.turnId), signal),
            ]);
            freshFingerprint = fingerprint({ actor, persona, memory, userText: request.userText, permissions });
            if (freshFingerprint !== saved.contextFingerprint) throw new Error('graph_context_changed');
            update = { ...update, persona, memory, contextFingerprint: freshFingerprint };
          } else if (saved.request) {
            if (pending.some((node) => !['identity', 'context', 'memory_lookup'].includes(node))) {
              throw new Error('graph_checkpoint_invalid');
            }
          }

          currentBaselines.set(request.turnId, { request: persistableRequest, actor, permissions, ...(freshFingerprint ? { fingerprint: freshFingerprint } : {}) });
          if (saved.deliveryStatus && saved.finalized === true) {
            return Object.freeze({ turnId: request.turnId, content: saved.content, deliveryStatus: saved.deliveryStatus, threadId });
          }

          const command: any = saved.request
            ? (request.resume === undefined ? new Command({ update }) : new Command({ update, resume: request.resume }))
            : { ...update };
          const result = await graph.invoke(command, config);
          return Object.freeze({
            turnId: request.turnId,
            content: result.content,
            deliveryStatus: result.deliveryStatus,
            threadId,
          });
        } finally {
          activeSignals.delete(request.turnId);
          activeTurns.delete(request.turnId);
          currentBaselines.delete(request.turnId);
          clearTimeout(deadlineTimer);
          request.signal?.removeEventListener('abort', externalAbort);
        }
      },
      validatePendingContext: async (turnId: string) => {
        if (!z.string().uuid().safeParse(turnId).success) throw new Error('graph_invalid_input');
        const threadId = `turn:${turnId}`;
        const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
        const saved = snapshot.values as Partial<{
          request: CompanionGraphRequest;
          actor: ActorContext;
          permissions: readonly string[];
          persona: string;
          memory: readonly unknown[];
          contextFingerprint: string;
          content: string;
          deliveryStatus: string;
          finalized: boolean;
        }>;
        if (
          saved.request?.turnId !== turnId || !saved.actor || !saved.permissions ||
          typeof saved.persona !== 'string' || !Array.isArray(saved.memory) ||
          typeof saved.contextFingerprint !== 'string' || !saved.content?.trim() ||
          saved.finalized !== true || !['staged', 'already_staged'].includes(saved.deliveryStatus ?? '')
        ) throw new Error('graph_checkpoint_invalid');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('graph_timeout'), Math.min(30_000, saved.request.budget.timeoutMs));
        try {
          const signal = controller.signal;
          const trusted = await bounded(options.hooks.authorize({ ...saved.request, signal }), signal);
          const permissions = [...new Set(trusted.permissions)].sort();
          if (
            !sameActor(trusted.actor, saved.actor) || !sameActor(saved.request.actor, trusted.actor) ||
            canonical([...saved.permissions].sort()) !== canonical(permissions) ||
            saved.request.principal.kind !== 'person' || saved.request.principal.actor.personId !== trusted.actor.personId
          ) throw new Error('graph_forbidden');
          const [persona, memory] = await Promise.all([
            bounded(options.hooks.loadPersona(trusted.actor, signal), signal),
            bounded(options.hooks.readMemory(trusted.actor, saved.request.userText, signal, turnId), signal),
          ]);
          const freshFingerprint = fingerprint({ actor: trusted.actor, persona, memory, userText: saved.request.userText, permissions });
          if (freshFingerprint !== saved.contextFingerprint) throw new Error('graph_context_changed');
          return Object.freeze({ turnId, threadId, valid: true as const });
        } finally {
          clearTimeout(timer);
        }
      },
      close: async () => saver.end(),
      tools,
      agents,
    };
  } catch (error) {
    await saver.end().catch(() => undefined);
    throw error;
  }
}

class ImmutablePermissions implements ReadonlySet<string> {
  readonly #data: Set<string>;
  constructor(values: Iterable<string>) { this.#data = new Set(values); Object.freeze(this); }
  get size(): number { return this.#data.size; }
  has(value: string): boolean { return this.#data.has(value); }
  union<U>(other: SetLike<U>): Set<string | U> { return new Set([...this.#data, ...setLikeValues(other)]); }
  intersection<U>(other: SetLike<U>): Set<string & U> {
    const result = new Set<string & U>();
    for (const value of this.#data) if (hasSetLikeValue(other, value)) result.add(value);
    return result;
  }
  difference<U>(other: SetLike<U>): Set<string> {
    const result = new Set<string>();
    for (const value of this.#data) if (!hasSetLikeValue(other, value)) result.add(value);
    return result;
  }
  symmetricDifference<U>(other: SetLike<U>): Set<string | U> {
    const result = new Set<string | U>();
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
  entries(): SetIterator<[string, string]> { return this.#data.entries(); }
  keys(): SetIterator<string> { return this.#data.keys(); }
  values(): SetIterator<string> { return this.#data.values(); }
  forEach(callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    this.#data.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
  [Symbol.iterator](): SetIterator<string> { return this.#data[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return 'ImmutablePermissions'; }
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
