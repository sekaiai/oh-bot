import { createHash } from 'node:crypto';
import { ChatOpenAI } from '@langchain/openai';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { modelProfiles, modelRoleBindings } from '../database/schema/index.js';
import type { Budget } from '../domain/contracts.js';
import { PostgresMonthlyUsageStore, type MonthlyUsageStore } from './monthly-usage-store.js';
import type { ChatMessage, ChatReply } from './chat-gateway.js';

export const modelProfileSchema = z.object({
  id: z.string().uuid(),
  characterId: z.string().uuid(),
  enabled: z.boolean(),
  purpose: z.enum(['chat', 'memory', 'search', 'rerank']),
  provider: z.literal('openai'),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(128),
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  maxTokens: z.number().int().positive().max(100_000),
  timeoutMs: z.number().int().min(100).max(3_600_000),
  monthlyBudgetUsd: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable().optional(),
}).strict();
export type ModelProfile = Readonly<z.infer<typeof modelProfileSchema>>;
export type ProfileCompletionInput = Readonly<{
  profileId: string;
  characterId: string;
  purpose: ModelProfile['purpose'];
  messages: readonly ChatMessage[];
  budget: Budget;
  signal: AbortSignal;
}>;
export interface ProfileModel {
  invoke(messages: readonly ChatMessage[], options: { signal: AbortSignal }): Promise<any>;
}
export type ProfileGatewayOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  createModel?: (config: {
    apiKey: string;
    configuration: { baseURL: string };
    model: string;
    timeout: number;
    maxTokens: number;
  }) => ProfileModel;
  boundProfileId?: string;
  estimateCost?: (model: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => number;
  estimateMaxCost?: (model: string, messages: readonly ChatMessage[], maxTokens: number) => number;
  estimateMaxTokens?: (model: string, messages: readonly ChatMessage[], maxCompletionTokens: number) => number;
  monthlyUsage?: MonthlyUsageStore;
  now?: () => Date;
}>;

export function loadProfileCredential(profile: Pick<ModelProfile, 'credentialRef'>, env: NodeJS.ProcessEnv): string {
  const key = env[profile.credentialRef];
  if (!key?.trim() || /^(?:<|\$\{|change-?me|replace[_-]?me|todo)/i.test(key.trim())) {
    throw new Error('model_not_configured');
  }
  return key.trim();
}

function safeModelError(error: unknown): Error {
  return error instanceof Error && error.message === 'model_timeout'
    ? error
    : new Error('model_upstream_error');
}

/** Purpose-bound profile selector. Only explicit profile credentialRef env keys are read. */
export class ModelProfileGateway {
  private readonly profiles = new Map<string, ModelProfile>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly createModel: NonNullable<ProfileGatewayOptions['createModel']>;
  private readonly boundProfileId?: string;
  private readonly estimateCost?: ProfileGatewayOptions['estimateCost'];
  private readonly estimateMaxCost?: ProfileGatewayOptions['estimateMaxCost'];
  private readonly estimateMaxTokens?: ProfileGatewayOptions['estimateMaxTokens'];
  private readonly monthlyUsage?: MonthlyUsageStore;
  private readonly now: () => Date;

  constructor(profiles: readonly ModelProfile[], options: ProfileGatewayOptions = {}) {
    this.env = options.env ?? process.env;
    this.boundProfileId = options.boundProfileId;
    this.estimateCost = options.estimateCost;
    this.estimateMaxCost = options.estimateMaxCost;
    this.estimateMaxTokens = options.estimateMaxTokens;
    this.monthlyUsage = options.monthlyUsage;
    this.now = options.now ?? (() => new Date());
    this.createModel = options.createModel ?? ((config) => new ChatOpenAI({
      apiKey: config.apiKey,
      configuration: config.configuration,
      model: config.model,
      timeout: config.timeout,
      maxTokens: config.maxTokens,
    }) as unknown as ProfileModel);

    for (const rawProfile of profiles) {
      const profile = modelProfileSchema.parse(rawProfile);
      if (this.profiles.has(profile.id)) throw new Error('model_invalid_config');
      this.profiles.set(profile.id, Object.freeze(profile));
    }
  }

  static async fromCharacterBinding(
    database: Database,
    characterId: string,
    purpose: ModelProfile['purpose'],
    options: ProfileGatewayOptions = {},
  ): Promise<ModelProfileGateway> {
    const [row] = await database.db
      .select({
        id: modelProfiles.id,
        purpose: modelProfiles.purpose,
        provider: modelProfiles.provider,
        baseUrl: modelProfiles.baseUrl,
        model: modelProfiles.model,
        credentialRef: modelProfiles.credentialRef,
        enabled: modelProfiles.enabled,
        maxTokens: modelProfiles.maxTokens,
        timeoutMs: modelProfiles.timeoutMs,
        monthlyBudgetUsd: modelProfiles.monthlyBudgetUsd,
      })
      .from(modelRoleBindings)
      .innerJoin(modelProfiles, and(
        eq(modelRoleBindings.profileId, modelProfiles.id),
        eq(modelRoleBindings.purpose, modelProfiles.purpose),
      ))
      .where(and(
        eq(modelRoleBindings.characterId, characterId),
        eq(modelRoleBindings.purpose, purpose),
      ))
      .limit(1);

    if (!row) throw new Error('model_not_configured');
    const parsed = modelProfileSchema.safeParse({ ...row, characterId });
    if (!parsed.success) throw new Error('model_invalid_config');
    return new ModelProfileGateway([parsed.data], {
      ...options,
      monthlyUsage: options.monthlyUsage ?? new PostgresMonthlyUsageStore(database),
      boundProfileId: parsed.data.id,
    });
  }

  async completeBound(input: Omit<ProfileCompletionInput, 'profileId'> & ModelUsageBudget): Promise<ChatReply> {
    if (!this.boundProfileId) throw new Error('model_not_configured');
    return this.complete({ ...input, profileId: this.boundProfileId });
  }

  async testProfile(input: Omit<ProfileCompletionInput, 'profileId'> & ModelUsageBudget): Promise<ChatReply> {
    if (!this.boundProfileId) throw new Error('model_not_configured');
    return this.completeProfile({ ...input, profileId: this.boundProfileId }, true);
  }

  async complete(input: ProfileCompletionInput & ModelUsageBudget): Promise<ChatReply> {
    return this.completeProfile(input, false);
  }

  private async completeProfile(input: ProfileCompletionInput & ModelUsageBudget, allowDisabled: boolean): Promise<ChatReply> {
    const profile = this.profiles.get(input.profileId);
    if (
      !profile || (!profile.enabled && !allowDisabled) || profile.purpose !== input.purpose ||
      profile.characterId !== input.characterId
    ) throw new Error('model_not_configured');

    const endpoint = new URL(profile.baseUrl);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash
    ) throw new Error('model_invalid_config');
    if (input.signal.aborted) throw new Error('model_timeout');

    const credential = loadProfileCredential(profile, this.env);
    if (!this.estimateCost || !this.estimateMaxCost || !this.estimateMaxTokens) throw new Error('model_cost_unavailable');
    const remainingTokens = input.budget.maxTokens - (input.tokensUsed ?? 0);
    if (remainingTokens <= 0) throw new Error('model_budget_exceeded');
    const remainingCost = input.budget.maxCostUsd - (input.costUsdUsed ?? 0);
    if (remainingCost <= 0) throw new Error('model_budget_exceeded');
    const promptTokenUpperBound = this.estimateMaxTokens(profile.model, input.messages, 0);
    if (!Number.isSafeInteger(promptTokenUpperBound) || promptTokenUpperBound < 0) throw new Error('model_cost_unavailable');
    if (promptTokenUpperBound >= remainingTokens) throw new Error('model_budget_exceeded');
    const maxTokens = Math.min(profile.maxTokens, remainingTokens - promptTokenUpperBound);
    const estimatedTotalTokens = this.estimateMaxTokens(profile.model, input.messages, maxTokens);
    if (!Number.isSafeInteger(estimatedTotalTokens) || estimatedTotalTokens < 0) throw new Error('model_cost_unavailable');
    if (estimatedTotalTokens > remainingTokens) throw new Error('model_budget_exceeded');
    const timeoutMs = Math.min(profile.timeoutMs, input.budget.timeoutMs);
    const estimatedReserve = this.estimateMaxCost(profile.model, input.messages, maxTokens);
    if (!Number.isFinite(estimatedReserve) || estimatedReserve < 0) throw new Error('model_cost_unavailable');
    const reserveUsd = roundUsdUp(estimatedReserve);
    if (reserveUsd > remainingCost) throw new Error('model_budget_exceeded');
    let monthlyKey: { profileId: string; month: string; invocationId: string } | undefined;
    if (profile.monthlyBudgetUsd != null) {
      if (!this.monthlyUsage || !input.invocationId) {
        throw new Error('model_monthly_budget_unavailable');
      }
      const date = this.now();
      if (!Number.isFinite(date.getTime())) throw new Error('model_usage_unavailable');
      monthlyKey = { profileId: profile.id, month: date.toISOString().slice(0, 7), invocationId: input.invocationId };
    }
    const controller = new AbortController();
    const abort = () => controller.abort('model_timeout');
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener(
      'abort', () => reject(new Error('model_timeout')),
      { once: true },
    ));

    try {
      if (monthlyKey) {
        const inputHash = createHash('sha256').update(JSON.stringify([
          profile.id,
          profile.purpose,
          profile.model,
          profile.baseUrl,
          profile.credentialRef,
          profile.maxTokens,
          maxTokens,
          input.messages.map((message) => [message.role, message.content]),
        ])).digest('hex');
        const reservation = await Promise.race([
          this.monthlyUsage!.reserve({ ...monthlyKey, amountUsd: reserveUsd, inputHash }),
          aborted,
        ]);
        if (controller.signal.aborted) throw new Error('model_timeout');
        if (reservation.kind === 'unknown') throw new Error('model_usage_unknown');
      }
      if (controller.signal.aborted) throw new Error('model_timeout');
      const model = this.createModel({
        apiKey: credential,
        configuration: { baseURL: profile.baseUrl },
        model: profile.model,
        timeout: timeoutMs,
        maxTokens,
      });
      if (controller.signal.aborted) throw new Error('model_timeout');
      const result = await Promise.race([
        model.invoke(input.messages, {
          signal: controller.signal,
        }),
        aborted,
      ]);
      const text = typeof result?.content === 'string'
        ? result.content
        : Array.isArray(result?.content)
          ? result.content.map((part: { text?: string }) => part.text ?? '').join('')
          : '';
      if (!text.trim()) throw new Error('model_invalid_response');

      const usage = result.usage_metadata;
      const normalizedUsage = usage ? {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      } : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      if (!usage) throw new Error('model_usage_unavailable');
      const estimatedCost = this.estimateCost(profile.model, normalizedUsage);
      if (!Number.isFinite(estimatedCost) || estimatedCost < 0) throw new Error('model_cost_unavailable');
      const cost = roundUsdUp(estimatedCost);
      const reply = Object.freeze({
        text,
        model: result.response_metadata?.model ?? profile.model,
        finishReason: result.response_metadata?.finish_reason ?? null,
        usage: normalizedUsage,
      });
      if (monthlyKey) {
        const settlement = await this.monthlyUsage!.settle({ ...monthlyKey, actualUsd: cost });
        if (settlement.overReserved) throw new Error('model_monthly_budget_exceeded');
      }
      try {
        chargeUsage(input, normalizedUsage, cost, remainingCost);
      } catch (error) {
        if (error instanceof Error && error.message === 'budget_exceeded') throw new Error('model_budget_exceeded');
        throw error;
      }
      return reply;
    } catch (error) {
      if (error instanceof Error && [
        'model_invalid_response', 'model_usage_unavailable', 'model_usage_unknown', 'model_cost_unavailable', 'model_monthly_budget_exceeded', 'model_budget_exceeded', 'budget_exceeded',
      ].includes(error.message)) throw error;
      if (controller.signal.aborted) throw new Error('model_timeout');
      throw safeModelError(error);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
    }
  }
}

export type ModelUsageBudget = Readonly<{
  tokensUsed: number;
  costUsdUsed: number;
  invocationId?: string;
  consume: (kind: 'tokens' | 'costUsd', amount: number) => void;
}>;

function chargeUsage(
  input: ModelUsageBudget,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  cost: number,
  remainingCost: number,
): void {
  input.consume('tokens', usage.totalTokens);
  input.consume('costUsd', cost);
  if (cost > remainingCost) throw new Error('model_budget_exceeded');
}

function roundUsdUp(value: number): number {
  return Math.ceil(value * 100_000_000) / 100_000_000;
}
