import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { characters, conversations, conversationMembers, memoryIndexes, memoryMappings, memoryRevisions, memoryValidationRecords, modelProfiles, messages } from '../src/database/schema/index.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { activateMemoryIndex, beginMemoryIndex, rebuildMemoryIndex } from '../src/memory/memory-index.js';
import { createMem0Memory } from '../src/memory/mem0-adapter.js';
import { MemoryLifecycleService } from '../src/memory/memory-lifecycle-service.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';
import { initializeDeletionJournal } from '../src/memory/memory-deletion-journal.js';

test('rebuilds nonempty 8- and 16-dimension Mem0 indexes and activates only populated current revisions', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-index-'));
  const journalPath = path.join(directory, 'deletions.jsonl');
  const suffix = uuid();
  const characterId = uuid();
  const conversationId = uuid();
  const messageId = uuid();
  const userId = `memory-index-${suffix}`;
  const opened: Array<{ close(): Promise<void>; delete(id: string): Promise<unknown>; search(query: string, options?: unknown): Promise<{ results: Array<{ id: string }> }> }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body || '{}').input;
    const values = Array.isArray(input) ? input : [input];
    const model = JSON.parse(body || '{}').model;
    const dimensions = String(model).includes('16') ? 16 : 8;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: values.map((_, index) => ({ object: 'embedding', index, embedding: [1, ...Array(dimensions - 1).fill(0)] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await initializeDeletionJournal(journalPath);
    await migrateDatabase(database);
    const identities = new IdentityService(database);
    const evidence = createVerifiedChannelEvidence('qq', `memory-index-${suffix}`, userId, 'private');
    const identity = await identities.resolveIdentity({ platform: 'qq', platformUserId: userId }, evidence);
    await database.db.insert(characters).values({ id: characterId, name: `memory-index-${suffix}` });
    await database.db.insert(conversations).values({ id: conversationId, characterId, platform: 'qq', platformConversationId: `memory-index-${suffix}`, kind: 'private' });
    await database.db.insert(conversationMembers).values({ conversationId, personId: identity.personId, confirmedAt: new Date() });
    await database.db.insert(messages).values({ id: messageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `memory-index-${suffix}`, role: 'user', text: '我喜欢清晨喝茶。' });
    const actor = await identities.resolveActorContext({ platform: 'qq', platformUserId: userId, characterId, conversationId }, evidence);
    const lifecycle = new MemoryLifecycleService(database);
    const source = await lifecycle.recordUserSource(actor, messageId);
    const candidate = await lifecycle.recordCandidate(actor, { sourceId: source.id, canonicalKey: `person.preference.tea.${suffix}`, factText: '喜欢清晨喝茶。', engineMemoryId: `source-memory-${suffix}` });
    let revision = (await database.db.update(memoryRevisions).set({ status: 'validated', version: candidate.version + 1 }).where(eq(memoryRevisions.id, candidate.id)).returning())[0]!;
    await database.db.update(memoryValidationRecords).set({ status: 'validated', evidenceQuote: '我喜欢清晨喝茶' }).where(eq(memoryValidationRecords.engineMemoryId, candidate.engineMemoryId!));
    assert.ok(revision);

    const profiles: Array<typeof modelProfiles.$inferSelect> = [];
    for (const dimensions of [8, 16]) {
      const [profile] = await database.db.insert(modelProfiles).values({ name: `memory-index-${dimensions}-${suffix}`, purpose: 'embedding', provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: `fixture-embedding-${dimensions}`, credentialRef: 'fixture', dimensions, enabled: true }).returning();
      assert.ok(profile);
      profiles.push(profile);
    }
    const base = { characterId, preprocessingVersion: 'v1' };
    const indexes: Array<typeof memoryIndexes.$inferSelect> = [];
    for (const [position, dimensions] of [8, 16].entries()) {
      const profile = profiles[position]!;
      const index = await beginMemoryIndex(database, {
        ...base, modelProfileId: profile.id, provider: profile.provider, model: profile.model,
        dimensions, collectionName: `companion_memory_${suffix.replaceAll('-', '').slice(0, 24)}_${dimensions}`,
      });
      indexes.push(index);
      const engine = await createMem0Memory({
        chat: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-chat', model: 'fixture-chat' },
        embedding: { baseUrl: profile.baseUrl, apiKey: 'fixture-embedding', model: profile.model, dimensions },
        databaseUrl: requireCompatDatabaseUrl(), historyPath: path.join(directory, `history-${dimensions}.db`),
        initializeHistory: true, collectionName: index.collectionName,
      });
      opened.push(engine as never);
      await assert.rejects(rebuildMemoryIndex(database, index.id, async (target, selectedProfile) => ({
        engine: engine as never,
        configuration: {
          indexId: target.id, collectionName: `${target.collectionName}_wrong`, provider: selectedProfile.provider,
          model: selectedProfile.model, dimensions: selectedProfile.dimensions!, preprocessingVersion: target.preprocessingVersion,
        },
      }), journalPath), /configuration does not match/);
      await rebuildMemoryIndex(database, index.id, async (target, selectedProfile) => ({
        engine: engine as never,
        configuration: {
          indexId: target.id, collectionName: target.collectionName, provider: selectedProfile.provider,
          model: selectedProfile.model, dimensions: selectedProfile.dimensions!, preprocessingVersion: target.preprocessingVersion,
        },
      }), journalPath);
      const firstPassMappings = await database.db.select().from(memoryMappings).where(eq(memoryMappings.indexId, index.id));
      assert.equal(firstPassMappings.length, 1);
      await database.db.delete(memoryMappings).where(eq(memoryMappings.indexId, index.id));
      assert.deepEqual(await rebuildMemoryIndex(database, index.id, async (target, selectedProfile) => ({
        engine: engine as never,
        configuration: {
          indexId: target.id, collectionName: target.collectionName, provider: selectedProfile.provider,
          model: selectedProfile.model, dimensions: selectedProfile.dimensions!, preprocessingVersion: target.preprocessingVersion,
        },
      }), journalPath), { indexed: 1, skipped: 0 });
      const recoveredMappings = await database.db.select().from(memoryMappings).where(eq(memoryMappings.indexId, index.id));
      assert.equal(recoveredMappings[0]?.engineMemoryId, firstPassMappings[0]?.engineMemoryId);
      assert.deepEqual(await rebuildMemoryIndex(database, index.id, async (target, selectedProfile) => ({
        engine: engine as never,
        configuration: {
          indexId: target.id, collectionName: target.collectionName, provider: selectedProfile.provider,
          model: selectedProfile.model, dimensions: selectedProfile.dimensions!, preprocessingVersion: target.preprocessingVersion,
        },
      }), journalPath), { indexed: 0, skipped: 1 });
      const mappings = await database.db.select().from(memoryMappings).where(eq(memoryMappings.indexId, index.id));
      assert.equal(mappings.length, 1);
      assert.equal(mappings[0]?.revisionId, revision.id);
      assert.ok(mappings[0]?.engineMemoryId);
      const stored = await engine.get(mappings[0]!.engineMemoryId);
      assert.ok(stored);
      assert.match(JSON.stringify(stored), position === 0 ? /喜欢清晨喝茶/ : /喜欢绿茶/);
      await activateMemoryIndex(database, index.id, journalPath);
      if (position === 0) {
        const correctionMessageId = uuid();
        await database.db.insert(messages).values({ id: correctionMessageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `memory-index-correction-${suffix}`, role: 'user', text: '更正：我其实更喜欢绿茶。' });
        revision = await lifecycle.correctRevision(actor, { revisionId: revision.id, expectedVersion: revision.version, messageId: correctionMessageId, factText: '更喜欢绿茶。' });
      }
    }
    const rows = await database.db.select().from(memoryIndexes).where(eq(memoryIndexes.characterId, characterId));
    assert.equal(rows.find((row) => row.id === indexes[0]?.id)?.status, 'retired');
    assert.equal(rows.find((row) => row.id === indexes[1]?.id)?.status, 'active');
    await assert.rejects(beginMemoryIndex(database, { ...base, modelProfileId: profiles[0]!.id, provider: 'openai', model: profiles[0]!.model, dimensions: 0, collectionName: `companion_memory_${suffix.replaceAll('-', '').slice(0, 24)}_bad` }), /invalid memory index spec/);
  } finally {
    for (const engine of opened) await engine.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
