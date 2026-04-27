import { createDbClient, type DbClient } from '@csm-chat/db';
import { sql } from 'drizzle-orm';
import type { Config } from './config.js';

export function buildDbClient(config: Config): DbClient {
  return createDbClient({
    connectionString: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    idleTimeoutMs: config.DATABASE_POOL_IDLE_TIMEOUT_MS,
  });
}

/** Returns true if `SELECT 1` succeeds within the given budget. */
export async function pingDb(client: DbClient, timeoutMs = 2000): Promise<boolean> {
  try {
    const probe = client.db.execute(sql`SELECT 1 AS ok`);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db ping timeout')), timeoutMs),
    );
    await Promise.race([probe, timeout]);
    return true;
  } catch {
    return false;
  }
}
