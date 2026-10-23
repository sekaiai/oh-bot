import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { agentRuns, operationKeys, toolRuns } from '../database/schema/index.js';
import type { ToolInvocationStore } from './registry.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Persists tool/agent runs and atomically fences external actions with operation_keys. */
export class PostgresToolInvocationStore implements ToolInvocationStore {
  constructor(private readonly database: Database, private readonly leaseMs = 30_000) {}

  async beginTool(
    input: Parameters<ToolInvocationStore['beginTool']>[0],
  ): Promise<Awaited<ReturnType<ToolInvocationStore['beginTool']>>> {
    return this.database.db.transaction(async (transaction) => {
      if (input.permission === 'external_action') {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
        const owner = randomUUID();
        await transaction.insert(operationKeys).values({
          key: input.operationKey,
          kind: `tool:${input.name}`,
          status: 'leased',
          leaseOwner: owner,
          leaseExpiresAt,
        }).onConflictDoNothing();

        const [key] = await transaction.select().from(operationKeys)
          .where(eq(operationKeys.key, input.operationKey)).for('update').limit(1);
        if (!key) throw new Error('tool_store_unavailable');
        if (key.kind !== `tool:${input.name}`) throw new Error('tool_operation_conflict');

        if (key.status === 'completed') {
          const [row] = await transaction.select().from(toolRuns)
            .where(eq(toolRuns.id, key.resultRef ?? '')).limit(1);
          if (!row || row.inputHash !== hash(input.input)) throw new Error('tool_operation_conflict');
          if (row.status === 'completed') return { kind: 'cached', runId: row.id, result: row.result };
          return { kind: 'unknown', runId: row.id };
        }

        // A prior lease may have crossed the side-effect boundary before a crash. Never resend it.
        if (key.leaseOwner !== owner) return { kind: 'unknown' };
      }

      const [existing] = await transaction.select().from(toolRuns)
        .where(eq(toolRuns.operationKey, input.operationKey)).for('update').limit(1);
      if (existing) {
        if (existing.inputHash !== hash(input.input)) throw new Error('tool_operation_conflict');
        if (existing.status === 'completed') {
          return { kind: 'cached', runId: existing.id, result: existing.result };
        }
        return { kind: 'unknown', runId: existing.id };
      }

      const [row] = await transaction.insert(toolRuns).values({
        ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        turnId: input.turnId,
        name: input.name,
        operationKey: input.operationKey,
        permission: input.permission,
        status: 'running',
        inputHash: hash(input.input),
        usage: { budget: input.budget },
      }).returning({ id: toolRuns.id });
      if (!row) throw new Error('tool_store_unavailable');
      return { kind: 'execute', runId: row.id };
    });
  }

  async finishTool(input: Parameters<ToolInvocationStore['finishTool']>[0]): Promise<void> {
    await this.database.db.transaction(async (transaction) => {
      const status = input.unknown ? 'receipt_unknown' : input.errorCode ? 'failed' : 'completed';
      const [row] = await transaction.update(toolRuns).set({
        status,
        result: input.result ?? null,
        usage: input.usage ?? {},
        errorCode: input.errorCode ?? null,
        updatedAt: new Date(),
        version: sql`${toolRuns.version} + 1`,
      }).where(and(
        eq(toolRuns.id, input.runId),
        eq(toolRuns.status, 'running'),
      )).returning({ id: toolRuns.id, permission: toolRuns.permission });
      if (!row || row.permission !== 'external_action' || status !== 'completed') return;

      await transaction.update(operationKeys).set({
        status: 'completed',
        resultRef: row.id,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
        version: sql`${operationKeys.version} + 1`,
      }).where(eq(operationKeys.key, input.operationKey));
    });
  }

  async beginAgent(input: Parameters<ToolInvocationStore['beginAgent']>[0]): Promise<string> {
    const [existing] = await this.database.db.select().from(agentRuns).where(and(
      eq(agentRuns.turnId, input.turnId),
      eq(agentRuns.threadId, input.threadId),
    )).limit(1);
    if (existing) {
      const expectedTask = { name: input.name, input: input.task };
      if (
        existing.characterId !== input.actor.characterId || existing.personId !== input.actor.personId ||
        existing.conversationId !== input.actor.conversationId || canonical(existing.task) !== canonical(expectedTask)
      ) throw new Error('agent_operation_conflict');
      return existing.id;
    }
    const [row] = await this.database.db.insert(agentRuns).values({
      characterId: input.actor.characterId,
      personId: input.actor.personId,
      conversationId: input.actor.conversationId,
      turnId: input.turnId,
      graphVersion: 'companion-graph-v1',
      threadId: input.threadId,
      status: 'running',
      task: { name: input.name, input: input.task },
      budget: input.budget,
      usage: { budget: input.budget, ...(input.usage ?? {}) },
    }).returning({ id: agentRuns.id });
    if (!row) throw new Error('agent_store_unavailable');
    return row.id;
  }

  async finishAgent(input: Parameters<ToolInvocationStore['finishAgent']>[0]): Promise<void> {
    await this.database.db.update(agentRuns).set({
      status: input.cancelled ? 'cancelled' : input.errorCode ? 'failed' : 'completed',
      result: input.result ?? null,
      usage: input.usage ?? {},
      errorCode: input.errorCode ?? null,
      updatedAt: new Date(),
      version: sql`${agentRuns.version} + 1`,
    }).where(eq(agentRuns.id, input.runId));
  }
}
