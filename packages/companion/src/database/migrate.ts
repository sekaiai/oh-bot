import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './database.js';

function findMigrationsFolder(moduleUrl: string): string {
  let currentDirectory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const migrationsFolder = resolve(currentDirectory, 'drizzle');
    if (existsSync(resolve(migrationsFolder, 'meta', '_journal.json'))) {
      return migrationsFolder;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error('Unable to locate the companion Drizzle migrations directory');
    }
    currentDirectory = parentDirectory;
  }
}

export async function migrateDatabase(database: Database): Promise<void> {
  await migrate(database.db, {
    migrationsFolder: findMigrationsFolder(import.meta.url),
    migrationsSchema: 'companion_migrations',
  });
}
