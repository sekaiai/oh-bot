import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { DisclosurePolicy } from '../src/identity/disclosure-policy.js';
import {
  auditEvents,
  bindingChallenges,
  characters,
  circleMembers,
  conversations,
  conversationMembers,
  conversationPolicies,
  messages,
  people,
  personIdentityLinks,
  platformIdentities,
  primaryRelationshipBindings,
  socialCircles,
} from '../src/database/schema/index.js';
import { uuid, requireCompatDatabaseUrl } from './helpers.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';

test('same display names on QQ remain separate verified people', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const service = new IdentityService(database);
  const suffix = uuid();
  const createdPersonIds: string[] = [];
  const createdIdentityIds: string[] = [];
  const channel = createVerifiedChannelEvidence('qq', `channel-${suffix}`, `u1-${suffix}`, 'private');
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await assert.rejects(service.resolveIdentity({ platform: 'qq', platformUserId: `forged-${suffix}` }, { kind: 'verified-channel', platform: 'qq', channelId: 'fake' }));
    await assert.rejects(service.resolveIdentity({ platform: 'qq', platformUserId: `wrong-${suffix}` }, channel));
    const first = await service.resolveIdentity({ platform: 'qq', platformUserId: `u1-${suffix}`, displayName: 'Alex' }, channel);
    createdPersonIds.push(first.personId);
    createdIdentityIds.push(first.platformIdentityId);
    const second = await service.resolveIdentity({ platform: 'qq', platformUserId: `u2-${suffix}`, displayName: 'Alex' }, createVerifiedChannelEvidence('qq', `channel-${suffix}`, `u2-${suffix}`, 'private'));
    createdPersonIds.push(second.personId);
    createdIdentityIds.push(second.platformIdentityId);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => service.resolveIdentity({ platform: 'qq', platformUserId: `same-${suffix}`, displayName: 'Alex' }, createVerifiedChannelEvidence('qq', `channel-${suffix}`, `same-${suffix}`, 'private'))));
    assert.equal(new Set(concurrent.map((item) => item.personId)).size, 1);
    assert.equal(new Set(concurrent.map((item) => item.platformIdentityId)).size, 1);
    createdPersonIds.push(concurrent[0]!.personId);
    createdIdentityIds.push(concurrent[0]!.platformIdentityId);
    assert.notEqual(first.personId, second.personId);
    assert.notEqual(first.personId, concurrent[0]!.personId);

    const challenge = await service.createBindingChallenge(first.platformIdentityId, 'qq', { kind: 'admin', auditActorId: `test-${suffix}` });
    const stored = await database.db.select().from(bindingChallenges).where(eq(bindingChallenges.personId, first.personId));
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0]!.tokenHash, challenge.token);
    const targetEvidence = createVerifiedChannelEvidence('qq', `channel-${suffix}`, `u2-${suffix}`, 'private');
    const merged = await service.consumeBindingChallenge(challenge.token, { platform: 'qq', platformUserId: `u2-${suffix}`, conversationKind: 'private' }, targetEvidence);
    assert.equal(merged.personId, first.personId);
    assert.deepEqual(new Set(merged.linkedPersonIds), new Set([first.personId, second.personId]));
    assert.equal((await database.db.select().from(people).where(eq(people.id, second.personId))).length, 1);
    assert.equal((await database.db.select().from(platformIdentities).where(eq(platformIdentities.id, second.platformIdentityId))).length, 1);
    await assert.rejects(service.consumeBindingChallenge(challenge.token, { platform: 'qq', platformUserId: `u2-${suffix}`, conversationKind: 'private' }, targetEvidence));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (createdPersonIds.length) await database.db.delete(auditEvents).where(inArray(auditEvents.actorId, createdPersonIds));
      if (createdPersonIds.length) await database.db.delete(personIdentityLinks).where(inArray(personIdentityLinks.aliasPersonId, createdPersonIds));
      if (createdIdentityIds.length) await database.db.delete(bindingChallenges).where(inArray(bindingChallenges.sourceIdentityId, createdIdentityIds));
      if (createdPersonIds.length) {
        await database.db.delete(platformIdentities).where(inArray(platformIdentities.personId, createdPersonIds));
        await database.db.delete(people).where(inArray(people.id, createdPersonIds));
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      await database.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('identity proof, history, current private ACL, and full-roster circle disclosure', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const now = { value: new Date() };
  const service = new IdentityService(database, { now: () => new Date(now.value) });
  const policy = new DisclosurePolicy(database);
  const suffix = uuid();
  const personIds: string[] = [];
  const identityIds: string[] = [];
  const characterId = uuid();
  const circleId = uuid();
  const privateConversationIds: string[] = [];
  const groupConversationIds: string[] = [];
  const messageIds: string[] = [];
  let auditTriggerName: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const evidence = (platform: 'qq' | 'weixin', userId: string, kind: 'private' | 'group' = 'private', channelId = `channel-${suffix}`) =>
      createVerifiedChannelEvidence(platform, channelId, userId, kind);
    const alice = await service.resolveIdentity({ platform: 'qq', platformUserId: `alice-${suffix}` }, evidence('qq', `alice-${suffix}`));
    const bob = await service.resolveIdentity({ platform: 'qq', platformUserId: `bob-${suffix}` }, evidence('qq', `bob-${suffix}`));
    const carol = await service.resolveIdentity({ platform: 'qq', platformUserId: `carol-${suffix}` }, evidence('qq', `carol-${suffix}`));
    const outsider = await service.resolveIdentity({ platform: 'qq', platformUserId: `outsider-${suffix}` }, evidence('qq', `outsider-${suffix}`));
    const crossPlatform = await service.resolveIdentity({ platform: 'weixin', platformUserId: `alice-${suffix}` }, evidence('weixin', `alice-${suffix}`));
    personIds.push(alice.personId, bob.personId, carol.personId, outsider.personId, crossPlatform.personId);
    identityIds.push(alice.platformIdentityId, bob.platformIdentityId, carol.platformIdentityId, outsider.platformIdentityId, crossPlatform.platformIdentityId);

    const unrelatedErasedId = uuid();
    const unrelatedAliasId = uuid();
    personIds.push(unrelatedErasedId, unrelatedAliasId);
    await database.db.insert(people).values([
      { id: unrelatedErasedId, status: 'erased' },
      { id: unrelatedAliasId },
    ]);
    await database.db.insert(personIdentityLinks).values({ aliasPersonId: unrelatedAliasId, canonicalPersonId: unrelatedErasedId });
    assert.deepEqual(await service.getLinkedPersonIds(alice.personId), [alice.personId]);

    await database.db.insert(characters).values({ id: characterId, name: `identity-${suffix}` });
    await database.db.insert(socialCircles).values({ id: circleId, characterId, name: `circle-${suffix}` });
    const privateA = uuid();
    const privateB = uuid();
    const privateC = uuid();
    privateConversationIds.push(privateA, privateB, privateC);
    await database.db.insert(conversations).values([
      { id: privateA, characterId, platform: 'qq', platformConversationId: `private-a-${suffix}`, kind: 'private' },
      { id: privateB, characterId, platform: 'qq', platformConversationId: `private-b-${suffix}`, kind: 'private' },
      { id: privateC, characterId, platform: 'qq', platformConversationId: `private-c-${suffix}`, kind: 'private' },
    ]);
    await database.db.insert(conversationMembers).values([
      { conversationId: privateA, personId: alice.personId, confirmedAt: now.value },
      { conversationId: privateA, personId: bob.personId, confirmedAt: now.value },
      { conversationId: privateB, personId: bob.personId, confirmedAt: now.value },
      { conversationId: privateC, personId: carol.personId, confirmedAt: now.value },
    ]);
    const bobMessage = uuid();
    const carolMessage = uuid();
    messageIds.push(bobMessage, carolMessage);
    await database.db.insert(messages).values([
      { id: bobMessage, conversationId: privateB, personId: bob.personId, platform: 'qq', platformEventId: `message-b-${suffix}`, role: 'user', text: 'historic bob message' },
      { id: carolMessage, conversationId: privateC, personId: carol.personId, platform: 'qq', platformEventId: `message-c-${suffix}`, role: 'user', text: 'historic carol message' },
    ]);

    const privateContext = await service.resolveActorContext({ platform: 'qq', platformUserId: `alice-${suffix}`, characterId, conversationId: privateA }, evidence('qq', `alice-${suffix}`, 'private', `private-a-${suffix}`));
    await assert.rejects(service.createBindingChallenge(alice.platformIdentityId, 'qq', { kind: 'person', actor: { ...privateContext } }));
    const ownChallenge = await service.createBindingChallenge(alice.platformIdentityId, 'qq', { kind: 'person', actor: privateContext });
    assert.equal(ownChallenge.token.length, 64);
    await assert.rejects(service.createBindingChallenge(bob.platformIdentityId, 'qq', { kind: 'person', actor: privateContext }));
    await database.db.delete(conversationMembers).where(and(
      eq(conversationMembers.conversationId, privateA), eq(conversationMembers.personId, alice.personId),
    ));
    await assert.rejects(service.createBindingChallenge(bob.platformIdentityId, 'qq', { kind: 'person', actor: privateContext }));
    await assert.rejects(service.createBindingChallenge(alice.platformIdentityId, 'qq', { kind: 'person', actor: privateContext }));
    await database.db.insert(conversationMembers).values({ conversationId: privateA, personId: alice.personId, confirmedAt: now.value });
    await assert.rejects(service.createPerson({ displayName: 'unauthorized' }, { kind: 'person', actor: privateContext }));
    await assert.rejects(service.setPrimaryPartner(characterId, alice.personId, { kind: 'person', actor: privateContext }));
    const crossPlatformResolution = await service.resolveIdentity({ platform: 'weixin', platformUserId: `alice-${suffix}` }, evidence('weixin', `alice-${suffix}`));
    assert.notEqual(crossPlatformResolution.personId, alice.personId);
    const admin = { kind: 'admin' as const, auditActorId: `admin-${suffix}` };
    const failAuditFunction = `f2a_reject_audit_${suffix.replaceAll('-', '')}`;
    auditTriggerName = failAuditFunction;
    await database.db.execute(sql.raw(`CREATE FUNCTION public.${failAuditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'binding_challenge_created' AND NEW.actor_id = 'failing-admin-${suffix}' THEN RAISE EXCEPTION 'test challenge audit failure'; END IF; RETURN NEW; END $$`));
    await database.db.execute(sql.raw(`CREATE TRIGGER ${failAuditFunction} BEFORE INSERT ON companion.audit_events FOR EACH ROW EXECUTE FUNCTION public.${failAuditFunction}()`));
    const challengeCountBeforeAuditFailure = await database.db.select().from(bindingChallenges).where(eq(bindingChallenges.sourceIdentityId, alice.platformIdentityId));
    await assert.rejects(service.createBindingChallenge(alice.platformIdentityId, 'qq', { kind: 'admin', auditActorId: `failing-admin-${suffix}` }));
    const challengeCountAfterAuditFailure = await database.db.select().from(bindingChallenges).where(eq(bindingChallenges.sourceIdentityId, alice.platformIdentityId));
    assert.equal(challengeCountAfterAuditFailure.length, challengeCountBeforeAuditFailure.length);
    await database.db.execute(sql.raw(`DROP TRIGGER ${failAuditFunction} ON companion.audit_events`));
    await database.db.execute(sql.raw(`DROP FUNCTION public.${failAuditFunction}()`));
    auditTriggerName = undefined;
    const erasedPartner = await service.createPerson({ displayName: `erased-partner-${suffix}` }, admin);
    personIds.push(erasedPartner.personId);
    await service.setPrimaryPartner(characterId, erasedPartner.personId, admin);
    await database.db.update(people).set({ status: 'erased' }).where(eq(people.id, erasedPartner.personId));
    await service.setPrimaryPartner(characterId, alice.personId, admin);
    await service.setPrimaryPartner(characterId, alice.personId, admin);
    const partnerAudits = await database.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'primary_partner_changed'), eq(auditEvents.targetId, characterId),
    ));
    assert.equal(partnerAudits.length, 2);
    assert.deepEqual(partnerAudits[1]!.metadata, { oldPersonId: erasedPartner.personId, newPersonId: alice.personId });
    const privateScope = { kind: 'person_private' as const, personId: alice.personId };
    const partnerScope = { kind: 'partner_private' as const, personId: alice.personId };
    assert.equal(await policy.canUse(privateContext, privateScope), true);
    assert.equal(await policy.canUse(privateContext, partnerScope), true);
    assert.equal(await policy.canUse(privateContext, { kind: 'person_private', personId: carol.personId }), false);
    assert.equal(await policy.canUse(privateContext, { kind: 'partner_private', personId: carol.personId }), false);

    const firstChallenge = await service.createBindingChallenge(alice.platformIdentityId, 'qq', admin);
    await assert.rejects(service.consumeBindingChallenge(firstChallenge.token, { platform: 'weixin', platformUserId: `bob-${suffix}`, conversationKind: 'private' }, evidence('weixin', `bob-${suffix}`)));
    await assert.rejects(service.consumeBindingChallenge(firstChallenge.token, { platform: 'qq', platformUserId: `bob-${suffix}`, conversationKind: 'group' }, evidence('qq', `bob-${suffix}`, 'group')));
    assert.equal((await database.db.select().from(platformIdentities).where(and(
      eq(platformIdentities.platform, 'weixin'), eq(platformIdentities.platformUserId, `bob-${suffix}`),
    ))).length, 0);
    assert.equal((await database.db.select().from(personIdentityLinks).where(eq(personIdentityLinks.aliasPersonId, bob.personId))).length, 0);
    const blankTargetChallenge = await service.createBindingChallenge(alice.platformIdentityId, 'qq', admin);
    await assert.rejects(service.consumeBindingChallenge(blankTargetChallenge.token, { platform: 'qq', platformUserId: '', conversationKind: 'private' }, evidence('qq', 'mismatched-user')));
    assert.equal((await database.db.select().from(platformIdentities).where(and(
      eq(platformIdentities.platform, 'qq'), eq(platformIdentities.platformUserId, ''),
    ))).length, 0);
    const linkedBob = await service.consumeBindingChallenge(firstChallenge.token, { platform: 'qq', platformUserId: `bob-${suffix}`, conversationKind: 'private' }, evidence('qq', `bob-${suffix}`));
    assert.equal(linkedBob.personId, alice.personId);
    assert.deepEqual(new Set(linkedBob.linkedPersonIds), new Set([alice.personId, bob.personId]));
    assert.equal(await policy.canUse(privateContext, { kind: 'person_private', personId: bob.personId }), true);

    const secondChallenge = await service.createBindingChallenge(bob.platformIdentityId, 'qq', admin);
    const linkedCarol = await service.consumeBindingChallenge(secondChallenge.token, { platform: 'qq', platformUserId: `carol-${suffix}`, conversationKind: 'private' }, evidence('qq', `carol-${suffix}`));
    assert.equal(linkedCarol.personId, alice.personId);
    assert.deepEqual(new Set(linkedCarol.linkedPersonIds), new Set([alice.personId, bob.personId, carol.personId]));
    const flattenedLinks = await database.db.select().from(personIdentityLinks).where(inArray(personIdentityLinks.aliasPersonId, [bob.personId, carol.personId]));
    assert.deepEqual(new Map(flattenedLinks.map(({ aliasPersonId, canonicalPersonId }) => [aliasPersonId, canonicalPersonId])), new Map([[bob.personId, alice.personId], [carol.personId, alice.personId]]));
    await database.db.update(primaryRelationshipBindings).set({ personId: bob.personId }).where(eq(primaryRelationshipBindings.characterId, characterId));
    await service.setPrimaryPartner(characterId, alice.personId, admin);
    const partnerAuditsAfterAliasRequest = await database.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'primary_partner_changed'), eq(auditEvents.targetId, characterId),
    ));
    assert.equal(partnerAuditsAfterAliasRequest.length, 2);
    assert.equal((await database.db.select().from(primaryRelationshipBindings).where(eq(primaryRelationshipBindings.characterId, characterId)))[0]!.personId, bob.personId);
    const historicMessages = await database.db.select({ id: messages.id, personId: messages.personId }).from(messages).where(inArray(messages.id, messageIds));
    assert.deepEqual(new Map(historicMessages.map(({ id, personId }) => [id, personId])), new Map([[bobMessage, bob.personId], [carolMessage, carol.personId]]));
    await assert.rejects(service.consumeBindingChallenge(secondChallenge.token, { platform: 'qq', platformUserId: `carol-${suffix}`, conversationKind: 'private' }, evidence('qq', `carol-${suffix}`)));

    const concurrentTarget = await service.resolveIdentity({ platform: 'qq', platformUserId: `concurrent-target-${suffix}` }, evidence('qq', `concurrent-target-${suffix}`));
    personIds.push(concurrentTarget.personId);
    identityIds.push(concurrentTarget.platformIdentityId);
    const concurrentChallenge = await service.createBindingChallenge(alice.platformIdentityId, 'qq', admin);
    const concurrentEvidence = evidence('qq', `concurrent-target-${suffix}`);
    const concurrentConsumes = await Promise.allSettled([
      service.consumeBindingChallenge(concurrentChallenge.token, { platform: 'qq', platformUserId: `concurrent-target-${suffix}`, conversationKind: 'private' }, concurrentEvidence),
      service.consumeBindingChallenge(concurrentChallenge.token, { platform: 'qq', platformUserId: `concurrent-target-${suffix}`, conversationKind: 'private' }, concurrentEvidence),
    ]);
    assert.equal(concurrentConsumes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentConsumes.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await service.getLinkedPersonIds(concurrentTarget.personId)).includes(alice.personId), true);

    const shortTtlService = new IdentityService(database, { now: () => new Date(now.value), challengeTtlMs: 1_000 });
    const expiredChallenge = await shortTtlService.createBindingChallenge(alice.platformIdentityId, 'qq', admin);
    now.value = new Date(now.value.getTime() + 1_001);
    await assert.rejects(shortTtlService.consumeBindingChallenge(expiredChallenge.token, { platform: 'qq', platformUserId: `expired-target-${suffix}`, conversationKind: 'private' }, evidence('qq', `expired-target-${suffix}`)));
    assert.equal((await database.db.select().from(platformIdentities).where(eq(platformIdentities.platformUserId, `expired-target-${suffix}`))).length, 0);

    const currentGroup = uuid();
    const incompleteGroup = uuid();
    const outsiderGroup = uuid();
    groupConversationIds.push(currentGroup, incompleteGroup, outsiderGroup);
    await database.db.insert(conversations).values([
      { id: currentGroup, characterId, platform: 'qq', platformConversationId: `group-full-${suffix}`, kind: 'group', circleId, participantsComplete: true },
      { id: incompleteGroup, characterId, platform: 'qq', platformConversationId: `group-incomplete-${suffix}`, kind: 'group', circleId, participantsComplete: false },
      { id: outsiderGroup, characterId, platform: 'qq', platformConversationId: `group-outsider-${suffix}`, kind: 'group', circleId, participantsComplete: true },
    ]);
    await database.db.insert(conversationPolicies).values([
      { conversationId: currentGroup, circleDisclosureVerified: true },
      { conversationId: incompleteGroup, circleDisclosureVerified: true },
      { conversationId: outsiderGroup, circleDisclosureVerified: true },
    ]);
    await database.db.insert(circleMembers).values([
      { circleId, personId: alice.personId, confirmedAt: now.value },
      { circleId, personId: bob.personId, confirmedAt: now.value },
    ]);
    await database.db.insert(conversationMembers).values([
      { conversationId: currentGroup, personId: alice.personId, confirmedAt: now.value },
      { conversationId: currentGroup, personId: bob.personId, confirmedAt: now.value },
      { conversationId: incompleteGroup, personId: alice.personId, confirmedAt: now.value },
      { conversationId: incompleteGroup, personId: bob.personId, confirmedAt: now.value },
      { conversationId: outsiderGroup, personId: alice.personId, confirmedAt: now.value },
      { conversationId: outsiderGroup, personId: outsider.personId, confirmedAt: now.value },
    ]);
    const completeContext = await service.resolveActorContext({ platform: 'qq', platformUserId: `alice-${suffix}`, characterId, conversationId: currentGroup }, evidence('qq', `alice-${suffix}`, 'group', `group-full-${suffix}`));
    const incompleteContext = await service.resolveActorContext({ platform: 'qq', platformUserId: `alice-${suffix}`, characterId, conversationId: incompleteGroup }, evidence('qq', `alice-${suffix}`, 'group', `group-incomplete-${suffix}`));
    const outsiderContext = await service.resolveActorContext({ platform: 'qq', platformUserId: `alice-${suffix}`, characterId, conversationId: outsiderGroup }, evidence('qq', `alice-${suffix}`, 'group', `group-outsider-${suffix}`));
    assert.equal(completeContext.participantsComplete, true);
    assert.equal(await policy.canUse(completeContext, { kind: 'circle_shared', circleId }), true);
    assert.equal(await policy.canUse(incompleteContext, { kind: 'circle_shared', circleId }), false);
    assert.equal(await policy.canUse(outsiderContext, { kind: 'circle_shared', circleId }), false);
    assert.equal((await policy.allowedScopes(completeContext)).some((scope) => scope.kind === 'circle_shared'), true);
    assert.equal((await policy.allowedScopes(incompleteContext)).some((scope) => scope.kind === 'circle_shared'), false);
    assert.equal((await policy.allowedScopes(outsiderContext)).some((scope) => scope.kind === 'circle_shared'), false);

    await database.db.insert(conversationMembers).values({
      conversationId: currentGroup, personId: outsider.personId, confirmedAt: null,
    });
    const contextWithUnknown = await service.resolveActorContext({ platform: 'qq', platformUserId: `alice-${suffix}`, characterId, conversationId: currentGroup }, evidence('qq', `alice-${suffix}`, 'group', `group-full-${suffix}`));
    assert.equal(contextWithUnknown.participantsComplete, false);
    assert.equal(await policy.canUse(contextWithUnknown, { kind: 'circle_shared', circleId }), false);
    assert.equal((await policy.allowedScopes(contextWithUnknown)).some((scope) => scope.kind === 'circle_shared'), false);
    for (const scope of [{ kind: 'person_private', personId: alice.personId }, { kind: 'partner_private', personId: alice.personId }] as const) {
      assert.equal(await policy.canUse(completeContext, scope), false);
      assert.equal((await policy.allowedScopes(completeContext)).some((allowed) => allowed.kind === scope.kind), false);
    }

    await database.db.delete(conversationMembers).where(and(eq(conversationMembers.conversationId, privateA), eq(conversationMembers.personId, alice.personId)));
    await database.db.delete(conversationMembers).where(and(eq(conversationMembers.conversationId, privateA), eq(conversationMembers.personId, bob.personId)));
    await assert.rejects(policy.canUse(privateContext, privateScope));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (auditTriggerName) {
        await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${auditTriggerName} ON companion.audit_events`));
        await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${auditTriggerName}()`));
      }
      await database.db.delete(messages).where(inArray(messages.id, messageIds));
      await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, [...privateConversationIds, ...groupConversationIds]));
      await database.db.delete(conversationPolicies).where(inArray(conversationPolicies.conversationId, groupConversationIds));
      await database.db.delete(conversations).where(inArray(conversations.id, [...privateConversationIds, ...groupConversationIds]));
      if (personIds.length) await database.db.delete(circleMembers).where(and(eq(circleMembers.circleId, circleId), inArray(circleMembers.personId, personIds)));
      await database.db.delete(primaryRelationshipBindings).where(eq(primaryRelationshipBindings.characterId, characterId));
      if (personIds.length) await database.db.delete(auditEvents).where(inArray(auditEvents.actorId, [...personIds, `admin-${suffix}`]));
      if (personIds.length) await database.db.delete(personIdentityLinks).where(inArray(personIdentityLinks.aliasPersonId, personIds));
      if (identityIds.length) await database.db.delete(bindingChallenges).where(inArray(bindingChallenges.sourceIdentityId, identityIds));
      await database.db.delete(socialCircles).where(eq(socialCircles.id, circleId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
      if (personIds.length) {
        await database.db.delete(platformIdentities).where(inArray(platformIdentities.personId, personIds));
        await database.db.delete(people).where(inArray(people.id, personIds));
      }
    } catch (error) {
      cleanupError = error;
    }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});
