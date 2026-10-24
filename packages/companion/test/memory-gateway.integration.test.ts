import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { characters, commitments, conversationMembers, conversations, deliveryOutbox, deletionRecords, jobLogs, knowledgeClaims, memoryRevisions, memorySources, messages, personEntities, relationshipEdges, turns } from '../src/database/schema/index.js';
import { MemoryLifecycleService } from '../src/memory/memory-lifecycle-service.js';
import { MemoryReadService } from '../src/memory/memory-read-service.js';
import { MemoryGateway } from '../src/memory/memory-gateway.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';
import { appendDeletionJournal, initializeDeletionJournal } from '../src/memory/memory-deletion-journal.js';
import { AdminGuard } from '../src/admin/auth.js';

test('record persists trusted source and asynchronous job without invoking Mem0', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const journalDir = await mkdtemp(path.join(os.tmpdir(), 'companion-gateway-journal-'));
  const suffix = uuid(), userId = `memory-gateway-${suffix}`, characterId = uuid(), conversationId = uuid(), messageId = uuid();
  let recallSourceIds: string[] = [];
  let recallMessageId: string | undefined;
  try {
    await migrateDatabase(database);
    const identities = new IdentityService(database);
    const evidence = createVerifiedChannelEvidence('qq', suffix, userId, 'private');
    const identity = await identities.resolveIdentity({ platform: 'qq', platformUserId: userId }, evidence);
    await database.db.insert(characters).values({ id: characterId, name: `gateway-${suffix}` });
    await database.db.insert(conversations).values({ id: conversationId, characterId, platform: 'qq', platformConversationId: suffix, kind: 'private' });
    await database.db.insert(conversationMembers).values({ conversationId, personId: identity.personId, confirmedAt: new Date() });
    await database.db.insert(messages).values({ id: messageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: suffix, role: 'user', text: '我喜欢清晨喝茶。' });
    const actor = await identities.resolveActorContext({ platform: 'qq', platformUserId: userId, characterId, conversationId }, evidence);
    let sdkCalls = 0;
    const addsBySource = new Map<string, number>();
    const orphanResultsByRun = new Map<string, { id: string; memory: string }[]>();
    const deletedIds: string[] = [];
    const engine = { add: async (_text: string, options: { runId: string }) => { sdkCalls++; addsBySource.set(options.runId, (addsBySource.get(options.runId) ?? 0) + 1); return { results: [] }; }, search: async () => ({ results: [] }), getAll: async ({ filters }: { filters?: { run_id?: string } }) => ({ results: orphanResultsByRun.get(filters?.run_id ?? '') ?? [] }), get: async (id: string) => ({ id }), delete: async (id: string) => { deletedIds.push(id); }, deleteHistory: async () => 0 } as never;
    const journalPath = path.join(journalDir, 'deletions.jsonl');
    await initializeDeletionJournal(journalPath);
    const lifecycle = new MemoryLifecycleService(database);
    const gateway = new MemoryGateway(database, lifecycle, new MemoryReadService(database), engine, async () => actor, journalPath);
    const source = await gateway.record(actor, messageId);
    assert.equal(source.messageId, messageId);
    assert.equal(sdkCalls, 0);
    const jobs = await database.db.select().from(jobLogs);
    assert.ok(jobs.some((job) => job.operationKey === `mem0-sync:${source.id}` && job.status === 'pending'));
    const journalFailureGateway = new MemoryGateway(database, lifecycle, new MemoryReadService(database), engine, async () => actor, path.join(journalDir, 'missing', 'deletions.jsonl'));
    await assert.rejects(journalFailureGateway.forget(actor, source.id));
    assert.equal((await database.db.select().from(memorySources).where(eq(memorySources.id, source.id)))[0]?.status, 'active', 'a journal fsync failure rolls back the business deletion');
    await database.db.update(jobLogs).set({ createdAt: new Date(0) }).where(eq(jobLogs.operationKey, `mem0-sync:${source.id}`));
    recallMessageId = uuid();
    await database.db.insert(messages).values({ id: recallMessageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `recall-tail-${suffix}`, role: 'user', text: '我喜欢项目星河。' });
    const recallSources = Array.from({ length: 1001 }, (_, index) => ({
      characterId, personId: identity.personId, conversationId, messageId: recallMessageId!, sourceKind: 'user' as const,
      batchKey: `recall-tail-${suffix}-${index}`, scope: { kind: 'person_private' as const, personId: identity.personId },
      subjectPersonIds: [identity.personId], speakerPersonId: identity.personId, participantPersonIds: [identity.personId],
      claimKind: 'direct' as const, allowedForExtraction: true,
    }));
    const insertedSources = await database.db.insert(memorySources).values(recallSources).returning({ id: memorySources.id });
    recallSourceIds = insertedSources.map((item) => item.id);
    await database.db.insert(memoryRevisions).values(recallSourceIds.map((sourceId, index) => ({
      characterId, canonicalKey: `recall-tail-${suffix}-${index}`, revision: 1, sourceId, engineMemoryId: null,
      factText: index === 0 ? '我喜欢项目星河。' : `无关事实${index}`, scope: { kind: 'person_private' as const, personId: identity.personId },
      subjectPersonIds: [identity.personId], status: 'validated' as const, validFrom: new Date(Date.now() - 1001_000 + index),
    })));
    const tailRecall = await gateway.recall(actor, '项目星河');
    assert.equal(tailRecall.results.length, 1);
    assert.equal(tailRecall.results[0]?.factText, '我喜欢项目星河。', 'a relevant fact beyond the newest 1000 is ranked from query-selected candidates');
    let searchStarted!: () => void;
    let releaseSearch!: () => void;
    const started = new Promise<void>((resolve) => { searchStarted = resolve; });
    const waiting = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const pausingEngine = {
      add: async () => ({ results: [] }),
      search: async () => { searchStarted(); await waiting; return { results: [] }; },
      getAll: async () => ({ results: [] }),
      get: async (id: string) => ({ id }), delete: async () => undefined, deleteHistory: async () => 0,
    } as never;
    const pausedGateway = new MemoryGateway(database, lifecycle, new MemoryReadService(database), pausingEngine, async () => actor, journalPath);
    const pendingRecall = pausedGateway.recall(actor, '项目星河');
    await started;
    await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
    releaseSearch();
    await assert.rejects(pendingRecall, /confirmed conversation member/, 'recall rechecks membership after asynchronous search');
    await database.db.insert(conversationMembers).values({ conversationId, personId: identity.personId, confirmedAt: new Date() });
    const failedBacklogKeys = Array.from({ length: 25 }, () => `mem0-sync:${uuid()}`);
    await database.db.insert(jobLogs).values(failedBacklogKeys.map((operationKey) => ({ operationKey, queueName: 'memory_sync', status: 'failed' as const, attempts: 8, nextRunAt: new Date(Date.now() + 60_000) })));
    const workerResults = await Promise.all([gateway.processPending(), gateway.processPending()]);
    assert.equal(workerResults.length, 2);
    assert.equal(addsBySource.get(source.id), 1, 'concurrent workers must not duplicate a live lease');
    const [sourceEntity, sharedEntity, otherEntity] = await database.db.insert(personEntities).values([
      { characterId, displayName: `Forgotten ${suffix}`, aliases: [`old-${suffix}`] },
      { characterId, displayName: `Shared ${suffix}`, aliases: [`shared-${suffix}`] },
      { characterId, displayName: `Other ${suffix}` },
    ]).returning();
    const otherEvidenceMessageId = uuid();
    await database.db.insert(messages).values({ id: otherEvidenceMessageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `other-edge-${suffix}`, role: 'user', text: '另一个仍有效的关系证据。' });
    const turnId = uuid(), assistantMessageId = uuid();
    await database.db.insert(turns).values({ id: turnId, conversationId, inboundMessageId: messageId, personId: identity.personId, graphThreadId: `forget-${suffix}` });
    await database.db.insert(messages).values({ id: assistantMessageId, conversationId, personId: null, platform: 'qq', platformEventId: `generated:${turnId}`, role: 'assistant', text: '我记得你喜欢清晨喝茶。' });
    const [historicalClaim] = await database.db.insert(knowledgeClaims).values({ characterId, speakerPersonId: identity.personId, sourceId: source.id, claimText: '清晨喜欢喝茶', status: 'refuted', scope: source.scope, validFrom: new Date(Date.now() - 1000), validTo: new Date(Date.now() - 500) }).returning();
    const [scheduledCommitment] = await database.db.insert(commitments).values({ characterId, personId: identity.personId, conversationId, description: '提醒：清晨喝茶', sourceMessageId: messageId, dueAt: new Date(Date.now() + 60_000), status: 'scheduled', operationKey: `forgotten-commitment:${suffix}` }).returning();
    const [pendingDelivery] = await database.db.insert(deliveryOutbox).values({ turnId, conversationId, operationKey: `turn:${turnId}:deliver`, content: { text: '我记得你喜欢清晨喝茶。' }, status: 'pending' }).returning();
    const [forgottenEdge] = await database.db.insert(relationshipEdges).values({ characterId, subjectEntityId: sourceEntity!.id, objectEntityId: sharedEntity!.id, kind: 'knows', status: 'confirmed', sourceMessageId: messageId, validFrom: new Date() }).returning();
    await database.db.insert(relationshipEdges).values({ characterId, subjectEntityId: sharedEntity!.id, objectEntityId: otherEntity!.id, kind: 'knows', status: 'confirmed', sourceMessageId: otherEvidenceMessageId, validFrom: new Date() });
    const orphanIds = Array.from({ length: 105 }, (_, index) => `orphan-${suffix}-${index}`);
    orphanResultsByRun.set(source.id, orphanIds.map((id) => ({ id, memory: 'orphaned source memory' })));
    await gateway.forget(actor, source.id);
    const [erasedSourceMessage] = await database.db.select().from(messages).where(eq(messages.id, messageId));
    assert.equal(erasedSourceMessage?.text, null, 'forget redacts raw conversation history before returning');
    assert.equal((await database.db.select().from(messages).where(eq(messages.id, assistantMessageId)))[0]?.text, null, 'forget redacts prior generated assistant echoes in the source turn');
    const [erasedOldClaim] = await database.db.select().from(knowledgeClaims).where(eq(knowledgeClaims.id, historicalClaim!.id));
    assert.equal(erasedOldClaim?.claimText, null, 'superseded derived claims are erased too');
    const [cancelledCommitment] = await database.db.select().from(commitments).where(eq(commitments.id, scheduledCommitment!.id));
    assert.equal(cancelledCommitment?.description, null);
    assert.equal(cancelledCommitment?.status, 'cancelled');
    const [cancelledDelivery] = await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, pendingDelivery!.id));
    assert.equal(cancelledDelivery?.status, 'failed');
    assert.deepEqual(cancelledDelivery?.content, {});
    const [erasedEdge] = await database.db.select().from(relationshipEdges).where(eq(relationshipEdges.id, forgottenEdge!.id));
    assert.equal(erasedEdge?.status, 'superseded');
    const [erasedEntity] = await database.db.select().from(personEntities).where(eq(personEntities.id, sourceEntity!.id));
    const [sharedLabel] = await database.db.select().from(personEntities).where(eq(personEntities.id, sharedEntity!.id));
    assert.equal(erasedEntity?.displayName, '[forgotten]');
    assert.equal(erasedEntity?.aliases.length, 0);
    assert.equal(sharedLabel?.displayName, `Shared ${suffix}`, 'labels with remaining live source evidence are preserved');
    await gateway.assertDeletionJournalReplayed();
    const deletionResult = await gateway.processDeletions();
    assert.equal(deletionResult.failed, 0);
    assert.ok(orphanIds.every((id) => deletedIds.includes(id)), 'exact source enumeration deletes every orphan beyond the former topK 100 cap');
    await gateway.assertDeletionJournalReplayed();
    const restoreMessageId = uuid();
    await database.db.insert(messages).values({ id: restoreMessageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `restore-${suffix}`, role: 'user', text: '我喜欢清晨散步。' });
    const restoreSource = await gateway.record(actor, restoreMessageId);
    await appendDeletionJournal(path.join(journalDir, 'deletions.jsonl'), { operationKey: `restore-forget:${restoreSource.id}`, characterId, sourceIds: [restoreSource.id], memoryIds: ['memory-from-before-backup'], scope: restoreSource.scope });
    await gateway.assertDeletionJournalReplayed();
    const [restoredSource] = await database.db.select().from(memorySources).where(eq(memorySources.id, restoreSource.id));
    assert.equal(restoredSource?.status, 'deleted');
    assert.ok(deletedIds.includes('memory-from-before-backup'));
    const replayedTombstones = await database.db.select().from(deletionRecords);
    assert.ok(replayedTombstones.some((record) => record.operationKey === `restore-forget:${restoreSource.id}` && record.status === 'applied'));
    const adminMessageId = uuid();
    await database.db.insert(messages).values({ id: adminMessageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `admin-forget-${suffix}`, role: 'user', text: '我喜欢喝乌龙茶。' });
    const adminSource = await gateway.record(actor, adminMessageId);
    const candidate = await lifecycle.recordCandidate(actor, { sourceId: adminSource.id, canonicalKey: `person.preference.tea.${suffix}`, factText: '喜欢喝乌龙茶。', engineMemoryId: `admin-forget-memory-${suffix}` });
    const adminReq: Record<string, unknown> = { method: 'POST', query: {}, routeOptions: { url: '/admin/memory-revisions/forget' }, headers: { authorization: 'Bearer test-admin' } };
    new AdminGuard('test-admin').canActivate({ switchToHttp: () => ({ getRequest: () => adminReq }) } as never);
    const principal = adminReq.adminPrincipal;
    const approved = await lifecycle.approveCandidate(candidate.id, candidate.version, principal, { claimKind: 'direct', evidenceQuote: '我喜欢喝乌龙茶' });
    const adminCorrectionMessageId = uuid();
    await database.db.insert(messages).values({ id: adminCorrectionMessageId, conversationId, personId: identity.personId, platform: 'qq', platformEventId: `admin-correction-${suffix}`, role: 'user', text: '更正：我其实喜欢白茶。' });
    const adminCorrected = await gateway.correctAsAdmin({ revisionId: approved.id, expectedVersion: approved.version, messageId: adminCorrectionMessageId, factText: '喜欢白茶。', evidenceQuote: '我其实喜欢白茶' }, principal, 'owner requested correction');
    assert.equal(adminCorrected.status, 'validated');
    await assert.rejects(lifecycle.recordCandidate(actor, { sourceId: adminSource.id, canonicalKey: `late-new-id-${suffix}`, factText: '喜欢喝乌龙茶。', engineMemoryId: `late-corrected-${suffix}` }), /source_unavailable/);
    await assert.rejects(gateway.correctAsAdmin({ revisionId: approved.id, expectedVersion: approved.version, messageId: adminCorrectionMessageId, factText: '喜欢白茶。', evidenceQuote: '我其实喜欢白茶' }, principal, 'owner requested correction'), /stale_revision/);
    await assert.rejects(gateway.forgetRevisionAsAdmin(candidate.id, candidate.version, { kind: 'admin', auditActorId: 'forged' }, 'erase request'));
    await assert.rejects(gateway.forgetRevisionAsAdmin(adminCorrected.id, adminCorrected.version + 1, principal, 'user requested deletion'), /stale_revision/);
    const adminTombstone = await gateway.forgetRevisionAsAdmin(adminCorrected.id, adminCorrected.version, principal, 'user requested deletion');
    assert.equal(adminTombstone.status, 'pending');
    const repeatedAdminTombstone = await gateway.forgetRevisionAsAdmin(adminCorrected.id, adminCorrected.version, principal, 'user requested deletion');
    assert.equal(repeatedAdminTombstone.id, adminTombstone.id);
    const auditRows = await database.db.select().from((await import('../src/database/schema/index.js')).auditEvents);
    assert.ok(auditRows.some((row) => row.action === 'memory_revision_forgotten_by_admin' && (row.metadata as Record<string, unknown>).auditReason === 'user requested deletion'));
    assert.equal((await gateway.processDeletions()).failed, 0);
    await database.db.delete(jobLogs).where(inArray(jobLogs.operationKey, failedBacklogKeys));
  } finally {
    if (recallSourceIds.length) {
      await database.db.delete(memoryRevisions).where(inArray(memoryRevisions.sourceId, recallSourceIds));
      await database.db.delete(memorySources).where(inArray(memorySources.id, recallSourceIds));
    }
    if (recallMessageId) await database.db.delete(messages).where(eq(messages.id, recallMessageId));
    await database.close(); await rm(journalDir, { recursive: true, force: true });
  }
});
