import { mkdirSync } from 'node:fs';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import * as schema from './schema.js';

export type Schema = typeof schema;

/**
 * App-level type. Drizzle's query API is identical across drivers, so most
 * call sites can use this directly. For driver-specific operations (like
 * `migrate`), discriminate via `client.driver`.
 */
export type Database = NodePgDatabase<Schema> | PgliteDatabase<Schema>;

export interface DbClientOptions {
  connectionString: string;
  poolMax?: number;
  idleTimeoutMs?: number;
}

export type DbClient =
  | {
      driver: 'pg';
      db: NodePgDatabase<Schema>;
      pool: pg.Pool;
      close: () => Promise<void>;
    }
  | {
      driver: 'pglite';
      db: PgliteDatabase<Schema>;
      pglite: PGlite;
      close: () => Promise<void>;
    };

export function createDbClient(opts: DbClientOptions): DbClient {
  const url = opts.connectionString;

  // PGlite: file-backed (or in-memory) embedded Postgres for local dev/tests.
  // Use `file:./path` for file-backed, or `pglite://memory` / `file::memory:`
  // for in-memory.
  if (url.startsWith('file:') || url.startsWith('pglite:')) {
    const stripped = url.replace(/^(file|pglite):(\/\/)?/, '');
    const dataDir =
      stripped === '' || stripped === ':memory:' || stripped === 'memory' ? undefined : stripped;
    if (dataDir) {
      // PGlite uses mkdirSync (non-recursive) for the data dir, so the
      // parent must exist. Create the whole path up-front.
      mkdirSync(dataDir, { recursive: true });
    }
    const pglite = new PGlite(dataDir);
    const db = drizzlePglite(pglite, { schema });
    return {
      driver: 'pglite',
      db,
      pglite,
      close: async () => {
        if (pglite.closed) return;
        try {
          await pglite.close();
        } catch (err) {
          if (!/closed/i.test(String(err))) throw err;
        }
      },
    };
  }

  // node-postgres: real Postgres (Supabase / Railway / self-hosted).
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.poolMax ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
  });
  const db = drizzlePg(pool, { schema });
  return {
    driver: 'pg',
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
