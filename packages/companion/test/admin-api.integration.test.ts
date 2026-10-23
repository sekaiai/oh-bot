import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAdminApplication } from "../src/admin/app.js";
import { createDatabase } from "../src/database/database.js";
import {
  auditEvents,
  characters,
  circleMembers,
  conversationPolicies,
  conversations,
  deliveryOutbox,
  messages,
  modelProfiles,
  modelRoleBindings,
  people,
  socialCircles,
  turns,
} from "../src/database/schema/index.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { requireCompatDatabaseUrl, uuid } from "./helpers.js";

const adminToken = "f3a-admin-integration-token-long-enough-32";

test("HTTP admin writes persist rows and audit metadata while model keys stay outside storage and responses", async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const profileName = `f3a-${uuid()}`;
  const sentinel = "profile-key-must-never-appear";
  const credentialName = "F3A_TEST_CREDENTIAL_REF";
  const previousCredential = process.env[credentialName];
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let createdPersonId: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    process.env[credentialName] = sentinel;
    app = await createAdminApplication({ database, adminToken });
    const headers = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/admin/people",
      headers,
      payload: {
        displayName: "f3a-integration-person",
        aliases: ["api-person"],
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().displayName, "f3a-integration-person");
    const personId = created.json().id as string;
    createdPersonId = personId;
    const persistedPerson = await database.db
      .select()
      .from(people)
      .where(eq(people.id, personId));
    assert.equal(persistedPerson.length, 1);
    const audits = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "person_created"),
          eq(auditEvents.targetId, personId),
        ),
      );
    assert.equal(audits.length, 1);

    const profile = await app.inject({
      method: "POST",
      url: "/admin/model-profiles",
      headers,
      payload: {
        name: profileName,
        purpose: "chat",
        provider: "test",
        baseUrl: "https://example.invalid/v1",
        model: "safe-model",
        credentialRef: credentialName,
      },
    });
    assert.equal(profile.statusCode, 201);
    assert.equal(profile.json().credentialRef, credentialName);
    assert.equal(profile.json().configured, true);
    assert.equal(JSON.stringify(profile.json()).includes(sentinel), false);
    const stored = await database.db
      .select()
      .from(modelProfiles)
      .where(eq(modelProfiles.name, profileName));
    assert.equal(stored.length, 1);
    assert.equal(JSON.stringify(stored[0]).includes(sentinel), false);
    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/model-profiles",
      headers,
      payload: {
        name: profileName,
        purpose: "chat",
        provider: "test",
        baseUrl: "https://example.invalid/v1",
        model: "safe-model",
        credentialRef: credentialName,
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(
      (
        await database.db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, "model_profile_created"),
              eq(auditEvents.targetId, stored[0]!.id),
            ),
          )
      ).length,
      1,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (app) await app.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (createdPersonId) {
        await database.db
          .delete(auditEvents)
          .where(eq(auditEvents.targetId, createdPersonId));
        await database.db.delete(people).where(eq(people.id, createdPersonId));
      }
      const [profile] = await database.db.select({ id: modelProfiles.id }).from(modelProfiles).where(eq(modelProfiles.name, profileName));
      if (profile) await database.db.delete(auditEvents).where(and(eq(auditEvents.action, "model_profile_created"), eq(auditEvents.targetId, profile.id)));
      await database.db
        .delete(modelProfiles)
        .where(eq(modelProfiles.name, profileName));
    } catch (error) {
      cleanupError = error;
    }
    try {
      await database.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (previousCredential === undefined) delete process.env[credentialName];
    else process.env[credentialName] = previousCredential;
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test("HTTP circle audit rollback, group-policy CAS, purpose binding, and explicit delivery reconciliation", async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid().replaceAll("-", "");
  const characterId = uuid();
  const personId = uuid();
  const conversationId = uuid();
  const circleName = `f3a-${suffix}`;
  const profileName = `f3a-${suffix}-profile`;
  const deliveryIds = [uuid(), uuid()];
  const turnIds = [uuid(), uuid()];
  const messageIds = [uuid(), uuid()];
  const routineName = `f3a_fail_circle_audit_${suffix}`;
  const triggerName = `f3a_fail_circle_audit_${suffix}`;
  const token = "f3a-admin-mutation-integration-token-long-enough";
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let circleId: string | undefined;
  let profileId: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await database.db
      .insert(characters)
      .values({ id: characterId, name: `f3a-${suffix}` });
    await database.db
      .insert(people)
      .values({ id: personId, displayName: `f3a-${suffix}` });
    await database.db.insert(conversations).values({
      id: conversationId,
      characterId,
      platform: "qq",
      platformConversationId: `f3a-group-${suffix}`,
      kind: "group",
    });
    await database.db.insert(conversationPolicies).values({ conversationId });
    for (let index = 0; index < deliveryIds.length; index += 1) {
      await database.db.insert(messages).values({
        id: messageIds[index]!,
        conversationId,
        platform: "qq",
        platformEventId: `f3a-event-${suffix}-${index}`,
        role: "user",
      });
      await database.db.insert(turns).values({
        id: turnIds[index]!,
        conversationId,
        inboundMessageId: messageIds[index]!,
        personId,
        status: "receipt_unknown",
        graphThreadId: `f3a-thread-${suffix}-${index}`,
      });
      await database.db.insert(deliveryOutbox).values({
        id: deliveryIds[index]!,
        turnId: turnIds[index]!,
        conversationId,
        operationKey: `f3a-delivery-${suffix}-${index}`,
        content: { text: "generated" },
        status: "receipt_unknown",
      });
    }
    app = await createAdminApplication({ database, adminToken: token });
    const headers = { authorization: `Bearer ${token}` };
    const circle = await app.inject({
      method: "POST",
      url: "/admin/circles",
      headers,
      payload: { characterId, name: circleName },
    });
    assert.equal(circle.statusCode, 201);
    const activeCircleId = circle.json().id as string;
    circleId = activeCircleId;

    await database.db.execute(
      sql.raw(`
      create function companion.${routineName}() returns trigger language plpgsql as $$
      begin
        if new.metadata->>'personId' = '${personId}' then
          raise exception 'injected audit rollback';
        end if;
        return new;
      end;
      $$
    `),
    );
    await database.db.execute(
      sql.raw(`
      create trigger ${triggerName} before insert on companion.audit_events
      for each row when (new.action = 'circle_member_confirmed')
      execute function companion.${routineName}()
    `),
    );
    const rolledBack = await app.inject({
      method: "POST",
      url: `/admin/circles/${activeCircleId}/members`,
      headers,
      payload: { personId, confirmed: true },
    });
    assert.equal(rolledBack.statusCode, 500);
    assert.equal(
      (
        await database.db
          .select()
          .from(circleMembers)
          .where(eq(circleMembers.circleId, activeCircleId))
      ).length,
      0,
    );
    assert.equal(
      (
        await database.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "circle_member_confirmed"))
      ).some((row) => row.targetId === circleId),
      false,
    );
    await database.db.execute(
      sql.raw(`drop trigger ${triggerName} on companion.audit_events`),
    );
    await database.db.execute(
      sql.raw(`drop function companion.${routineName}()`),
    );

    const confirmed = await app.inject({
      method: "POST",
      url: `/admin/circles/${activeCircleId}/members`,
      headers,
      payload: { personId, confirmed: true },
    });
    assert.equal(confirmed.statusCode, 201);
    const removed = await app.inject({
      method: "DELETE",
      url: `/admin/circles/${activeCircleId}/members/${personId}`,
      headers,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      (
        await database.db
          .select()
          .from(circleMembers)
          .where(eq(circleMembers.circleId, activeCircleId))
      ).length,
      0,
    );

    const profile = await app.inject({
      method: "POST",
      url: "/admin/model-profiles",
      headers,
      payload: {
        name: profileName,
        purpose: "chat",
        provider: "test",
        baseUrl: "https://example.invalid/v1",
        model: "chat-model",
        credentialRef: "F3A_CREDENTIAL",
      },
    });
    assert.equal(profile.statusCode, 201);
    profileId = profile.json().id;
    const mismatch = await app.inject({
      method: "PUT",
      url: `/admin/characters/${characterId}/model-bindings`,
      headers,
      payload: { purpose: "embedding", profileId },
    });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(
      (
        await database.db
          .select()
          .from(modelRoleBindings)
          .where(eq(modelRoleBindings.characterId, characterId))
      ).length,
      0,
    );
    assert.equal(
      (
        await database.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "model_binding_updated"))
      ).some((row) => row.targetId === characterId),
      false,
    );

    const policy = {
      version: 1,
      triggerMode: "mentioned",
      circleDisclosureVerified: false,
      proactiveEnabled: false,
      quietStart: "22:00",
      quietEnd: "08:00",
      timeZone: "Etc/UTC",
      maxPerDay: 1,
    };
    const policyUpdated = await app.inject({
      method: "PUT",
      url: `/admin/conversations/${conversationId}/policy`,
      headers,
      payload: policy,
    });
    assert.equal(policyUpdated.statusCode, 200);
    assert.equal(policyUpdated.json().version, 2);
    const policyConflict = await app.inject({
      method: "PUT",
      url: `/admin/conversations/${conversationId}/policy`,
      headers,
      payload: policy,
    });
    assert.equal(policyConflict.statusCode, 409);
    assert.equal(
      (
        await database.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "conversation_policy_updated"))
      ).filter((row) => row.targetId === conversationId).length,
      1,
    );

    const retry = await app.inject({
      method: "POST",
      url: `/admin/deliveries/${deliveryIds[0]}/reconcile`,
      headers,
      payload: { decision: "retry" },
    });
    assert.equal(retry.statusCode, 201);
    const sent = await app.inject({
      method: "POST",
      url: `/admin/deliveries/${deliveryIds[1]}/reconcile`,
      headers,
      payload: { decision: "sent", receipt: `receipt-${suffix}` },
    });
    assert.equal(sent.statusCode, 201);
    const [retriedDelivery] = await database.db
      .select()
      .from(deliveryOutbox)
      .where(eq(deliveryOutbox.id, deliveryIds[0]!));
    const [sentDelivery] = await database.db
      .select()
      .from(deliveryOutbox)
      .where(eq(deliveryOutbox.id, deliveryIds[1]!));
    assert.equal(retriedDelivery?.status, "pending");
    assert.equal(sentDelivery?.status, "sent");
    assert.equal(
      (
        await database.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "delivery_reconciled"))
      ).filter((row) => deliveryIds.some((id) => id === row.targetId)).length,
      2,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (app) await app.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await database.db.execute(
        sql.raw(
          `drop trigger if exists ${triggerName} on companion.audit_events`,
        ),
      );
      await database.db.execute(
        sql.raw(`drop function if exists companion.${routineName}()`),
      );
      const auditTargets = [
        characterId,
        personId,
        conversationId,
        ...deliveryIds,
        circleId,
        profileId,
      ].filter((value): value is string => Boolean(value));
      await database.db
        .delete(auditEvents)
        .where(inArray(auditEvents.targetId, auditTargets));
      if (circleId) {
        await database.db
          .delete(circleMembers)
          .where(eq(circleMembers.circleId, circleId));
        await database.db
          .delete(socialCircles)
          .where(eq(socialCircles.id, circleId));
      }
      if (profileId)
        await database.db
          .delete(modelRoleBindings)
          .where(eq(modelRoleBindings.characterId, characterId));
      if (profileId)
        await database.db
          .delete(modelProfiles)
          .where(eq(modelProfiles.id, profileId));
      await database.db
        .delete(deliveryOutbox)
        .where(inArray(deliveryOutbox.id, deliveryIds));
      await database.db.delete(turns).where(inArray(turns.id, turnIds));
      await database.db
        .delete(messages)
        .where(inArray(messages.id, messageIds));
      await database.db
        .delete(conversationPolicies)
        .where(eq(conversationPolicies.conversationId, conversationId));
      await database.db
        .delete(conversations)
        .where(eq(conversations.id, conversationId));
      await database.db.delete(people).where(eq(people.id, personId));
      await database.db
        .delete(characters)
        .where(eq(characters.id, characterId));
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
