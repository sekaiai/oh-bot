import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createAdminApplication } from "../src/admin/app.js";
import { createDatabase } from "../src/database/database.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { requireCompatDatabaseUrl, uuid } from "./helpers.js";

test("health becomes unready when a required companion table is temporarily unavailable", async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const renamedTable = `model_profiles_health_${uuid().replaceAll("-", "")}`;
  const adminToken = "f3a-health-integration-token-long-enough-32";
  let app: Awaited<ReturnType<typeof createAdminApplication>> | undefined;
  let renamed = false;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    app = await createAdminApplication({ database, adminToken });
    const ready = await app.inject({ method: "GET", url: "/health" });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().databaseReady, true);

    await database.db.execute(
      sql.raw(`alter table companion.model_profiles rename to ${renamedTable}`),
    );
    renamed = true;
    const missingTable = await app.inject({ method: "GET", url: "/health" });
    assert.equal(missingTable.statusCode, 200);
    assert.equal(missingTable.json().databaseReady, false);
    assert.equal(missingTable.json().status, "unready");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (renamed) {
        await database.db.execute(
          sql.raw(
            `alter table companion.${renamedTable} rename to model_profiles`,
          ),
        );
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (app) await app.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await database.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});
