import { randomUUID } from 'node:crypto';
export const uuid=()=>randomUUID();
export function requireCompatDatabaseUrl():string {
  const value = process.env.CORE_TEST_DATABASE_URL;
  if (!value) throw new Error('CORE_TEST_DATABASE_URL must be explicitly set');
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('CORE_TEST_DATABASE_URL must use PostgreSQL');
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith('_compat')) throw new Error('CORE_TEST_DATABASE_URL database name must end with _compat');
  return value;
}

export function requireWorkerDatabaseUrl(): string {
  const value = process.env.WORKER_TEST_DATABASE_URL;
  if (!value) throw new Error('WORKER_TEST_DATABASE_URL must be explicitly set');
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('WORKER_TEST_DATABASE_URL must use PostgreSQL');
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== 'oh_bot_worker_compat') throw new Error('WORKER_TEST_DATABASE_URL must target oh_bot_worker_compat');
  return value;
}
