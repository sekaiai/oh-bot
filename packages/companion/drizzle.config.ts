import { defineConfig } from 'drizzle-kit';

if (!process.env.COMPANION_DATABASE_URL) {
  throw new Error('COMPANION_DATABASE_URL is required');
}

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.COMPANION_DATABASE_URL },
  schemaFilter: ['companion'],
  migrations: { schema: 'companion_migrations', table: '__drizzle_migrations' },
});
