import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbClientOptions {
  connectionString: string;
  poolMax?: number;
  idleTimeoutMs?: number;
}

export interface DbClient {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDbClient(opts: DbClientOptions): DbClient {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.poolMax ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
