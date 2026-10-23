import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { businessOutbox, characters, conversationMembers, conversations, deliveryOutbox, messages, people, platformIdentities, turns } from '../src/database/schema/index.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { LocalChatSessionService } from '../src/conversations/chat-session-service.js';
import { LocalChatService } from '../src/conversations/local-chat-service.js';
import { ModelGatewayError } from '../src/models/chat-gateway.js';
import { uuid, requireCompatDatabaseUrl } from './helpers.js';

test('persistent local chat saves replies and recovers completed replays without another generation', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const characterId = uuid();
  const conversationIds: string[] = [];
  const personIds: string[] = [];
  const identityIds: string[] = [];
  const turnIds: string[] = [];
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({ id: characterId, name: `local-chat-${uuid()}` });
    const identity = new IdentityService(database);
    const sessions = new LocalChatSessionService(database, identity);
    let calls = 0;
    const service = new LocalChatService(sessions, database, { complete: async ({ messages: sent }) => {
      calls += 1;
      assert.equal(sent.at(-1)?.role, 'user');
      return { text: '  persisted reply  ', model: 'fixture', finishReason: 'stop', usage: null };
    } });
    const suffix = uuid();
    const evidence = createVerifiedChannelEvidence('qq', `local-cli:channel:${suffix}`, `local-cli:user:${suffix}`, 'private');
    const event = { platform: 'qq' as const, eventId: `local-cli:event:${suffix}`, senderPlatformId: `local-cli:user:${suffix}`, conversationPlatformId: `local-cli:channel:${suffix}`, conversationKind: 'private' as const, text: 'hello', timestamp: new Date().toISOString(), participantPlatformIds: [], participantsComplete: false };
    const first = await service.handle(characterId, event, evidence);
    conversationIds.push(first.conversationId); turnIds.push(first.turnId);
    const second = await new LocalChatService(sessions, database, { complete: async () => { calls += 1; throw new Error('must not replay'); } }).handle(characterId, event, evidence);
    const identityRows = await database.db.select({ personId: platformIdentities.personId, identityId: platformIdentities.id }).from(platformIdentities).where(eq(platformIdentities.platformUserId, event.senderPlatformId));
    personIds.push(...identityRows.map((row) => row.personId)); identityIds.push(...identityRows.map((row) => row.identityId));
    assert.equal(first.text, 'persisted reply');
    assert.equal(second.text, 'persisted reply');
    assert.equal(second.duplicate, true);
    assert.equal(calls, 1);
    const history = await sessions.readHistory(characterId, evidence);
    assert.deepEqual(history?.messages.map(({ role, text }) => [role, text]), [['user', 'hello'], ['assistant', 'persisted reply']]);
    const count = await database.db.select().from(messages).where(eq(messages.conversationId, first.conversationId));
    assert.equal(count.length, 2);
    assert.equal((await database.db.select().from(turns).where(eq(turns.conversationId, first.conversationId))).length, 1);
    assert.equal((await database.db.select().from(deliveryOutbox).where(inArray(deliveryOutbox.turnId, turnIds))).length, 1);
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      if (turnIds.length) await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, turnIds.flatMap((id) => [`turn:${id}:process`, `turn:${id}:deliver`])));
      if (turnIds.length) await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId, turnIds));
      if (conversationIds.length) {
        await database.db.delete(turns).where(inArray(turns.id, turnIds));
        await database.db.delete(messages).where(inArray(messages.conversationId, conversationIds));
        await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, conversationIds));
        await database.db.delete(conversations).where(inArray(conversations.id, conversationIds));
      }
      if (identityIds.length) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identityIds));
      if (personIds.length) await database.db.delete(people).where(inArray(people.id, personIds));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { primaryError ??= error; }
    if (cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), 'local chat integration cleanup failed');
  }
});

test('a busy concurrent request is rejected before acceptance and cannot enter active provider history', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const characterId = uuid(); const suffix = uuid();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstMessages: readonly { role: string; content: string }[] = [];
  let conversationId: string | undefined; let turnId: string | undefined;
  let identityId: string | undefined; let personId: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({ id: characterId, name: `local-chat-${suffix}` });
    const identity = new IdentityService(database); const sessions = new LocalChatSessionService(database, identity);
    const evidence = createVerifiedChannelEvidence('qq', `local-cli:channel:${suffix}`, `local-cli:user:${suffix}`, 'private');
    const service = new LocalChatService(sessions, database, { complete: async ({ messages: sent }) => {
      firstMessages = sent; await gate;
      return { text: 'first reply', model: 'fixture', finishReason: null, usage: null };
    } });
    const makeEvent = (eventId: string, text: string) => ({ platform: 'qq' as const, eventId, senderPlatformId: `local-cli:user:${suffix}`, conversationPlatformId: `local-cli:channel:${suffix}`, conversationKind: 'private' as const, text, timestamp: new Date().toISOString(), participantPlatformIds: [], participantsComplete: false });
    const firstPromise = service.handle(characterId, makeEvent(`first-${suffix}`, 'first user text'), evidence);
    const deadline = Date.now() + 5_000;
    while (!firstMessages.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(firstMessages.length, 1, 'first request reached the provider while holding the session guard');
    await assert.rejects(service.handle(characterId, makeEvent(`busy-${suffix}`, 'must not enter history'), evidence), { code: 'local_chat_busy' });
    release();
    const first = await firstPromise; conversationId = first.conversationId; turnId = first.turnId;
    const identities = await database.db.select({ id: platformIdentities.id, personId: platformIdentities.personId }).from(platformIdentities).where(eq(platformIdentities.platformUserId, `local-cli:user:${suffix}`));
    identityId = identities[0]?.id; personId = identities[0]?.personId;
    assert.deepEqual(firstMessages.map(({ role, content }) => [role, content]), [['user', 'first user text']]);
    assert.equal((await database.db.select().from(turns).where(eq(turns.conversationId, conversationId))).length, 1);
    assert.equal((await database.db.select().from(messages).where(eq(messages.conversationId, conversationId))).length, 2);
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      if (turnId) {
        await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, [`turn:${turnId}:process`, `turn:${turnId}:deliver`]));
        await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.turnId, turnId));
        await database.db.delete(turns).where(eq(turns.id, turnId));
      }
      if (conversationId) {
        await database.db.delete(messages).where(eq(messages.conversationId, conversationId));
        await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
        await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      }
      if (identityId) await database.db.delete(platformIdentities).where(eq(platformIdentities.id, identityId));
      if (personId) await database.db.delete(people).where(eq(people.id, personId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { primaryError ??= error; }
    if (cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), 'local chat concurrency cleanup failed');
  }
});

test('local profiles isolate history, reject forged evidence before generation, and release the guard after gateway failure', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const characterId = uuid(); const suffix = uuid();
  const users = [`local-cli:user:a-${suffix}`, `local-cli:user:b-${suffix}`];
  const channels = [`local-cli:channel:a-${suffix}`, `local-cli:channel:b-${suffix}`];
  const conversationIds: string[] = []; const turnIds: string[] = [];
  const peopleIds: string[] = []; const identityIds: string[] = [];
  let calls = 0;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({ id: characterId, name: `local-chat-${suffix}` });
    const identity = new IdentityService(database); const sessions = new LocalChatSessionService(database, identity);
    const evidenceA = createVerifiedChannelEvidence('qq', channels[0]!, users[0]!, 'private');
    const evidenceB = createVerifiedChannelEvidence('qq', channels[1]!, users[1]!, 'private');
    const service = new LocalChatService(sessions, database, { complete: async ({ messages: sent }) => {
      calls += 1;
      if (sent.at(-1)?.content === 'provider failure') throw new ModelGatewayError('model_upstream_error');
      return { text: `reply-${calls}`, model: 'fixture', finishReason: null, usage: null };
    } });
    const makeEvent = (user: string, channel: string, eventId: string, text: string) => ({ platform: 'qq' as const, eventId, senderPlatformId: user, conversationPlatformId: channel, conversationKind: 'private' as const, text, timestamp: new Date().toISOString(), participantPlatformIds: [], participantsComplete: false });
    await assert.rejects(service.handle(characterId, makeEvent(users[0]!, channels[0]!, `forged-${suffix}`, 'no provider call'), { kind: 'verified-channel', platform: 'qq', channelId: channels[0]! } as never), { code: 'invalid_evidence' });
    await assert.rejects(service.handle(characterId, makeEvent(users[0]!, channels[1]!, `mismatch-${suffix}`, 'no provider call'), evidenceB), { code: 'invalid_evidence' });
    assert.equal(calls, 0);
    const firstA = await service.handle(characterId, makeEvent(users[0]!, channels[0]!, `a1-${suffix}`, 'private a'), evidenceA);
    const firstB = await service.handle(characterId, makeEvent(users[1]!, channels[1]!, `b1-${suffix}`, 'private b'), evidenceB);
    const failed = makeEvent(users[0]!, channels[0]!, `a-fail-${suffix}`, 'provider failure');
    await assert.rejects(service.handle(characterId, failed, evidenceA), { code: 'model_upstream_error' });
    const afterFailure = await service.handle(characterId, makeEvent(users[0]!, channels[0]!, `a2-${suffix}`, 'after failure'), evidenceA);
    conversationIds.push(firstA.conversationId, firstB.conversationId); turnIds.push(firstA.turnId, firstB.turnId, afterFailure.turnId);
    assert.notEqual(firstA.conversationId, firstB.conversationId);
    assert.deepEqual((await sessions.readHistory(characterId, evidenceA))?.messages.map(({ text }) => text), ['private a', 'reply-1', 'provider failure', 'after failure', 'reply-4']);
    assert.deepEqual((await sessions.readHistory(characterId, evidenceB))?.messages.map(({ text }) => text), ['private b', 'reply-2']);
    assert.equal((await database.db.select().from(messages).where(eq(messages.conversationId, firstA.conversationId))).length, 5);
    const identities = await database.db.select({ id: platformIdentities.id, personId: platformIdentities.personId }).from(platformIdentities).where(inArray(platformIdentities.platformUserId, users));
    identityIds.push(...identities.map(({ id }) => id)); peopleIds.push(...identities.map(({ personId }) => personId));
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      const found = await database.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.characterId, characterId));
      const allConversationIds = found.map(({ id }) => id);
      const allTurns = allConversationIds.length ? await database.db.select({ id: turns.id }).from(turns).where(inArray(turns.conversationId, allConversationIds)) : [];
      const allTurnIds = allTurns.map(({ id }) => id);
      if (allTurnIds.length) {
        await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, allTurnIds.flatMap((id) => [`turn:${id}:process`, `turn:${id}:deliver`])));
        await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId, allTurnIds));
        await database.db.delete(turns).where(inArray(turns.id, allTurnIds));
      }
      if (allConversationIds.length) {
        await database.db.delete(messages).where(inArray(messages.conversationId, allConversationIds));
        await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, allConversationIds));
        await database.db.delete(conversations).where(inArray(conversations.id, allConversationIds));
      }
      if (identityIds.length) await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identityIds));
      if (peopleIds.length) await database.db.delete(people).where(inArray(people.id, peopleIds));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { primaryError ??= error; }
    if (cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), 'local profile isolation cleanup failed');
  }
});

test('history bounds to 200 messages and orders equal-time turns deterministically with user before assistant', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const characterId = uuid(); const suffix = uuid();
  const userId = `local-cli:user:${suffix}`; const channelId = `local-cli:channel:${suffix}`;
  let conversationId: string | undefined; let identityId: string | undefined; let personId: string | undefined;
  let captured: readonly { role: string; content: string }[] = [];
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({ id: characterId, name: `local-chat-${suffix}` });
    const identity = new IdentityService(database); const sessions = new LocalChatSessionService(database, identity);
    const evidence = createVerifiedChannelEvidence('qq', channelId, userId, 'private');
    const service = new LocalChatService(sessions, database, { complete: async ({ messages: sent }) => {
      captured = sent;
      return { text: `answer-${sent.at(-1)?.content}`, model: 'fixture', finishReason: null, usage: null };
    } });
    const fixedTime = '2000-01-01T00:00:00.000Z';
    for (let index = 0; index < 101; index += 1) {
      const result = await service.handle(characterId, {
        platform: 'qq', eventId: `bounded-${index}-${suffix}`, senderPlatformId: userId,
        conversationPlatformId: channelId, conversationKind: 'private', text: `question-${index}`,
        timestamp: fixedTime, participantPlatformIds: [], participantsComplete: false,
      }, evidence);
      conversationId = result.conversationId;
    }
    const identityRows = await database.db.select({ id: platformIdentities.id, personId: platformIdentities.personId }).from(platformIdentities).where(eq(platformIdentities.platformUserId, userId));
    identityId = identityRows[0]?.id; personId = identityRows[0]?.personId;
    const fixedDate = new Date(fixedTime);
    await database.db.update(messages).set({ receivedAt: fixedDate }).where(eq(messages.conversationId, conversationId!));
    await database.db.update(turns).set({ createdAt: fixedDate }).where(eq(turns.conversationId, conversationId!));
    await service.handle(characterId, {
      platform: 'qq', eventId: `bounded-final-${suffix}`, senderPlatformId: userId,
      conversationPlatformId: channelId, conversationKind: 'private', text: 'last-question',
      timestamp: fixedTime, participantPlatformIds: [], participantsComplete: false,
    }, evidence, { system: 'stable local persona' });
    await database.db.update(messages).set({ receivedAt: fixedDate }).where(eq(messages.conversationId, conversationId!));
    await database.db.update(turns).set({ createdAt: fixedDate }).where(eq(turns.conversationId, conversationId!));
    assert.equal(captured.length, 200);
    assert.deepEqual(captured[0], { role: 'system', content: 'stable local persona' });
    assert.equal(captured.length, 200, 'system prompt is included in the gateway 200-message cap');
    const history = (await sessions.readHistory(characterId, evidence, { limit: 200 }))?.messages ?? [];
    const historyAgain = (await sessions.readHistory(characterId, evidence, { limit: 200 }))?.messages ?? [];
    assert.equal(history.length, 200);
    assert.deepEqual(historyAgain.map(({ messageId }) => messageId), history.map(({ messageId }) => messageId), 'equal timestamps use stable ordering');
    const assertTurnOrder = (entries: readonly { role: string; text: string }[], allowPendingLastUser = false) => {
      let index = entries[0]?.role === 'assistant' ? 1 : 0;
      for (; index < entries.length; index += 2) {
        assert.equal(entries[index]?.role, 'user');
        const userText = entries[index]?.text ?? '';
        if (allowPendingLastUser && index === entries.length - 1) break;
        const assistant = entries[index + 1];
        assert.equal(assistant?.role, 'assistant');
        assert.equal(assistant?.text, `answer-${userText}`, JSON.stringify(entries.slice(Math.max(0, index - 2), Math.min(entries.length, index + 4))));
      }
    };
    assertTurnOrder(history);
    assertTurnOrder(captured.slice(1).map(({ role, content }) => ({ role, text: content })), true);
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      const rows = await database.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.characterId, characterId));
      const conversationIds = rows.map(({ id }) => id);
      const turnRows = conversationIds.length ? await database.db.select({ id: turns.id }).from(turns).where(inArray(turns.conversationId, conversationIds)) : [];
      const turnIds = turnRows.map(({ id }) => id);
      if (turnIds.length) {
        await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, turnIds.flatMap((id) => [`turn:${id}:process`, `turn:${id}:deliver`])));
        await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId, turnIds));
        await database.db.delete(turns).where(inArray(turns.id, turnIds));
      }
      if (conversationIds.length) {
        await database.db.delete(messages).where(inArray(messages.conversationId, conversationIds));
        await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, conversationIds));
        await database.db.delete(conversations).where(inArray(conversations.id, conversationIds));
      }
      if (identityId) await database.db.delete(platformIdentities).where(eq(platformIdentities.id, identityId));
      if (personId) await database.db.delete(people).where(eq(people.id, personId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { primaryError ??= error; }
    if (cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), 'bounded history integration cleanup failed');
  }
});
