import { createDatabase, loadDatabaseConfig } from './database.js';
import { migrateDatabase } from './migrate.js';

const database = createDatabase(loadDatabaseConfig(process.env).databaseUrl);
try {
  await migrateDatabase(database);
} finally {
  await database.close();
}
