import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import {
  businessOutbox,
  characters,
  conversationMembers,
  conversations,
  messages,
  people,
  platformIdentities,
  turns,
} from '../src/database/schema/index.js';
import { IdentityService } from '../src/identity/identity-service.js';
import {
  createVerifiedChannelEvidence,
  isTrustedActorContext,
} from '../src/identity/trust.js';
import { InboundService } from '../src/transactions/inbound-service.js';
import { LocalChatSessionService } from '../src/conversations/chat-session-service.js';
import { uuid, requireCompatDatabaseUrl } from './helpers.js';

function createClock(start: string): { now: () => Date } {
  let value = new Date(start).getTime();
  return {
    now: () => {
      const current = new Date(value);
      value += 1_000;
      return current;
    },
  };
}

async function cleanupConversations(database: Database, conversationIds: readonly string[]): Promise<void> {
  if (!conversationIds.length) return;
  const conversationTurns = await database.db.select({ id: turns.id }).from(turns)
    .where(inArray(turns.conversationId, [...conversationIds]));
  if (conversationTurns.length) {
    await database.db.delete(businessOutbox).where(inArray(
      businessOutbox.operationKey,
      conversationTurns.flatMap(({ id }) => [`turn:${id}:process`, `turn:${id}:deliver`]),
    ));
  }
  await database.db.delete(turns).where(inArray(turns.conversationId, [...conversationIds]));
  await database.db.delete(messages).where(inArray(messages.conversationId, [...conversationIds]));
  await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, [...conversationIds]));
  await database.db.delete(conversations).where(inArray(conversations.id, [...conversationIds]));
}

test('verified private identities persist and read isolated multi-turn history', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  const personIds: string[] = [];
  const identityIds: string[] = [];
  const conversationIds: string[] = [];
  const clock = createClock('2026-10-23T08:00:00.000Z');
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const identityService = new IdentityService(database, { now: clock.now });
    const service = new LocalChatSessionService(
      database,
      identityService,
      new InboundService(database, identityService, { now: clock.now }),
    );
    await database.db.insert(characters).values({ id: characterId, name: `local-chat-${suffix}` });

    const aliceUser = `alice-${suffix}`;
    const bobUser = `bob-${suffix}`;
    const aliceChannel = `dm-alice-${suffix}`;
    const bobChannel = `dm-bob-${suffix}`;
    const aliceEvidence = createVerifiedChannelEvidence('qq', aliceChannel, aliceUser, 'private');
    const bobEvidence = createVerifiedChannelEvidence('qq', bobChannel, bobUser, 'private');

    const aliceFirst = await service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `alice-1-${suffix}`,
      senderPlatformId: aliceUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'alice first turn',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, aliceEvidence);
    const bobFirst = await service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `bob-1-${suffix}`,
      senderPlatformId: bobUser,
      conversationPlatformId: bobChannel,
      conversationKind: 'private',
      text: 'bob only turn',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, bobEvidence);
    const aliceSecond = await service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `alice-2-${suffix}`,
      senderPlatformId: aliceUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'alice second turn',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, aliceEvidence);

    personIds.push(aliceFirst.session.personId, bobFirst.session.personId);
    identityIds.push(aliceFirst.session.platformIdentityId, bobFirst.session.platformIdentityId);
    conversationIds.push(aliceFirst.session.conversationId, bobFirst.session.conversationId);

    assert.notEqual(aliceFirst.session.personId, bobFirst.session.personId);
    assert.notEqual(aliceFirst.session.conversationId, bobFirst.session.conversationId);
    assert.equal(aliceSecond.session.conversationId, aliceFirst.session.conversationId);
    assert.equal(aliceSecond.session.personId, aliceFirst.session.personId);

    const aliceHistory = await service.readHistory(characterId, aliceEvidence);
    const bobHistory = await service.readHistory(characterId, bobEvidence);
    assert.ok(aliceHistory);
    assert.ok(bobHistory);
    assert.deepEqual(aliceHistory.messages.map(({ text }) => text), ['alice first turn', 'alice second turn']);
    assert.deepEqual(bobHistory.messages.map(({ text }) => text), ['bob only turn']);
    assert.equal(aliceHistory.session.conversationId, aliceFirst.session.conversationId);
    assert.equal(bobHistory.session.conversationId, bobFirst.session.conversationId);
    assert.equal(aliceHistory.messages.every(({ personId }) => personId === aliceFirst.session.personId), true);
    assert.equal(bobHistory.messages.every(({ personId }) => personId === bobFirst.session.personId), true);
    assert.deepEqual(aliceHistory.messages.map(({ role }) => role), ['user', 'user']);

    const latestAlice = await service.readHistory(characterId, aliceEvidence, { limit: 1 });
    assert.ok(latestAlice);
    assert.deepEqual(latestAlice.messages.map(({ text }) => text), ['alice second turn']);

    const foreignPersonId = uuid();
    personIds.push(foreignPersonId);
    await database.db.insert(people).values({ id: foreignPersonId, displayName: `foreign-${suffix}` });
    await database.db.insert(messages).values({
      conversationId: aliceFirst.session.conversationId,
      personId: foreignPersonId,
      platform: 'qq',
      platformEventId: `foreign-${suffix}`,
      role: 'user',
      text: 'message from a different person must not leak',
      occurredAt: new Date('2026-10-23T07:00:00.000Z'),
      receivedAt: new Date('2026-10-23T07:00:00.000Z'),
    });
    const filteredAliceHistory = await service.readHistory(characterId, aliceEvidence);
    assert.ok(filteredAliceHistory);
    assert.deepEqual(
      filteredAliceHistory.messages.map(({ text }) => text),
      ['alice first turn', 'alice second turn'],
    );

    const bobOnAliceChannel = createVerifiedChannelEvidence('qq', aliceChannel, bobUser, 'private');
    await assert.rejects(service.readHistory(characterId, bobOnAliceChannel), { code: 'session_unauthorized' });
    await assert.rejects(service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `bob-on-alice-${suffix}`,
      senderPlatformId: bobUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'bob must not take over alice private history',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, bobOnAliceChannel), { code: 'conversation_member_mismatch' });

    const aliceMembers = await database.db.select({ personId: conversationMembers.personId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, aliceFirst.session.conversationId));
    assert.deepEqual(aliceMembers.map(({ personId }) => personId), [aliceFirst.session.personId]);
    const aliceHistoryAfterRejectedTakeover = await service.readHistory(characterId, aliceEvidence);
    assert.ok(aliceHistoryAfterRejectedTakeover);
    assert.deepEqual(
      aliceHistoryAfterRejectedTakeover.messages.map(({ text }) => text),
      ['alice first turn', 'alice second turn'],
    );

    assert.equal((await database.db.select().from(messages).where(and(
      eq(messages.conversationId, aliceFirst.session.conversationId),
      eq(messages.personId, bobFirst.session.personId),
    ))).length, 0);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await cleanupConversations(database, conversationIds);
      if (identityIds.length) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identityIds));
      if (personIds.length) await database.db.delete(people).where(inArray(people.id, personIds));
      await database.db.delete(characters).where(eq(characters.id, characterId));
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

test('forged evidence and caller supplied actor claims are rejected', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  const personIds: string[] = [];
  const identityIds: string[] = [];
  const conversationIds: string[] = [];
  const clock = createClock('2026-10-23T09:00:00.000Z');
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const identityService = new IdentityService(database, { now: clock.now });
    const service = new LocalChatSessionService(
      database,
      identityService,
      new InboundService(database, identityService, { now: clock.now }),
    );
    await database.db.insert(characters).values({ id: characterId, name: `forged-${suffix}` });

    const aliceUser = `alice-${suffix}`;
    const bobUser = `bob-${suffix}`;
    const aliceChannel = `dm-alice-${suffix}`;
    const aliceEvidence = createVerifiedChannelEvidence('qq', aliceChannel, aliceUser, 'private');
    const bobEvidence = createVerifiedChannelEvidence('qq', `dm-bob-${suffix}`, bobUser, 'private');
    const accepted = await service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `forged-base-${suffix}`,
      senderPlatformId: aliceUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'alice private history',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, aliceEvidence);
    personIds.push(accepted.session.personId);
    identityIds.push(accepted.session.platformIdentityId);
    conversationIds.push(accepted.session.conversationId);

    const forgedEvidence = {
      kind: 'verified-channel',
      platform: 'qq',
      channelId: aliceChannel,
    } as const;
    await assert.rejects(service.readHistory(characterId, forgedEvidence as never), { code: 'invalid_evidence' });
    const clonedEvidence = { ...aliceEvidence };
    await assert.rejects(service.readHistory(characterId, clonedEvidence as never), { code: 'invalid_evidence' });
    await assert.rejects(service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `forged-event-${suffix}`,
      senderPlatformId: aliceUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'forged evidence must not write',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, forgedEvidence as never), { code: 'invalid_evidence' });

    await assert.rejects(service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `mismatched-${suffix}`,
      senderPlatformId: bobUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'mismatched sender',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, aliceEvidence), { code: 'invalid_evidence' });

    const forgedActor = {
      personId: accepted.session.personId,
      characterId,
      conversationId: accepted.session.conversationId,
      platformIdentityId: accepted.session.platformIdentityId,
      conversationKind: 'private',
      isPartner: true,
      circleIds: [],
      participantIds: [accepted.session.personId],
      linkedPersonIds: [accepted.session.personId],
      participantsComplete: true,
    };
    assert.equal(isTrustedActorContext(forgedActor), false);
    await assert.rejects(
      service.readHistory(characterId, aliceEvidence, { actor: forgedActor } as never),
      { code: 'invalid_input' },
    );

    const mismatchedSessionService = new LocalChatSessionService(database, {
      resolveActorContext: async () => ({
        ...accepted.session,
        conversationId: uuid(),
        isPartner: false,
        circleIds: [],
        participantIds: [],
        participantsComplete: true,
      }),
    } as unknown as IdentityService);
    await assert.rejects(mismatchedSessionService.readHistory(characterId, aliceEvidence), {
      code: 'session_unauthorized',
    });

    await assert.rejects(service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `spoofed-person-${suffix}`,
      senderPlatformId: aliceUser,
      conversationPlatformId: aliceChannel,
      conversationKind: 'private',
      text: 'spoofed person claim',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
      personId: bobUser,
    } as never, aliceEvidence), { code: 'invalid_input' });

    await assert.rejects(
      service.readHistory(characterId, aliceEvidence, { personId: accepted.session.personId } as never),
      { code: 'invalid_input' },
    );
    await assert.rejects(
      service.readHistory(characterId, aliceEvidence, { userId: aliceUser } as never),
      { code: 'invalid_input' },
    );

    const aliceGroupChannel = `group-${suffix}`;
    const groupEvidence = createVerifiedChannelEvidence('qq', aliceGroupChannel, aliceUser, 'group');
    await assert.rejects(service.readHistory(characterId, groupEvidence), {
      code: 'unsupported_conversation_kind',
    });
    await assert.rejects(service.acceptMessage(characterId, {
      platform: 'qq',
      eventId: `group-event-${suffix}`,
      senderPlatformId: aliceUser,
      conversationPlatformId: aliceGroupChannel,
      conversationKind: 'group',
      text: 'local chat only supports trusted private conversations',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [],
      participantsComplete: false,
    }, groupEvidence), { code: 'unsupported_conversation_kind' });

    const bobOnAliceChannel = createVerifiedChannelEvidence('qq', aliceChannel, bobUser, 'private');
    await assert.rejects(service.readHistory(characterId, bobOnAliceChannel), { code: 'session_unauthorized' });
    assert.equal(await service.readHistory(characterId, bobEvidence), null);

    const aliceHistory = await service.readHistory(characterId, aliceEvidence);
    assert.ok(aliceHistory);
    assert.deepEqual(aliceHistory.messages.map(({ text }) => text), ['alice private history']);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await cleanupConversations(database, conversationIds);
      if (identityIds.length) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identityIds));
      if (personIds.length) await database.db.delete(people).where(inArray(people.id, personIds));
      await database.db.delete(characters).where(eq(characters.id, characterId));
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

test('duplicate event delivery is idempotent for one persisted history turn', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  const personIds: string[] = [];
  const identityIds: string[] = [];
  const conversationIds: string[] = [];
  const clock = createClock('2026-10-23T10:00:00.000Z');
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const identityService = new IdentityService(database, { now: clock.now });
    const service = new LocalChatSessionService(
      database,
      identityService,
      new InboundService(database, identityService, { now: clock.now }),
    );
    await database.db.insert(characters).values({ id: characterId, name: `duplicate-${suffix}` });

    const user = `user-${suffix}`;
    const channel = `dm-${suffix}`;
    const evidence = createVerifiedChannelEvidence('qq', channel, user, 'private');
    const event = {
      platform: 'qq' as const,
      eventId: `duplicate-event-${suffix}`,
      senderPlatformId: user,
      conversationPlatformId: channel,
      conversationKind: 'private' as const,
      text: 'only once',
      timestamp: clock.now().toISOString(),
      participantPlatformIds: [] as string[],
      participantsComplete: false,
    };

    const first = await service.acceptMessage(characterId, event, evidence);
    const duplicate = await service.acceptMessage(characterId, event, evidence);
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => service.acceptMessage(characterId, event, evidence)));
    personIds.push(first.session.personId);
    identityIds.push(first.session.platformIdentityId);
    conversationIds.push(first.session.conversationId);

    assert.equal(first.accepted.duplicate, false);
    assert.equal(duplicate.accepted.duplicate, true);
    assert.equal(duplicate.accepted.messageId, first.accepted.messageId);
    assert.equal(duplicate.accepted.turnId, first.accepted.turnId);
    assert.equal(duplicate.accepted.conversationId, first.accepted.conversationId);
    assert.equal(concurrent.every(({ accepted: item }) => item.duplicate), true);
    assert.equal(new Set(concurrent.map(({ accepted: item }) => item.messageId)).size, 1);

    const history = await service.readHistory(characterId, evidence);
    assert.ok(history);
    assert.deepEqual(history.messages.map(({ text }) => text), ['only once']);
    assert.equal((await database.db.select().from(messages).where(eq(
      messages.conversationId, first.session.conversationId,
    ))).length, 1);
    assert.equal((await database.db.select().from(turns).where(eq(
      turns.conversationId, first.session.conversationId,
    ))).length, 1);

    await assert.rejects(service.acceptMessage(characterId, { ...event, text: 'changed payload' }, evidence), {
      code: 'replay_conflict',
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await cleanupConversations(database, conversationIds);
      if (identityIds.length) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identityIds));
      if (personIds.length) await database.db.delete(people).where(inArray(people.id, personIds));
      await database.db.delete(characters).where(eq(characters.id, characterId));
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
