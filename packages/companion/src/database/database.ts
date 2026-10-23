import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';
export interface Database { readonly pool: Pool; readonly db: NodePgDatabase<typeof schema>; close(): Promise<void> }
export function createDatabase(databaseUrl:string):Database { const pool=new Pool({connectionString:databaseUrl,connectionTimeoutMillis:10000,query_timeout:10000}); const db=drizzle(pool,{schema}); return {pool,db,close:()=>pool.end()}; }
export function loadDatabaseConfig(env:NodeJS.ProcessEnv):{databaseUrl:string} { const databaseUrl=env.COMPANION_DATABASE_URL; if(!databaseUrl) throw new Error('COMPANION_DATABASE_URL is required'); return {databaseUrl}; }
