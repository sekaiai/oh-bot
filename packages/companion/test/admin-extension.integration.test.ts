import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createAdminApplication } from '../src/admin/app.js';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { auditEvents, characters, characterVersions } from '../src/database/schema/index.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';

const token = 'companion-admin-test-token-long-enough-32';

test('admin extension uses bearer login, exposes real readiness, and publishes persona with CAS audit', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const characterId = uuid();
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({ id: characterId, name: `extension-${characterId}` });
    app = await createAdminApplication({ database, adminToken: token });
    const denied = await app.inject({ method: 'POST', url: '/admin/login', payload: { password: 'wrong-token' } });
    assert.equal(denied.statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { password: token } });
    assert.equal(login.statusCode, 201);
    assert.equal(login.json().token, token);
    const headers = { authorization: `Bearer ${token}` };
    const overview = await app.inject({ method: 'GET', url: '/admin/overview', headers });
    assert.equal(overview.statusCode, 200);
    assert.equal(typeof overview.json().configured.model, 'boolean');
    const created = await app.inject({ method: 'POST', url: `/admin/persona/${characterId}`, headers, payload: {
      expectedVersion: 1, content: '{"voice":"clear"}', auditReason: 'initial reviewed persona',
    } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().revision, 1);
    const conflict = await app.inject({ method: 'POST', url: `/admin/persona/${characterId}`, headers, payload: {
      expectedVersion: 1, content: '{"voice":"stale"}', auditReason: 'stale update attempt',
    } });
    assert.equal(conflict.statusCode, 409);
    const listed = await app.inject({ method: 'GET', url: `/admin/persona/${characterId}`, headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal((await database.db.select().from(characterVersions).where(eq(characterVersions.characterId, characterId))).length, 1);
    assert.equal((await database.db.select().from(auditEvents).where(eq(auditEvents.action, 'persona_published'))).length, 1);
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      await database.db.delete(auditEvents).where(eq(auditEvents.targetId, characterId));
      await database.db.update(characters).set({ currentVersionId: null }).where(eq(characters.id, characterId));
      await database.db.delete(characterVersions).where(eq(characterVersions.characterId, characterId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await app?.close(); } catch (error) { primaryError ??= error; }
    try { await database.close(); } catch (error) { primaryError ??= error; }
    if (cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), 'admin extension cleanup failed');
  }
});
