import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { characters, conversationMembers, conversations, messages, people, personEntities, personIdentityLinks, platformIdentities, relationshipEdges } from '../src/database/schema/index.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { SocialGraphService } from '../src/relationships/social-graph-service.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';

test('source-backed friendship needs two explicit confirmations and never binds by nickname', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  const conversationId = uuid();
  const otherConversationId = uuid();
  const identityService = new IdentityService(database);
  const ownerPlatformId = `social-owner-${suffix}`;
  const otherPlatformId = `social-other-${suffix}`;
  const ownerEvidence = createVerifiedChannelEvidence('qq', `social-owner-${suffix}`, ownerPlatformId, 'private');
  const otherEvidence = createVerifiedChannelEvidence('qq', `social-other-${suffix}`, otherPlatformId, 'private');
  try {
    await migrateDatabase(database);
    const owner = await identityService.resolveIdentity({ platform: 'qq', platformUserId: ownerPlatformId }, ownerEvidence);
    const other = await identityService.resolveIdentity({ platform: 'qq', platformUserId: otherPlatformId }, otherEvidence);
    const verifiedTarget = await identityService.resolveIdentity({ platform: 'qq', platformUserId: `social-target-${suffix}` }, createVerifiedChannelEvidence('qq', `social-target-${suffix}`, `social-target-${suffix}`, 'private'));
    const unverifiedPersonId = uuid();
    const unverifiedIdentityId = uuid();
    // A friend may share the character's display name; role identity must still stay distinct.
    await database.db.insert(characters).values({ id: characterId, name: '小林' });
    await database.db.insert(people).values({ id: unverifiedPersonId, displayName: 'unverified target' });
    await database.db.insert(platformIdentities).values({ id: unverifiedIdentityId, personId: unverifiedPersonId, platform: 'qq', platformUserId: `social-unverified-${suffix}`, verifiedAt: null, verificationMethod: 'unverified-test' });
    await database.db.insert(conversations).values([
      { id: conversationId, characterId, platform: 'qq', platformConversationId: `social-owner-${suffix}`, kind: 'private' },
      { id: otherConversationId, characterId, platform: 'qq', platformConversationId: `social-other-${suffix}`, kind: 'private' },
    ]);
    await database.db.insert(conversationMembers).values([
      { conversationId, personId: owner.personId, confirmedAt: new Date() },
      { conversationId: otherConversationId, personId: other.personId, confirmedAt: new Date() },
    ]);
    const sourceMessageId = uuid();
    const sameNameMessageId = uuid();
    const mismatchMessageId = uuid();
    const knownTargetMessageId = uuid();
    const concurrentProposalMessageId = uuid();
    const unverifiedTargetMessageId = uuid();
    const unrelatedConfirmationMessageId = uuid();
    const quotedConfirmationMessageId = uuid();
    const negatedConfirmationMessageId = uuid();
    const userConfirmationMessageId = uuid();
    const characterConfirmationMessageId = uuid();
    await database.db.insert(messages).values([
      { id: sourceMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-source-${suffix}`, role: 'user', text: '这是我朋友小林。' },
      { id: sameNameMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-same-name-${suffix}`, role: 'user', text: '我还有一个朋友小林。' },
      { id: mismatchMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-mismatch-${suffix}`, role: 'user', text: '我喜欢小林。' },
      { id: knownTargetMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-known-target-${suffix}`, role: 'user', text: '这是我朋友小王。' },
      { id: concurrentProposalMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-concurrent-${suffix}`, role: 'user', text: '这是我朋友小陈。' },
      { id: unverifiedTargetMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-unverified-target-${suffix}`, role: 'user', text: '这是我朋友小赵。' },
      { id: unrelatedConfirmationMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-unrelated-confirm-${suffix}`, role: 'user', text: '今天天气不错。' },
      { id: quotedConfirmationMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-quoted-confirm-${suffix}`, role: 'user', text: '他让我说“我确认小林是我的朋友”。' },
      { id: negatedConfirmationMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-negated-confirm-${suffix}`, role: 'user', text: '我确认小林不是我的朋友。' },
      { id: userConfirmationMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-user-confirm-${suffix}`, role: 'user', text: '我确认小林是我的朋友。' },
      { id: characterConfirmationMessageId, conversationId, personId: owner.personId, platform: 'qq', platformEventId: `social-character-confirm-${suffix}`, role: 'user', text: '我确认小林也是角色的朋友。' },
    ]);
    const actor = await identityService.resolveActorContext({ platform: 'qq', platformUserId: ownerPlatformId, characterId, conversationId }, ownerEvidence);
    const otherActor = await identityService.resolveActorContext({ platform: 'qq', platformUserId: otherPlatformId, characterId, conversationId: otherConversationId }, otherEvidence);
    const service = new SocialGraphService(database);

    const proposal = await service.proposeIntroduction(actor, sourceMessageId, { displayName: '小林' });
    const [proposalEdge] = await database.db.select().from(relationshipEdges).where(eq(relationshipEdges.objectEntityId, proposal.entityId));
    const actorAliasId = uuid();
    await database.db.insert(people).values({ id: actorAliasId, displayName: `social-alias-${suffix}` });
    await database.db.insert(platformIdentities).values({
      personId: actorAliasId, platform: 'qq', platformUserId: `social-alias-${suffix}`,
      verifiedAt: new Date(), verificationMethod: 'verified-cross-platform-test',
    });
    await database.db.insert(personIdentityLinks).values({ aliasPersonId: actorAliasId, canonicalPersonId: owner.personId });
    const replayed = await service.proposeIntroduction(actor, sourceMessageId, { displayName: '小林' });
    const sameName = await service.proposeIntroduction(actor, sameNameMessageId, { displayName: '小林' });
    assert.equal(replayed.entityId, proposal.entityId);
    assert.equal(replayed.created, false);
    assert.notEqual(sameName.entityId, proposal.entityId);
    const concurrentProposals = await Promise.all(Array.from({ length: 4 }, () => service.proposeIntroduction(actor, concurrentProposalMessageId, { displayName: '小陈' })));
    assert.equal(new Set(concurrentProposals.map((item) => item.entityId)).size, 1);
    assert.equal(concurrentProposals.filter((item) => item.created).length, 1);
    const [unconfirmed] = await database.db.select().from(personEntities).where(eq(personEntities.id, proposal.entityId));
    assert.equal(unconfirmed?.confirmed, false);
    assert.equal(unconfirmed?.personId, null);
    assert.equal((await database.db.select().from(relationshipEdges).where(eq(relationshipEdges.objectEntityId, proposal.entityId))).length, 1);

    await assert.rejects(service.confirmRelationship(actor, unrelatedConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: proposal.version, kind: 'user_friend' }), /explicit current-turn confirmation/i);
    await assert.rejects(service.confirmRelationship(actor, quotedConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: proposal.version, kind: 'user_friend' }), /explicit current-turn confirmation/i);
    await assert.rejects(service.confirmRelationship(actor, negatedConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: proposal.version, kind: 'user_friend' }), /explicit current-turn confirmation/i);
    const userRelation = await service.confirmRelationship(actor, userConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: proposal.version, kind: 'user_friend' });
    assert.equal(userRelation.created, true);
    assert.deepEqual((await service.listForActor(actor)).map((relation) => relation.kind), ['user_friend']);
    await assert.rejects(service.confirmRelationship(actor, characterConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: proposal.version, kind: 'character_friend' }), /stale|version/i);
    const characterRelation = await service.confirmRelationship(actor, characterConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: userRelation.version, kind: 'character_friend' });
    assert.equal(characterRelation.created, true);
    const [userEdge] = await database.db.select().from(relationshipEdges).where(eq(relationshipEdges.id, userRelation.edgeId));
    const [characterEdge] = await database.db.select().from(relationshipEdges).where(eq(relationshipEdges.id, characterRelation.edgeId));
    assert.notEqual(characterEdge?.subjectEntityId, characterEdge?.objectEntityId);
    assert.notEqual(characterEdge?.subjectEntityId, proposal.entityId);
    assert.equal(userEdge?.sourceMessageId, userConfirmationMessageId);
    assert.equal(userEdge?.subjectEntityId, proposalEdge?.subjectEntityId, 'adding a verified cross-platform alias must reuse the canonical actor role entity');
    assert.equal(characterEdge?.sourceMessageId, characterConfirmationMessageId);
    assert.deepEqual((await service.listForActor(actor)).map((relation) => relation.kind).sort(), ['character_friend', 'user_friend']);
    const replayedConfirmation = await service.confirmRelationship(actor, userConfirmationMessageId, { entityId: proposal.entityId, expectedVersion: proposal.version, kind: 'user_friend' });
    assert.equal(replayedConfirmation.created, false);
    assert.equal((await database.db.select().from(personIdentityLinks)).length, 1);
    assert.deepEqual(await service.listForActor(otherActor), []);

    await assert.rejects(service.proposeIntroduction(actor, mismatchMessageId, { displayName: '小林' }), /source|evidence|friend/i);
    const known = await service.proposeIntroduction(actor, knownTargetMessageId, { displayName: '小王', verifiedTargetIdentityId: verifiedTarget.platformIdentityId });
    const [knownEntity] = await database.db.select().from(personEntities).where(eq(personEntities.id, known.entityId));
    assert.equal(knownEntity?.personId, verifiedTarget.personId);
    await assert.rejects(service.proposeIntroduction(actor, unverifiedTargetMessageId, { displayName: '小赵', verifiedTargetIdentityId: unverifiedIdentityId }), /verified target/i);
  } finally {
    await database.close();
  }
});
