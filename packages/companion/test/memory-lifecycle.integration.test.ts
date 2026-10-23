import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import {
  auditEvents,
  characters,
  conversationMembers,
  conversations,
  deletionRecords,
  memoryRevisions,
  memorySources,
  memoryValidationRecords,
  messages,
  people,
  platformIdentities,
} from '../src/database/schema/index.js';
import { MemoryLifecycleService } from '../src/memory/memory-lifecycle-service.js';
import { MemoryReadService } from '../src/memory/memory-read-service.js';
import { createAdminApplication } from '../src/admin/app.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';

test('verified user source registration derives identity and is idempotent', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const identities = new IdentityService(database);
  const suffix = uuid();
  const characterId = uuid();
  const conversationId = uuid();
  const messageId = uuid();
  const messageIds = [messageId];
  const userId = `memory-lifecycle-${suffix}`;
  let personId: string | undefined;
  let identityId: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const evidence = createVerifiedChannelEvidence('qq', `memory-lifecycle-${suffix}`, userId, 'private');
    const identity = await identities.resolveIdentity({ platform: 'qq', platformUserId: userId }, evidence);
    personId = identity.personId;
    identityId = identity.platformIdentityId;
    await database.db.insert(characters).values({ id: characterId, name: `memory-lifecycle-${suffix}` });
    await database.db.insert(conversations).values({
      id: conversationId, characterId, platform: 'qq', platformConversationId: `memory-lifecycle-${suffix}`, kind: 'private',
    });
    await database.db.insert(conversationMembers).values({ conversationId, personId, confirmedAt: new Date() });
    await database.db.insert(messages).values({
      id: messageId, conversationId, personId, platform: 'qq', platformEventId: `memory-lifecycle-${suffix}`,
      role: 'user', text: '我喜欢清晨喝茶，也喜欢看书。',
    });
    const context = await identities.resolveActorContext({
      platform: 'qq', platformUserId: userId, characterId, conversationId,
    }, createVerifiedChannelEvidence('qq', `memory-lifecycle-${suffix}`, userId, 'private'));
    const service = new MemoryLifecycleService(database);

    const first = await service.recordUserSource(context, messageId);
    const second = await service.recordUserSource(context, messageId);
    assert.equal(first.id, second.id);
    assert.equal(first.batchKey, `user-message:${messageId}`);
    assert.equal(first.personId, personId);
    assert.equal(first.speakerPersonId, personId);
    assert.deepEqual(first.subjectPersonIds, [personId]);
    assert.deepEqual(first.scope, { kind: 'person_private', personId });
    assert.equal(first.sourceKind, 'user');
    assert.equal(first.claimKind, 'direct');
    assert.equal(first.allowedForExtraction, true);

    const hypotheticalMessageId = uuid();
    const reportedMessageId = uuid();
    const ambiguousMessageId = uuid();
    const thirdPartyMessageId = uuid();
    const englishThirdPartyMessageId = uuid();
    const englishMixedMessageId = uuid();
    const mixedThirdPartyMessageId = uuid();
    const namedThirdPartyMessageId = uuid();
    const firstPersonContemplationMessageId = uuid();
    const relativeThirdPartyMessageId = uuid();
    const friendPossessionMessageId = uuid();
    const neighborPossessionMessageId = uuid();
    const nestedFriendPossessionMessageId = uuid();
    const friendPurchaseMessageId = uuid();
    const emptyChainMessageId = uuid();
    const emptyChainMessageId2 = uuid();
    messageIds.push(hypotheticalMessageId, reportedMessageId, ambiguousMessageId, thirdPartyMessageId, englishThirdPartyMessageId, englishMixedMessageId, mixedThirdPartyMessageId, namedThirdPartyMessageId, firstPersonContemplationMessageId, relativeThirdPartyMessageId, friendPossessionMessageId, neighborPossessionMessageId, nestedFriendPossessionMessageId, friendPurchaseMessageId, emptyChainMessageId, emptyChainMessageId2);
    await database.db.insert(messages).values([
      { id: hypotheticalMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-hypothetical-${suffix}`, role: 'user', text: '我可能喜欢绿茶。' },
      { id: reportedMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-reported-${suffix}`, role: 'user', text: '我朋友跟我说我会买车。' },
      { id: ambiguousMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-ambiguous-${suffix}`, role: 'user', text: '有空的话我会去法国。' },
      { id: thirdPartyMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-third-party-${suffix}`, role: 'user', text: '我的朋友有一只猫。' },
      { id: englishThirdPartyMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-english-third-party-${suffix}`, role: 'user', text: 'My friend has a cat.' },
      { id: englishMixedMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-english-mixed-${suffix}`, role: 'user', text: 'I like tea but John has a cat.' },
      { id: mixedThirdPartyMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-mixed-third-party-${suffix}`, role: 'user', text: '我喜欢茶。我的朋友有一只猫。' },
      { id: namedThirdPartyMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-named-third-party-${suffix}`, role: 'user', text: '我喜欢茶而张三说我喜欢猫。' },
      { id: firstPersonContemplationMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-first-person-contemplation-${suffix}`, role: 'user', text: '我在想张三有一只猫。' },
      { id: relativeThirdPartyMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-relative-third-party-${suffix}`, role: 'user', text: '我喜欢的张三有一只猫。' },
      { id: friendPossessionMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-friend-possession-${suffix}`, role: 'user', text: '我有个朋友有一只猫。' },
      { id: neighborPossessionMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-neighbor-possession-${suffix}`, role: 'user', text: '我有位邻居有一只猫。' },
      { id: nestedFriendPossessionMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-nested-friend-possession-${suffix}`, role: 'user', text: '我有一个朋友的孩子有一只猫。' },
      { id: friendPurchaseMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-friend-purchase-${suffix}`, role: 'user', text: '我有个朋友买了一辆车。' },
      { id: emptyChainMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-empty-chain-a-${suffix}`, role: 'user', text: '我有一只猫。' },
      { id: emptyChainMessageId2, conversationId, personId, platform: 'qq', platformEventId: `memory-empty-chain-b-${suffix}`, role: 'user', text: '我养了两条鱼。' },
    ]);
    const hypotheticalSource = await service.recordUserSource(context, hypotheticalMessageId);
    assert.notEqual(hypotheticalSource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: hypotheticalSource.id, canonicalKey: 'person.future.home', factText: '会搬去法国', engineMemoryId: `hypothetical-source-${suffix}` }));
    const mixedThirdPartySource = await service.recordUserSource(context, mixedThirdPartyMessageId);
    assert.notEqual(mixedThirdPartySource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: mixedThirdPartySource.id, canonicalKey: 'person.friend.cat.mixed', factText: '我的朋友有一只猫', engineMemoryId: `mixed-third-party-source-${suffix}` }));
    const namedThirdPartySource = await service.recordUserSource(context, namedThirdPartyMessageId);
    assert.notEqual(namedThirdPartySource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: namedThirdPartySource.id, canonicalKey: 'person.zhangsan.cat', factText: '我喜欢猫', engineMemoryId: `named-third-party-source-${suffix}` }));
    const firstPersonContemplationSource = await service.recordUserSource(context, firstPersonContemplationMessageId);
    assert.notEqual(firstPersonContemplationSource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: firstPersonContemplationSource.id, canonicalKey: 'person.zhangsan.cat.thought', factText: '张三有一只猫', engineMemoryId: `first-person-contemplation-${suffix}` }));
    const relativeThirdPartySource = await service.recordUserSource(context, relativeThirdPartyMessageId);
    assert.notEqual(relativeThirdPartySource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: relativeThirdPartySource.id, canonicalKey: 'person.zhangsan.cat.relative', factText: '我喜欢的张三有一只猫', engineMemoryId: `relative-third-party-${suffix}` }));
    const friendPossessionSource = await service.recordUserSource(context, friendPossessionMessageId);
    assert.notEqual(friendPossessionSource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: friendPossessionSource.id, canonicalKey: 'person.friend.cat.possessive', factText: '我有个朋友有一只猫', engineMemoryId: `friend-possession-${suffix}` }));
    const neighborPossessionSource = await service.recordUserSource(context, neighborPossessionMessageId);
    assert.notEqual(neighborPossessionSource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: neighborPossessionSource.id, canonicalKey: 'person.neighbor.cat', factText: '我有位邻居有一只猫', engineMemoryId: `neighbor-possession-${suffix}` }));
    const nestedFriendPossessionSource = await service.recordUserSource(context, nestedFriendPossessionMessageId);
    assert.notEqual(nestedFriendPossessionSource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: nestedFriendPossessionSource.id, canonicalKey: 'person.friend.child.cat', factText: '我有一个朋友的孩子有一只猫', engineMemoryId: `nested-friend-possession-${suffix}` }));
    const friendPurchaseSource = await service.recordUserSource(context, friendPurchaseMessageId);
    assert.notEqual(friendPurchaseSource.claimKind, 'direct');
    await assert.rejects(service.recordCandidate(context, { sourceId: friendPurchaseSource.id, canonicalKey: 'person.friend.car', factText: '我有个朋友买了一辆车', engineMemoryId: `friend-purchase-${suffix}` }));
    for (const [id, key, engineId] of [
      [reportedMessageId, 'person.reported.car', `reported-source-${suffix}`],
      [ambiguousMessageId, 'person.conditional.travel', `conditional-source-${suffix}`],
      [thirdPartyMessageId, 'person.friend.cat', `third-party-source-${suffix}`],
      [englishThirdPartyMessageId, 'person.friend.cat.english', `english-third-party-source-${suffix}`],
      [englishMixedMessageId, 'person.friend.cat.english.mixed', `english-mixed-third-party-source-${suffix}`],
    ] as const) {
      const source = await service.recordUserSource(context, id);
      assert.notEqual(source.claimKind, 'direct');
      await assert.rejects(service.recordCandidate(context, { sourceId: source.id, canonicalKey: key, factText: '会买车或去法国', engineMemoryId: engineId }));
    }
    const emptyChainSourceA = await service.recordUserSource(context, emptyChainMessageId);
    const emptyChainSourceB = await service.recordUserSource(context, emptyChainMessageId2);
    const emptyChainForgetA = await service.forgetSource(context, emptyChainSourceA.id);
    const emptyChainForgetB = await service.forgetSource(context, emptyChainSourceB.id);
    assert.notEqual(emptyChainForgetA.id, emptyChainForgetB.id);
    assert.deepEqual([...emptyChainForgetB.sourceIds], [emptyChainSourceB.id]);

    const stored = await database.db.select().from(memorySources).where(eq(memorySources.messageId, messageId));
    assert.equal(stored.length, 1);

    const rollbackDatabase = Object.create(database) as typeof database;
    Object.defineProperty(rollbackDatabase, 'db', { value: new Proxy(database.db as object, { get(target, key, receiver) {
      if (key === 'transaction') return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) => (database.db.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, cfg?: unknown) => Promise<unknown>) (async (tx) => { await callback(tx); throw new Error('injected rollback'); }, config);
      return Reflect.get(target, key, receiver);
    } }) });
    const failingService = new MemoryLifecycleService(rollbackDatabase);
    await assert.rejects(failingService.recordCandidate(context, { sourceId: first.id, canonicalKey: 'rollback.test', factText: 'x', engineMemoryId: `rollback-${suffix}` }), /injected rollback/);
    assert.equal((await database.db.select().from(memoryRevisions).where(eq(memoryRevisions.canonicalKey, 'rollback.test'))).length, 0);
    assert.equal((await database.db.select().from(memoryValidationRecords).where(eq(memoryValidationRecords.engineMemoryId, `rollback-${suffix}`))).length, 0);

    const candidate = await service.recordCandidate(context, {
      sourceId: first.id,
      canonicalKey: 'person.preference.morning-tea',
      factText: '喜欢清晨喝茶。',
      engineMemoryId: `mem-${suffix}`,
    });
    assert.equal(candidate.status, 'candidate');
    const readService = new MemoryReadService(database);
    assert.deepEqual(await readService.listForActor(context), []);
    await assert.rejects(service.approveCandidate(candidate.id, candidate.version, { kind: 'admin', auditActorId: `memory-admin-${suffix}` }, { claimKind: 'direct', evidenceQuote: '我不喜欢清晨喝茶。' }));
    await assert.rejects(service.approveCandidate(candidate.id, candidate.version, { kind: 'admin', auditActorId: `memory-admin-${suffix}` }, { claimKind: 'direct', evidenceQuote: '清晨喝茶' }));
    await assert.rejects(service.approveCandidate(candidate.id, candidate.version, { kind: 'admin', auditActorId: `memory-admin-${suffix}` }, { claimKind: 'direct', evidenceQuote: '我喜欢清晨喝茶' }));
    const admin = await createAdminApplication({ database, adminToken: `test-admin-token-${suffix}-0123456789abcdef` });
    const approve = async (id: string, version: number, evidenceQuote: string) => admin.inject({ method: 'POST', url: `/admin/memory-revisions/${id}/approve`, headers: { authorization: `Bearer test-admin-token-${suffix}-0123456789abcdef` }, payload: { expectedVersion: version, claimKind: 'direct', evidenceQuote } });
    await database.db.update(memorySources).set({ claimKind: 'direct', allowedForExtraction: true }).where(eq(memorySources.id, mixedThirdPartySource.id));
    const mixedThirdPartyCandidate = await service.recordCandidate(context, { sourceId: mixedThirdPartySource.id, canonicalKey: 'person.friend.cat.mixed', factText: '我的朋友有一只猫', engineMemoryId: `mixed-third-party-review-${suffix}` });
    assert.equal((await approve(mixedThirdPartyCandidate.id, mixedThirdPartyCandidate.version, '我的朋友有一只猫')).statusCode, 422);
    await database.db.update(memorySources).set({ claimKind: 'direct', allowedForExtraction: true }).where(eq(memorySources.id, namedThirdPartySource.id));
    const namedThirdPartyCandidate = await service.recordCandidate(context, { sourceId: namedThirdPartySource.id, canonicalKey: 'person.zhangsan.cat', factText: '我喜欢猫', engineMemoryId: `named-third-party-review-${suffix}` });
    assert.equal((await approve(namedThirdPartyCandidate.id, namedThirdPartyCandidate.version, '我喜欢猫')).statusCode, 422);
    await database.db.update(memorySources).set({ claimKind: 'direct', allowedForExtraction: true }).where(eq(memorySources.id, relativeThirdPartySource.id));
    const relativeThirdPartyCandidate = await service.recordCandidate(context, { sourceId: relativeThirdPartySource.id, canonicalKey: 'person.zhangsan.cat.relative', factText: '我喜欢的张三有一只猫', engineMemoryId: `relative-third-party-review-${suffix}` });
    assert.equal((await approve(relativeThirdPartyCandidate.id, relativeThirdPartyCandidate.version, '我喜欢的张三有一只猫')).statusCode, 422);
    const wrongQuoteResponse = await approve(candidate.id, candidate.version, '我不喜欢清晨喝茶');
    assert.equal(wrongQuoteResponse.statusCode, 422);
    const unsupportedFactResponse = await approve(candidate.id, candidate.version, '我喜欢清晨喝茶，也喜欢看书。');
    assert.equal(unsupportedFactResponse.statusCode, 422);
    const approvedResponse = await approve(candidate.id, candidate.version, '我喜欢清晨喝茶');
    assert.equal(approvedResponse.statusCode, 201);
    const approved = JSON.parse(approvedResponse.body);
    await admin.close();
    assert.equal((await database.db.select().from(memoryValidationRecords).where(eq(memoryValidationRecords.engineMemoryId, `mem-${suffix}`)))[0]?.evidenceQuote, '我喜欢清晨喝茶');
    assert.equal(approved.status, 'validated');
    assert.deepEqual((await readService.listForActor(context)).map((row) => row.factText), ['喜欢清晨喝茶。']);
    await service.recordCandidate(context, { sourceId: first.id, canonicalKey: 'person.preference.tea-temperature', factText: '喜欢热茶。', engineMemoryId: `mem-other-key-${suffix}` });

    const correctionMessageId = uuid();
    messageIds.push(correctionMessageId);
    await database.db.insert(messages).values({
      id: correctionMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-correction-${suffix}`,
      role: 'user', text: '更正：我其实更喜欢绿茶。',
    });
    const corrected = await service.correctRevision(context, {
      revisionId: approved.id,
      expectedVersion: approved.version,
      messageId: correctionMessageId,
      factText: '更喜欢绿茶。',
    });
    assert.equal(corrected.status, 'validated');
    assert.equal(corrected.revision, approved.revision + 1);
    assert.equal(corrected.supersedesId, approved.id);
    const prior = (await database.db.select().from(memoryRevisions).where(eq(memoryRevisions.id, approved.id)))[0]!;
    assert.equal(prior.status, 'superseded');
    assert.ok(prior.validTo);
    assert.ok(prior.version > approved.version);
    assert.deepEqual((await readService.listForActor(context)).map((row) => row.factText), ['更喜欢绿茶。']);
    await assert.rejects(service.recordCandidate(context, {
      sourceId: first.id,
      canonicalKey: `mem0:late-new-id-${suffix}`,
      factText: '喜欢清晨喝茶。',
      engineMemoryId: `late-new-id-${suffix}`,
    }), /source_unavailable/);
    await assert.rejects(service.recordCandidate(context, {
      sourceId: first.id,
      canonicalKey: `mem0:late-compound-new-id-${suffix}`,
      factText: '我喜欢清晨喝茶，也喜欢运动。',
      engineMemoryId: `late-compound-new-id-${suffix}`,
    }), /source_unavailable/);
    const unrelatedMessageId = uuid();
    const hypotheticalCorrectionMessageId = uuid();
    messageIds.push(unrelatedMessageId, hypotheticalCorrectionMessageId);
    await database.db.insert(messages).values([
      { id: unrelatedMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-unrelated-correction-${suffix}`, role: 'user', text: '我养了一只猫。' },
      { id: hypotheticalCorrectionMessageId, conversationId, personId, platform: 'qq', platformEventId: `memory-hypothetical-correction-${suffix}`, role: 'user', text: '我可能更喜欢红茶。' },
    ]);
    await assert.rejects(service.correctRevision(context, { revisionId: corrected.id, expectedVersion: corrected.version, messageId: unrelatedMessageId, factText: '更喜欢绿茶。' }));
    await assert.rejects(service.correctRevision(context, { revisionId: corrected.id, expectedVersion: corrected.version, messageId: hypotheticalCorrectionMessageId, factText: '可能更喜欢红茶。' }));
    await assert.rejects(service.correctRevision(context, { revisionId: corrected.id, expectedVersion: corrected.version, messageId: namedThirdPartyMessageId, factText: '我喜欢茶而张三说我喜欢猫。' }));
    await assert.rejects(service.correctRevision(context, { revisionId: corrected.id, expectedVersion: corrected.version, messageId: relativeThirdPartyMessageId, factText: '我喜欢的张三有一只猫。' }));
    await assert.rejects(service.correctRevision(context, {
      revisionId: approved.id,
      expectedVersion: approved.version,
      messageId: correctionMessageId,
      factText: 'stale correction',
    }));
    const [correctionSource] = await database.db.select().from(memorySources).where(eq(memorySources.messageId, correctionMessageId));
    assert.ok(correctionSource);
    await database.db.update(memorySources).set({ claimKind: 'hypothetical' }).where(eq(memorySources.id, correctionSource.id));
    await assert.rejects(service.recordCandidate(context, { sourceId: correctionSource.id, canonicalKey: 'person.preference.hypothetical', factText: '也许喜欢绿茶', engineMemoryId: `hypothetical-${suffix}` }));
    await database.db.update(memorySources).set({ claimKind: 'direct' }).where(eq(memorySources.id, correctionSource.id));
    const secondApproved = corrected;
    const rollbackForgetDb = Object.create(database) as typeof database;
    Object.defineProperty(rollbackForgetDb, 'db', { value: new Proxy(database.db as object, { get(target, key, receiver) {
      if (key === 'transaction') return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) => (database.db.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, cfg?: unknown) => Promise<unknown>)(async (tx) => { await callback(tx); throw new Error('injected forget rollback'); }, config);
      return Reflect.get(target, key, receiver);
    } }) });
    const deletionCountBeforeRollback = (await database.db.select().from(deletionRecords).where(eq(deletionRecords.characterId, characterId))).length;
    await assert.rejects(new MemoryLifecycleService(rollbackForgetDb).forgetSource(context, first.id), /injected forget rollback/);
    assert.equal((await database.db.select().from(memorySources).where(eq(memorySources.id, first.id)))[0]?.status, 'active');
    assert.equal((await database.db.select().from(memoryRevisions).where(eq(memoryRevisions.id, secondApproved.id)))[0]?.status, 'validated');
    assert.equal((await database.db.select().from(deletionRecords).where(eq(deletionRecords.characterId, characterId))).length, deletionCountBeforeRollback);
    assert.equal((await database.db.select().from(auditEvents).where(eq(auditEvents.targetId, first.id))).filter((row) => row.action === 'memory_source_forgotten').length, 0);
    const forgotten = await service.forgetSource(context, first.id);
    assert.equal(forgotten.status, 'pending');
    assert.deepEqual([...forgotten.sourceIds].sort(), [first.id, correctionSource.id].sort());
    assert.deepEqual(forgotten.memoryIds.sort(), [`mem-${suffix}`, `mem-other-key-${suffix}`].sort());
    assert.deepEqual((await database.db.select().from(memorySources).where(inArray(memorySources.id, [...forgotten.sourceIds]))).map((row) => row.status), ['deleted', 'deleted']);
    assert.equal((await database.db.select().from(memoryRevisions).where(inArray(memoryRevisions.sourceId, [...forgotten.sourceIds]))).every((row) => row.status === 'deleted'), true);
    const forgottenMessages = await database.db.select({ text: messages.text, metadata: messages.metadata }).from(messages).where(inArray(messages.id, messageIds));
    assert.ok(forgottenMessages.filter((row) => row.text === null).length >= 2, 'forget erases raw source and correction messages');
    assert.equal((await service.forgetSource(context, correctionSource.id)).id, forgotten.id);
    await assert.rejects(service.recordCandidate(context, {
      sourceId: first.id, canonicalKey: 'person.preference.morning-tea', factText: 'late model result', engineMemoryId: `late-${suffix}`,
    }));
    assert.deepEqual(await readService.listForActor(context), []);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (personId) {
        const sourceRows = await database.db.select({ id: memorySources.id }).from(memorySources).where(eq(memorySources.characterId, characterId));
        const sourceIds = sourceRows.map((row) => row.id);
        if (sourceIds.length) {
          const revisions = await database.db.select({ id: memoryRevisions.id }).from(memoryRevisions).where(inArray(memoryRevisions.sourceId, sourceIds));
          await database.db.delete(auditEvents).where(inArray(auditEvents.targetId, [...sourceIds, ...revisions.map((row) => row.id)]));
          if (revisions.length) await database.db.delete(memoryValidationRecords).where(inArray(memoryValidationRecords.sourceId, sourceIds));
          await database.db.delete(memoryRevisions).where(inArray(memoryRevisions.sourceId, sourceIds));
          await database.db.delete(deletionRecords).where(eq(deletionRecords.characterId, characterId));
          await database.db.delete(memorySources).where(inArray(memorySources.id, sourceIds));
        }
        await database.db.delete(auditEvents).where(eq(auditEvents.actorId, personId));
        await database.db.delete(messages).where(inArray(messages.id, messageIds));
        await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
        await database.db.delete(conversations).where(eq(conversations.id, conversationId));
        await database.db.delete(characters).where(eq(characters.id, characterId));
        if (identityId) await database.db.delete(platformIdentities).where(eq(platformIdentities.id, identityId));
        await database.db.delete(people).where(eq(people.id, personId));
      }
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});
