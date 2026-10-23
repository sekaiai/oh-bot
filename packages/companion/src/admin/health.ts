import { sql } from "drizzle-orm";
import * as schema from "../database/schema/index.js";
import type { Database } from "../database/database.js";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };

const drizzleName = Symbol.for("drizzle:Name");
const drizzleSchema = Symbol.for("drizzle:Schema");
export const requiredCompanionTables = Object.values(schema).flatMap(
  (value) => {
    if (!value || typeof value !== "object" || !(drizzleName in value))
      return [];
    const table = value as Record<symbol, unknown>;
    return table[drizzleSchema] === "companion" &&
      typeof table[drizzleName] === "string"
      ? [table[drizzleName]]
      : [];
  },
);

const expectedMigrationCount = journal.entries.length;

/** Read-only readiness shared by public health, admin status and worker startup. */
export async function checkWorkerQueueReady(database: Database): Promise<boolean> {
  try {
    const result = await database.db.execute(sql`
      select to_regclass('companion_jobs.job') as job_table,
             to_regclass('companion_jobs.queue') as queue_table,
             to_regclass('companion_jobs.version') as version_table
    `);
    const row = result.rows[0] as { job_table?: string | null; queue_table?: string | null; version_table?: string | null } | undefined;
    return Boolean(row?.job_table && row.queue_table && row.version_table);
  } catch {
    return false;
  }
}

export async function checkDatabaseReady(database: Database): Promise<boolean> {
  try {
    const result = await database.db.execute(sql`
      select
        to_regclass('companion_migrations.__drizzle_migrations') as migration_table,
        (
          select count(*)::int from information_schema.tables
          where table_schema = 'companion'
            and table_name in (${sql.join(
              requiredCompanionTables.map((name) => sql`${name}`),
              sql`, `,
            )})
        ) as table_count
    `);
    const row = result.rows[0] as
      | { migration_table?: string | null; table_count?: number }
      | undefined;
    if (
      !row?.migration_table ||
      Number(row.table_count ?? 0) !== requiredCompanionTables.length
    ) {
      return false;
    }
    const migrations = await database.db.execute(sql`
      select count(*)::int as applied from companion_migrations.__drizzle_migrations
    `);
    const applied = Number(
      (migrations.rows[0] as { applied?: number } | undefined)?.applied ?? 0,
    );
    return applied >= expectedMigrationCount && await checkWorkerQueueReady(database);
  } catch {
    return false;
  }
}
