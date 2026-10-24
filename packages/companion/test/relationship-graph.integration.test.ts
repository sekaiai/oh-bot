import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { createAdminApplication } from "../src/admin/app.js";
import { createDatabase } from "../src/database/database.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { characters, conversations, interactionEvents, messages, people, primaryRelationshipBindings, relationshipStates } from "../src/database/schema/index.js";
import { requireCompatDatabaseUrl, uuid } from "./helpers.js";

const adminToken = "relationship-graph-integration-token-32";

test("relationship graph exposes only grounded live relationships for the requested character", async () => {
  const databaseUrl = requireCompatDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const ids = { characters: [] as string[], people: [] as string[], conversations: [] as string[], messages: [] as string[] };
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  try {
    await migrateDatabase(database);
    const characterId = uuid(), otherCharacterId = uuid();
    ids.characters.push(characterId, otherCharacterId);
    await database.db.insert(characters).values([{ id: characterId, name: "图谱角色" }, { id: otherCharacterId, name: "隔离角色" }]);
    const activeId = uuid(), partnerId = uuid(), erasedId = uuid(), otherOnlyId = uuid();
    ids.people.push(activeId, partnerId, erasedId, otherOnlyId);
    await database.db.insert(people).values([
      { id: activeId, displayName: "互动者" }, { id: partnerId, displayName: null },
      { id: erasedId, displayName: "已擦除" }, { id: otherOnlyId, displayName: "另一个角色" },
    ]);
    await database.db.insert(primaryRelationshipBindings).values({ characterId, personId: partnerId, createdBy: "test" });
    await database.db.insert(relationshipStates).values([
      { characterId, personId: activeId, familiarity: 0.4, trust: 0.7, stage: "close" },
      { characterId, personId: erasedId, familiarity: 0.9, trust: 0.9, stage: "partner" },
      { characterId: otherCharacterId, personId: otherOnlyId, familiarity: 0.8, trust: 0.8, stage: "known" },
    ]);
    await database.db.update(people).set({ status: "erased" }).where(eq(people.id, erasedId));
    const convId = uuid(), otherConvId = uuid();
    ids.conversations.push(convId, otherConvId);
    await database.db.insert(conversations).values([
      { id: convId, characterId, platform: "qq", platformConversationId: uuid(), kind: "private" },
      { id: otherConvId, characterId: otherCharacterId, platform: "qq", platformConversationId: uuid(), kind: "private" },
    ]);
    const liveMessageId = uuid(), deletedMessageId = uuid(), otherRoleMessageId = uuid();
    ids.messages.push(liveMessageId, deletedMessageId, otherRoleMessageId);
    await database.db.insert(messages).values([
      { id: liveMessageId, conversationId: convId, personId: activeId, platform: "qq", platformEventId: uuid(), role: "user", occurredAt: new Date("2026-10-24T00:00:00.000Z"), text: "PRIVATE_MESSAGE_BODY" },
      { id: deletedMessageId, conversationId: convId, personId: activeId, platform: "qq", platformEventId: uuid(), role: "user", text: "DELETED_PRIVATE_BODY", deletedAt: new Date() },
      { id: otherRoleMessageId, conversationId: otherConvId, personId: otherOnlyId, platform: "qq", platformEventId: uuid(), role: "user", text: "OTHER_CHARACTER_BODY" },
    ]);
    await database.db.insert(interactionEvents).values([
      { eventKey: `live-1:${uuid()}`, characterId, personId: activeId, sourceMessageId: liveMessageId, kind: "conversation", payload: {}, appliedAt: new Date() },
      { eventKey: `live-2:${uuid()}`, characterId, personId: activeId, sourceMessageId: liveMessageId, kind: "appreciation", payload: {}, appliedAt: new Date() },
      { eventKey: `deleted:${uuid()}`, characterId, personId: activeId, sourceMessageId: deletedMessageId, kind: "conversation", payload: {}, appliedAt: new Date() },
      { eventKey: `unapplied:${uuid()}`, characterId, personId: activeId, sourceMessageId: liveMessageId, kind: "conversation", payload: {}, appliedAt: null },
      { eventKey: `cross-character-source:${uuid()}`, characterId, personId: otherOnlyId, sourceMessageId: otherRoleMessageId, kind: "conversation", payload: {}, appliedAt: new Date() },
      { eventKey: `other-role:${uuid()}`, characterId: otherCharacterId, personId: otherOnlyId, sourceMessageId: otherRoleMessageId, kind: "conversation", payload: {}, appliedAt: new Date() },
    ]);
    app = await createAdminApplication({ database, adminToken });
    const url = `/admin/characters/${characterId}/relationship-graph`;
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.deepEqual(result.character, { id: characterId, name: "图谱角色" });
    assert.equal(result.truncated, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_MESSAGE_BODY"), false);
    assert.equal(JSON.stringify(result).includes("DELETED_PRIVATE_BODY"), false);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0], { personId: partnerId, displayName: null, familiarity: null, trust: null, stage: null, eventCount: 0, lastInteractionAt: null, isPrimaryPartner: true });
    assert.deepEqual(result.items[1], { personId: activeId, displayName: "互动者", familiarity: 0.4, trust: 0.7, stage: "close", eventCount: 2, lastInteractionAt: "2026-10-24T00:00:00.000Z", isPrimaryPartner: false });
    assert.equal((await app.inject({ method: "GET", url: `/admin/characters/${uuid()}/relationship-graph`, headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 404);

    const boundaryIds = Array.from({ length: 101 }, () => uuid());
    ids.people.push(...boundaryIds);
    await database.db.insert(people).values(boundaryIds.map((id) => ({ id, displayName: id })));
    await database.db.insert(relationshipStates).values(boundaryIds.map((personId) => ({ characterId, personId, familiarity: 0, trust: 0 })));
    const boundary = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(boundary.statusCode, 200);
    assert.equal(boundary.json().items.length, 100);
    assert.equal(boundary.json().truncated, true);
    const boundaryItemIds = boundary.json().items.map((item: { personId: string }) => item.personId);
    assert.deepEqual(boundaryItemIds.slice(0, 2), [partnerId, activeId]);
    assert.deepEqual(boundaryItemIds.slice(2), [...boundaryIds].sort().slice(0, 98));
  } finally {
    if (app) await app.close();
    if (ids.characters.length) await database.db.delete(interactionEvents).where(inArray(interactionEvents.characterId, ids.characters));
    if (ids.messages.length) await database.db.delete(messages).where(inArray(messages.id, ids.messages));
    if (ids.conversations.length) await database.db.delete(conversations).where(inArray(conversations.id, ids.conversations));
    if (ids.characters.length) {
      await database.db.delete(relationshipStates).where(inArray(relationshipStates.characterId, ids.characters));
      await database.db.delete(primaryRelationshipBindings).where(inArray(primaryRelationshipBindings.characterId, ids.characters));
    }
    if (ids.people.length) await database.db.delete(people).where(inArray(people.id, ids.people));
    if (ids.characters.length) await database.db.delete(characters).where(inArray(characters.id, ids.characters));
    await database.close();
  }
});
