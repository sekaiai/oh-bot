export class IsolatedDatabaseError extends Error {
  constructor() {
    super('COMPAT_DATABASE_URL database name must end with _compat');
    this.name = 'IsolatedDatabaseError';
  }
}

export function assertIsolatedDatabase(databaseUrl: string): void {
  let database: URL;
  try { database = new URL(databaseUrl); }
  catch { throw new IsolatedDatabaseError(); }
  if ((database.protocol !== 'postgres:' && database.protocol !== 'postgresql:') || !database.pathname.slice(1).endsWith('_compat')) {
    throw new IsolatedDatabaseError();
  }
}
