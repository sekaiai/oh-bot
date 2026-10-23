import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { characters, conversationMembers, conversations, deletionRecords, jobLogs, memoryIndexes, memorySources, modelProfiles, messages, people, platformIdentities } from '../src/database/schema/index.js';
import { createMemoryRuntime } from '../src/application/memory-runtime.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { initializeDeletionJournal } from '../src/memory/memory-deletion-journal.js';
import type { Mem0Config } from '../src/memory/mem0-adapter.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';

test('memory runtime resolves active and retired collections by their embedding profiles and fails closed without credentials', async () => {
  const databaseUrl = requireCompatDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const directory = await mkdtemp(join(tmpdir(), 'oh-memory-runtime-'));
  const journalPath = join(directory, 'deletions.jsonl');
  const suffix = uuid();
  const characterId = uuid(); const personPlatformId = `runtime-person-${suffix}`; const conversationId = uuid();
  const messageId = uuid(); const firstIndexId = uuid(); const secondIndexId = uuid();
  const firstProfileId = uuid(); const secondProfileId = uuid();
  const collectionCalls = new Map<string, { searches: number; deleted: string[]; history: string[]; getAll: (runId: string) => { id: string; memory: string }[] }>();
  const configs: Mem0Config[] = [];
  const createEngine = async (config: Mem0Config) => {
    configs.push(config);
    const calls = collectionCalls.get(config.collectionName) ?? { searches: 0, deleted: [], history: [], getAll: (_runId: string) => [] as { id: string; memory: string }[] };
    collectionCalls.set(config.collectionName, calls);
    return {
      add: async () => ({ results: [] }),
      search: async () => { calls.searches++; return { results: [] }; },
      getAll: async ({ filters }: { filters?: { run_id?: string } }) => ({ results: calls.getAll(filters?.run_id ?? '') }),
      get: async (id: string) => ({ id, memory: 'fixture memory' }),
      delete: async (id: string) => { calls.deleted.push(id); return { message: 'deleted' }; },
      deleteHistory: async (id: string) => { calls.history.push(id); return 1; },
      close: async () => undefined,
    };
  };
  const env: NodeJS.ProcessEnv = {
    COMPANION_MEMORY_CHAT_API_URL: 'http://127.0.0.1:1111/v1', COMPANION_MEMORY_CHAT_API_KEY: 'memory-chat-fixture', COMPANION_MEMORY_CHAT_MODEL: 'memory-chat',
    COMPANION_MEMORY_EMBEDDING_API_URL: 'http://127.0.0.1:2222/v1', COMPANION_MEMORY_EMBEDDING_API_KEY: 'fallback-embedding-fixture', COMPANION_MEMORY_EMBEDDING_MODEL: 'fallback-embedding',
    COMPANION_MEMORY_EMBEDDING_DIMENSIONS: '8', COMPANION_MEMORY_HISTORY_PATH: join(directory, 'history.sqlite'), COMPANION_MEMORY_COLLECTION: 'companion_memory_primary',
    INDEX_EMBEDDING_KEY: 'index-embedding-fixture',
  };
  try {
    await migrateDatabase(database);
    await initializeDeletionJournal(journalPath);
    await database.db.insert(characters).values({ id: characterId, name: `runtime-${suffix}` });
    const identity = await new IdentityService(database).resolveIdentity(
      { platform: 'qq', platformUserId: personPlatformId },
      createVerifiedChannelEvidence('qq', `runtime-channel-${suffix}`, personPlatformId, 'private'),
    );
    await database.db.insert(conversations).values({ id: conversationId, characterId, platform: 'qq', platformConversationId: `runtime-channel-${suffix}`, kind: 'private' });
    await database.db.insert(conversationMembers).values({ conversationId, personId: identity.personId, confirmedAt: new Date() });
    await database.db.insert(messages).values({ id: messageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `runtime-${suffix}`, role: 'user', text: 'A source for runtime index resolution.' });
    const profileValues = [
      { id: firstProfileId, name: `runtime embedding one ${suffix}`, purpose: 'embedding' as const, provider: 'openai', baseUrl: 'http://127.0.0.1:3333/v1', model: 'embedding-v1', credentialRef: 'INDEX_EMBEDDING_KEY', dimensions: 8, enabled: true },
      { id: secondProfileId, name: `runtime embedding two ${suffix}`, purpose: 'embedding' as const, provider: 'openai', baseUrl: 'http://127.0.0.1:4444/v1', model: 'embedding-v2', credentialRef: 'INDEX_EMBEDDING_KEY', dimensions: 8, enabled: true },
    ];
    await database.db.insert(modelProfiles).values(profileValues);
    await database.db.insert(memoryIndexes).values([
      { id: firstIndexId, characterId, modelProfileId: firstProfileId, provider: 'openai', model: 'embedding-v1', dimensions: 8, preprocessingVersion: 'v1', collectionName: `companion_memory_rt_${suffix.replaceAll('-', '').slice(0, 20)}_one`, status: 'active' },
      { id: secondIndexId, characterId, modelProfileId: secondProfileId, provider: 'openai', model: 'embedding-v2', dimensions: 8, preprocessingVersion: 'v1', collectionName: `companion_memory_rt_${suffix.replaceAll('-', '').slice(0, 20)}_two`, status: 'building' },
    ]);
    const runtime = await createMemoryRuntime(database, { databaseUrl, deletionJournalPath: journalPath, env, createEngine });
    assert.ok(runtime);
    const evidence = createVerifiedChannelEvidence('qq', `runtime-channel-${suffix}`, personPlatformId, 'private');
    const actor = await new IdentityService(database).resolveActorContext({ platform: 'qq', platformUserId: personPlatformId, characterId, conversationId }, evidence);
    const source = await runtime.gateway.record(actor, messageId);

    await runtime.gateway.recall(actor, 'runtime query');
    const firstCollection = profileValues[0] && `companion_memory_rt_${suffix.replaceAll('-', '').slice(0, 20)}_one`;
    const secondCollection = `companion_memory_rt_${suffix.replaceAll('-', '').slice(0, 20)}_two`;
    assert.equal(collectionCalls.get(firstCollection!)?.searches, 1);
    assert.equal(configs.find((config) => config.collectionName === firstCollection)?.embedding.apiKey, 'index-embedding-fixture');
    assert.equal(configs.find((config) => config.collectionName === firstCollection)?.initializeHistory, false);

    await database.db.update(memoryIndexes).set({ status: 'retired' }).where(eq(memoryIndexes.id, firstIndexId));
    await database.db.update(memoryIndexes).set({ status: 'active' }).where(eq(memoryIndexes.id, secondIndexId));
    await runtime.gateway.recall(actor, 'runtime query after activation');
    assert.equal(collectionCalls.get(secondCollection)?.searches, 1, 'new active index is selected for recall');

    collectionCalls.get(firstCollection!)!.getAll = (runId) => runId === source.id ? [{ id: `retired-${suffix}`, memory: 'retired collection orphan' }] : [];
    collectionCalls.get(secondCollection)!.getAll = (runId) => runId === source.id ? [{ id: `active-${suffix}`, memory: 'active collection orphan' }] : [];
    await runtime.gateway.forget(actor, source.id);
    const result = await runtime.gateway.processDeletions();
    assert.equal(result.processed, 1, JSON.stringify(result));
    assert.equal(result.failed, 0);
    const appliedRecord = (await database.db.select({ sourceIds: deletionRecords.sourceIds, memoryIds: deletionRecords.memoryIds }).from(deletionRecords)).find((row) => row.sourceIds.includes(source.id));
    assert.deepEqual(collectionCalls.get(firstCollection!)?.deleted, [`retired-${suffix}`], JSON.stringify({ first: collectionCalls.get(firstCollection!), record: appliedRecord }));
    assert.deepEqual(collectionCalls.get(secondCollection)?.deleted, [`active-${suffix}`]);
    assert.ok(configs.every((config) => config.historyPath === join(directory, 'history.sqlite')));
    await runtime.close();

    const missingCredentialEnv = { ...env };
    delete missingCredentialEnv.INDEX_EMBEDDING_KEY;
    const noCredentialRuntime = await createMemoryRuntime(database, { databaseUrl, deletionJournalPath: journalPath, env: missingCredentialEnv, createEngine });
    assert.ok(noCredentialRuntime);
    const degraded = await noCredentialRuntime.gateway.recall(actor, 'query without embedding key');
    assert.equal(degraded.degraded, true);
    assert.equal(collectionCalls.get('companion_memory_primary')?.searches, 0, 'missing profile credentials never fall back to the primary collection');
    await noCredentialRuntime.close();
  } finally {
    const [source] = await database.db.select().from(memorySources).where(eq(memorySources.messageId, messageId));
    if (source) {
      const tombstones = (await database.db.select().from(deletionRecords)).filter((row) => row.sourceIds.includes(source.id));
      if (tombstones.length) {
        await database.db.delete(jobLogs).where(inArray(jobLogs.operationKey, tombstones.map((row) => `mem0-delete:${row.id}`)));
        await database.db.delete(deletionRecords).where(inArray(deletionRecords.id, tombstones.map((row) => row.id)));
      }
      await database.db.delete(jobLogs).where(eq(jobLogs.operationKey, `mem0-sync:${source.id}`));
      await database.db.delete(memorySources).where(eq(memorySources.id, source.id));
    }
    await database.db.delete(messages).where(eq(messages.id, messageId));
    await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
    await database.db.delete(conversations).where(eq(conversations.id, conversationId));
    const identities = await database.db.select({ id: platformIdentities.id, personId: platformIdentities.personId }).from(platformIdentities).where(eq(platformIdentities.platformUserId, personPlatformId));
    if (identities.length) {
      await database.db.delete(platformIdentities).where(eq(platformIdentities.id, identities[0]!.id));
      await database.db.delete(people).where(eq(people.id, identities[0]!.personId));
    }
    await database.db.delete(memoryIndexes).where(eq(memoryIndexes.characterId, characterId));
    await database.db.delete(modelProfiles).where(eq(modelProfiles.id, firstProfileId));
    await database.db.delete(modelProfiles).where(eq(modelProfiles.id, secondProfileId));
    await database.db.delete(characters).where(eq(characters.id, characterId));
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
