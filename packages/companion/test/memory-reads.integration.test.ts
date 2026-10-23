import test from 'node:test';
import assert from 'node:assert/strict';
import { inArray, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database/database.js';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { DisclosurePolicy } from '../src/identity/disclosure-policy.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import {
  characters,
  circleMembers,
  conversations,
  conversationMembers,
  conversationPolicies,
  disclosureRules,
  knowledgeClaims,
  memoryRevisions,
  memorySources,
  messages,
  people,
  platformIdentities,
  socialCircles,
} from '../src/database/schema/index.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';
import { MemoryReadService } from '../src/memory/memory-read-service.js';
import type { VisibilityScope } from '../src/domain/contracts.js';

type CompanionTransaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

test('memory reads return only current directly evidenced claims authorized by current actor context', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const identity = new IdentityService(database);
  const service = new MemoryReadService(database);
  const suffix = uuid();
  const characterId = uuid();
  const aliceConversationId = uuid();
  const bobConversationId = uuid();
  const groupConversationId = uuid();
  const circleId = uuid();
  const personIds: string[] = [];
  const identityIds: string[] = [];
  const conversationIds = [aliceConversationId, bobConversationId, groupConversationId];
  const messageIds: string[] = [];
  const sourceIds: string[] = [];
  const revisionIds: string[] = [];
  const claimIds: string[] = [];
  const ruleIds: string[] = [];
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const alicePlatformId = `memory-alice-${suffix}`;
    const bobPlatformId = `memory-bob-${suffix}`;
    const aliceEvidence = createVerifiedChannelEvidence('qq', `memory-private-alice-${suffix}`, alicePlatformId, 'private');
    const bobEvidence = createVerifiedChannelEvidence('qq', `memory-private-bob-${suffix}`, bobPlatformId, 'private');
    const alice = await identity.resolveIdentity({ platform: 'qq', platformUserId: alicePlatformId }, aliceEvidence);
    const bob = await identity.resolveIdentity({ platform: 'qq', platformUserId: bobPlatformId }, bobEvidence);
    personIds.push(alice.personId, bob.personId);
    identityIds.push(alice.platformIdentityId, bob.platformIdentityId);
    await database.db.insert(characters).values({ id: characterId, name: `memory-${suffix}` });
    await database.db.insert(socialCircles).values({ id: circleId, characterId, name: `memory-circle-${suffix}` });
    await database.db.insert(conversations).values([
      { id: aliceConversationId, characterId, platform: 'qq', platformConversationId: `memory-private-alice-${suffix}`, kind: 'private' },
      { id: bobConversationId, characterId, platform: 'qq', platformConversationId: `memory-private-bob-${suffix}`, kind: 'private' },
      { id: groupConversationId, characterId, circleId, platform: 'qq', platformConversationId: `memory-group-${suffix}`, kind: 'group', participantsComplete: true },
    ]);
    await database.db.insert(conversationMembers).values([
      { conversationId: aliceConversationId, personId: alice.personId, confirmedAt: new Date() },
      { conversationId: bobConversationId, personId: bob.personId, confirmedAt: new Date() },
      { conversationId: groupConversationId, personId: alice.personId, confirmedAt: new Date() },
      { conversationId: groupConversationId, personId: bob.personId, confirmedAt: null },
    ]);
    await database.db.insert(conversationPolicies).values({ conversationId: groupConversationId, circleDisclosureVerified: true });
    await database.db.insert(circleMembers).values([
      { circleId, personId: alice.personId, confirmedAt: new Date() },
      { circleId, personId: bob.personId, confirmedAt: new Date() },
    ]);

    const aliceContext = await identity.resolveActorContext(
      { platform: 'qq', platformUserId: alicePlatformId, characterId, conversationId: aliceConversationId },
      createVerifiedChannelEvidence('qq', `memory-private-alice-${suffix}`, alicePlatformId, 'private'),
    );
    const bobContext = await identity.resolveActorContext(
      { platform: 'qq', platformUserId: bobPlatformId, characterId, conversationId: bobConversationId },
      createVerifiedChannelEvidence('qq', `memory-private-bob-${suffix}`, bobPlatformId, 'private'),
    );
    const groupContext = await identity.resolveActorContext(
      { platform: 'qq', platformUserId: alicePlatformId, characterId, conversationId: groupConversationId },
      createVerifiedChannelEvidence('qq', `memory-group-${suffix}`, alicePlatformId, 'group'),
    );

    async function addFact(options: {
      key: string;
      text: string;
      conversationId?: string;
      speakerId?: string;
      role?: 'user' | 'assistant' | 'tool';
      sourceKind?: 'user' | 'assistant' | 'tool' | 'legacy';
      claimKind?: 'direct' | 'reported' | 'hypothetical' | 'fiction' | 'tool';
      allowed?: boolean;
      sourceStatus?: 'active' | 'deleted';
      scope?: VisibilityScope;
      revisionStatus?: 'candidate' | 'validated' | 'conflict' | 'superseded' | 'deleted';
      revisionValidTo?: Date | null;
      revisionSubjectPersonIds?: string[];
      deniedPersonIds?: string[];
      claimDeniedPersonIds?: string[];
    }): Promise<string> {
      const sourceMessageId = uuid();
      const sourceId = uuid();
      const revisionId = uuid();
      const speakerId = options.speakerId ?? alice.personId;
      const conversationId = options.conversationId ?? aliceConversationId;
      messageIds.push(sourceMessageId);
      sourceIds.push(sourceId);
      revisionIds.push(revisionId);
      await database.db.insert(messages).values({
        id: sourceMessageId,
        conversationId,
        personId: options.role === 'assistant' || options.role === 'tool' ? null : speakerId,
        platform: 'qq',
        platformEventId: `memory-source-${suffix}-${options.key}`,
        role: options.role ?? 'user',
        text: `source-message-${suffix}-${options.key}`,
      });
      const scope = options.scope ?? { kind: 'person_private', personId: speakerId };
      await database.db.insert(memorySources).values({
        id: sourceId,
        characterId,
        personId: speakerId,
        conversationId,
        messageId: sourceMessageId,
        sourceKind: options.sourceKind ?? 'user',
        batchKey: `memory-batch-${suffix}-${options.key}`,
        scope,
        subjectPersonIds: options.revisionSubjectPersonIds ?? [speakerId],
        speakerPersonId: speakerId,
        participantPersonIds: [speakerId],
        claimKind: options.claimKind ?? 'direct',
        allowedForExtraction: options.allowed ?? true,
        status: options.sourceStatus ?? 'active',
        deletedAt: options.sourceStatus === 'deleted' ? new Date() : null,
      });
      await database.db.insert(memoryRevisions).values({
        id: revisionId,
        characterId,
        canonicalKey: `memory-key-${suffix}-${options.key}`,
        revision: 1,
        sourceId,
        factText: options.text,
        scope,
        subjectPersonIds: [speakerId],
        status: options.revisionStatus ?? 'validated',
        validFrom: new Date(Date.now() - 1000),
        validTo: options.revisionValidTo ?? null,
      });
      if (options.claimDeniedPersonIds) {
        const claimId = uuid();
        claimIds.push(claimId);
        await database.db.insert(knowledgeClaims).values({
          id: claimId,
          characterId,
          sourceId,
          claimText: options.text,
          scope,
          validFrom: new Date(Date.now() - 1000),
        });
        const claimRuleId = uuid();
        ruleIds.push(claimRuleId);
        await database.db.insert(disclosureRules).values({
          id: claimRuleId,
          characterId,
          claimId,
          scope,
          deniedPersonIds: options.claimDeniedPersonIds,
        });
      }
      if (options.deniedPersonIds) {
        const ruleId = uuid();
        ruleIds.push(ruleId);
        await database.db.insert(disclosureRules).values({
          id: ruleId,
          characterId,
          sourceId,
          scope,
          deniedPersonIds: options.deniedPersonIds,
        });
      }
      return revisionId;
    }

    await addFact({ key: 'alice-valid', text: 'alice-keeps-a-blue-notebook' });
    await addFact({ key: 'bob-valid', text: 'bob-keeps-a-green-notebook', conversationId: bobConversationId, speakerId: bob.personId });
    await addFact({ key: 'candidate', text: 'candidate-must-not-appear', revisionStatus: 'candidate' });
    await addFact({ key: 'conflict', text: 'conflict-must-not-appear', revisionStatus: 'conflict' });
    await addFact({ key: 'superseded', text: 'superseded-must-not-appear', revisionStatus: 'superseded' });
    await addFact({ key: 'deleted-revision', text: 'deleted-revision-must-not-appear', revisionStatus: 'deleted' });
    await addFact({ key: 'hypothetical', text: 'hypothetical-must-not-appear', claimKind: 'hypothetical' });
    await addFact({ key: 'fiction', text: 'fiction-must-not-appear', claimKind: 'fiction' });
    await addFact({ key: 'reported', text: 'reported-must-not-appear', claimKind: 'reported' });
    await addFact({ key: 'expired-revision', text: 'expired-revision-must-not-appear', revisionValidTo: new Date() });
    await addFact({ key: 'mismatched-subject', text: 'mismatched-subject-must-not-appear', revisionSubjectPersonIds: [bob.personId] });
    await addFact({ key: 'assistant', text: 'assistant-must-not-appear', role: 'assistant', sourceKind: 'assistant' });
    await addFact({ key: 'tool', text: 'tool-must-not-appear', role: 'tool', sourceKind: 'tool', claimKind: 'tool' });
    await addFact({ key: 'legacy', text: 'legacy-must-not-appear', sourceKind: 'legacy' });
    await addFact({ key: 'deleted-source', text: 'deleted-source-must-not-appear', sourceStatus: 'deleted' });
    await addFact({ key: 'not-allowed', text: 'not-allowed-must-not-appear', allowed: false });
    await addFact({
      key: 'denied', text: 'denied-person-must-not-appear', deniedPersonIds: [alice.personId],
    });
    await addFact({
      key: 'claim-denied', text: 'claim-denied-person-must-not-appear', claimDeniedPersonIds: [alice.personId],
    });
    await addFact({
      key: 'unconfirmed-group', text: 'unconfirmed-group-must-not-appear',
      conversationId: groupConversationId,
      scope: { kind: 'circle_shared', circleId },
    });
    await addFact({
      key: 'private-public', text: 'private-source-cannot-be-public',
      scope: { kind: 'character_public' },
    });
    await addFact({
      key: 'private-circle', text: 'private-source-cannot-be-circle-shared',
      scope: { kind: 'circle_shared', circleId },
    });
    await addFact({
      key: 'group-public', text: 'group-source-cannot-be-character-public',
      conversationId: groupConversationId,
      scope: { kind: 'character_public' },
    });

    const aliceRows = await service.listForActor(aliceContext);
    assert.deepEqual(aliceRows.map((row) => row.factText), ['alice-keeps-a-blue-notebook']);
    assert.equal(aliceRows[0]!.scope.kind, 'person_private');
    assert.equal(aliceRows[0]!.factText, 'alice-keeps-a-blue-notebook');
    assert.notEqual(aliceRows[0]!.factText, `source-message-${suffix}-alice-valid`);
    assert.equal(aliceRows[0]!.sourceId.length > 0, true);
    assert.deepEqual(aliceRows[0]!.subjectPersonIds, [alice.personId]);
    assert.equal('rawMessageText' in aliceRows[0]!, false);
    assert.deepEqual((await service.listForActor(bobContext)).map((row) => row.factText), ['bob-keeps-a-green-notebook']);
    assert.deepEqual(await service.listForActor(groupContext), []);
    await assert.rejects(service.listForActor(aliceContext, { limit: 10, scope: { kind: 'character_public' } }));

    const forgedContext = { ...aliceContext, isPartner: true, circleIds: [circleId], linkedPersonIds: [bob.personId] };
    await assert.rejects(service.listForActor(forgedContext));
    await assert.rejects(service.listForActor({ ...aliceContext, personId: bob.personId }));

    let signalSnapshot!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotReached = new Promise<void>((resolve) => { signalSnapshot = resolve; });
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let readerPid: number | undefined;
    class PausingDisclosurePolicy extends DisclosurePolicy {
      override async authorizationSnapshot(context: typeof aliceContext, tx: CompanionTransaction) {
        const authorization = await super.authorizationSnapshot(context, tx);
        const pidResult = await tx.execute(sql`select pg_backend_pid() as pid`);
        readerPid = Number((pidResult.rows[0] as { pid: number | string }).pid);
        signalSnapshot();
        await snapshotGate;
        return authorization;
      }
    }
    const concurrentReadService = new MemoryReadService(database, new PausingDisclosurePolicy(database));
    const concurrentRead = concurrentReadService.listForActor(aliceContext);
    await snapshotReached;
    const revoker = await database.pool.connect();
    let revokePromise: Promise<void> | undefined;
    try {
      await revoker.query('begin');
      const [{ pid }] = (await revoker.query('select pg_backend_pid() as pid')).rows as Array<{ pid: number }>;
      revokePromise = (async () => {
        await revoker.query('select id from companion.conversations where id = $1 for update', [aliceConversationId]);
        await revoker.query('delete from companion.conversation_members where conversation_id = $1 and person_id = $2', [aliceConversationId, alice.personId]);
        await revoker.query('commit');
      })();
      revokePromise.catch(() => undefined);
      let blockedByRead = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !blockedByRead) {
        const result = await database.pool.query(
          'select $2 = any(pg_blocking_pids($1)) as blocked', [pid, readerPid],
        );
        blockedByRead = result.rows[0]?.blocked === true;
        if (!blockedByRead) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blockedByRead, true, 'conversation revocation must wait for the in-flight authorized read');
      releaseSnapshot();
      const rows = await concurrentRead;
      await revokePromise;
      assert.deepEqual(rows.map((row) => row.factText), ['alice-keeps-a-blue-notebook']);
      await assert.rejects(service.listForActor(aliceContext), /actor is not a confirmed conversation member/);
    } finally {
      releaseSnapshot();
      try { await concurrentRead; } catch { /* preserve the primary assertion */ }
      try { await revokePromise; } catch { /* rollback below releases any remaining locks */ }
      try { await revoker.query('rollback'); } catch { /* transaction may already be committed */ }
      revoker.release();
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (ruleIds.length) await database.db.delete(disclosureRules).where(inArray(disclosureRules.id, ruleIds));
      if (claimIds.length) await database.db.delete(knowledgeClaims).where(inArray(knowledgeClaims.id, claimIds));
      if (revisionIds.length) await database.db.delete(memoryRevisions).where(inArray(memoryRevisions.id, revisionIds));
      if (sourceIds.length) await database.db.delete(memorySources).where(inArray(memorySources.id, sourceIds));
      if (messageIds.length) await database.db.delete(messages).where(inArray(messages.id, messageIds));
      await database.db.delete(conversationPolicies).where(inArray(conversationPolicies.conversationId, conversationIds));
      await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, conversationIds));
      await database.db.delete(circleMembers).where(inArray(circleMembers.circleId, [circleId]));
      await database.db.delete(conversations).where(inArray(conversations.id, conversationIds));
      await database.db.delete(socialCircles).where(inArray(socialCircles.id, [circleId]));
      await database.db.delete(characters).where(inArray(characters.id, [characterId]));
      if (identityIds.length) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identityIds));
      if (personIds.length) await database.db.delete(people).where(inArray(people.id, personIds));
    } catch (error) {
      cleanupError = error;
    }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('memory reads lock authorization dependencies for circle-shared sources from other group conversations', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const identity = new IdentityService(database);
  const suffix = uuid();
  const characterId = uuid();
  const privateConversationId = uuid();
  const groupConversationId = uuid();
  const circleId = uuid();
  const actorPlatformId = `memory-group-lock-${suffix}`;
  const evidence = createVerifiedChannelEvidence('qq', `memory-group-lock-private-${suffix}`, actorPlatformId, 'private');
  let personId: string | undefined;
  let platformIdentityId: string | undefined;
  let rosterRevoker: PoolClient | undefined;
  let policyRevoker: PoolClient | undefined;
  let releaseRead!: () => void;
  let primaryError: unknown;
  const blockerPromises: Array<Promise<void>> = [];
  try {
    await migrateDatabase(database);
    const actor = await identity.resolveIdentity({ platform: 'qq', platformUserId: actorPlatformId }, evidence);
    personId = actor.personId;
    platformIdentityId = actor.platformIdentityId;
    await database.db.insert(characters).values({ id: characterId, name: `memory-group-lock-${suffix}` });
    await database.db.insert(socialCircles).values({ id: circleId, characterId, name: `memory-group-lock-circle-${suffix}` });
    const observedAt = new Date(Date.now() - 1_000);
    await database.db.insert(conversations).values([
      { id: privateConversationId, characterId, platform: 'qq', platformConversationId: `memory-group-lock-private-${suffix}`, kind: 'private' },
      { id: groupConversationId, characterId, circleId, platform: 'qq', platformConversationId: `memory-group-lock-group-${suffix}`, kind: 'group', participantsComplete: true, rosterObservedAt: observedAt },
    ]);
    await database.db.insert(conversationMembers).values([
      { conversationId: privateConversationId, personId, confirmedAt: observedAt },
      { conversationId: groupConversationId, personId, confirmedAt: observedAt },
    ]);
    await database.db.insert(conversationPolicies).values({ conversationId: groupConversationId, circleDisclosureVerified: true });
    await database.db.insert(circleMembers).values({ circleId, personId, confirmedAt: observedAt });
    await database.db.insert(messages).values({
      id: uuid(), conversationId: groupConversationId, personId, platform: 'qq',
      platformEventId: `memory-group-lock-message-${suffix}`, role: 'user', text: 'source message withheld from model',
    });
    const [message] = await database.db.select().from(messages).where(sql`${messages.platformEventId} = ${`memory-group-lock-message-${suffix}`}`).limit(1);
    assert.ok(message);
    const sourceId = uuid();
    await database.db.insert(memorySources).values({
      id: sourceId, characterId, personId, conversationId: groupConversationId, messageId: message.id,
      sourceKind: 'user', batchKey: `memory-group-lock-batch-${suffix}`,
      scope: { kind: 'circle_shared', circleId }, subjectPersonIds: [personId], speakerPersonId: personId,
      participantPersonIds: [personId], claimKind: 'direct', allowedForExtraction: true,
    });
    await database.db.insert(memoryRevisions).values({
      id: uuid(), characterId, canonicalKey: `memory-group-lock-fact-${suffix}`, revision: 1,
      sourceId, factText: 'circle fact under revocation test', scope: { kind: 'circle_shared', circleId },
      subjectPersonIds: [personId], status: 'validated', validFrom: observedAt,
    });
    const actorContext = await identity.resolveActorContext(
      { platform: 'qq', platformUserId: actorPlatformId, characterId, conversationId: privateConversationId },
      evidence,
    );
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let readerPid: number | undefined;
    class PausingPolicy extends DisclosurePolicy {
      override async authorizationSnapshot(context: typeof actorContext, tx: CompanionTransaction) {
        const snapshot = await super.authorizationSnapshot(context, tx);
        const result = await tx.execute(sql`select pg_backend_pid() as pid`);
        readerPid = Number((result.rows[0] as { pid: number | string }).pid);
        signalReady();
        await gate;
        return snapshot;
      }
    }
    const service = new MemoryReadService(database, new PausingPolicy(database));
    const read = service.listForActor(actorContext);
    await ready;

    rosterRevoker = await database.pool.connect();
    policyRevoker = await database.pool.connect();
    const rosterClient = rosterRevoker;
    const policyClient = policyRevoker;
    const [{ pid: rosterPid }] = (await rosterClient.query('select pg_backend_pid() as pid')).rows as Array<{ pid: number }>;
    const [{ pid: policyPid }] = (await policyClient.query('select pg_backend_pid() as pid')).rows as Array<{ pid: number }>;
    blockerPromises.push((async () => {
      await rosterClient.query('begin');
      await rosterClient.query('select id from companion.conversations where id = $1 for update', [groupConversationId]);
      await rosterClient.query('delete from companion.conversation_members where conversation_id = $1 and person_id = $2', [groupConversationId, personId]);
      await rosterClient.query('commit');
    })());
    blockerPromises.push((async () => {
      await policyClient.query('begin');
      await policyClient.query('select conversation_id from companion.conversation_policies where conversation_id = $1 for update', [groupConversationId]);
      await policyClient.query('update companion.conversation_policies set circle_disclosure_verified = false where conversation_id = $1', [groupConversationId]);
      await policyClient.query('commit');
    })());
    for (const promise of blockerPromises) promise.catch(() => undefined);
    const waitBlocked = async (pid: number, label: string) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const result = await database.pool.query('select $2 = any(pg_blocking_pids($1)) as blocked', [pid, readerPid]);
        if (result.rows[0]?.blocked === true) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`${label} must wait for the authorized read transaction`);
    };
    await waitBlocked(rosterPid, 'group roster revoke');
    await waitBlocked(policyPid, 'group policy revoke');
    releaseRead();
    const result = await read;
    await Promise.all(blockerPromises);
    assert.deepEqual(result.map((row) => row.factText), ['circle fact under revocation test']);
    assert.deepEqual(await service.listForActor(actorContext), []);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    releaseRead?.();
    try { await Promise.all(blockerPromises); } catch (error) { if (!primaryError) primaryError = error; }
    try { await rosterRevoker?.query('rollback'); } catch { /* transaction may be complete */ }
    rosterRevoker?.release();
    try { await policyRevoker?.query('rollback'); } catch { /* transaction may be complete */ }
    policyRevoker?.release();
    let cleanupError: unknown;
    try {
      await database.db.delete(memoryRevisions).where(sql`${memoryRevisions.canonicalKey} = ${`memory-group-lock-fact-${suffix}`}`);
      await database.db.delete(memorySources).where(sql`${memorySources.batchKey} = ${`memory-group-lock-batch-${suffix}`}`);
      await database.db.delete(messages).where(sql`${messages.platformEventId} = ${`memory-group-lock-message-${suffix}`}`);
      await database.db.delete(conversationPolicies).where(inArray(conversationPolicies.conversationId, [privateConversationId, groupConversationId]));
      await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, [privateConversationId, groupConversationId]));
      await database.db.delete(circleMembers).where(inArray(circleMembers.circleId, [circleId]));
      await database.db.delete(conversations).where(inArray(conversations.id, [privateConversationId, groupConversationId]));
      await database.db.delete(socialCircles).where(inArray(socialCircles.id, [circleId]));
      await database.db.delete(characters).where(inArray(characters.id, [characterId]));
      if (platformIdentityId) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, [platformIdentityId]));
      if (personId) await database.db.delete(people).where(inArray(people.id, [personId]));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('memory reader rejects untrusted context before opening a database transaction', async () => {
  let transactions = 0;
  const fakeDatabase = {
    db: {
      transaction: async () => {
        transactions += 1;
        throw new Error('untrusted actor context');
      },
    },
  } as unknown as Database;
  await assert.rejects(new MemoryReadService(fakeDatabase).listForActor({} as never), /untrusted actor context/);
  assert.equal(transactions, 0);
});
