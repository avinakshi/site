import './env.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import bcrypt from 'bcrypt';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { users } from './schema.js';

/**
 * End-to-end schema check. Spins up a throwaway PGlite database in a
 * temp dir, applies all migrations, runs a seed, queries the result,
 * and tears down. Intended for CI and for confirming Step 2 without
 * needing Docker or a long-lived database.
 */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '..', 'drizzle');
  const tempDir = await mkdtemp(resolve(tmpdir(), 'csm-chat-verify-'));
  const connectionString = `file:${tempDir}/db`;

  console.warn(`[verify] temp db: ${connectionString}`);
  const client = createDbClient({ connectionString });
  if (client.driver !== 'pglite') {
    throw new Error('verify expects PGlite for temp-dir isolation');
  }

  try {
    console.warn('[verify] applying migrations…');
    await migratePglite(client.db, { migrationsFolder });

    console.warn('[verify] checking pg_class for expected tables…');
    const expectedTables = [
      'users',
      'refresh_tokens',
      'clients',
      'sessions',
      'session_devices',
      'messages',
      'audit_log',
    ];
    const tableRows = await client.db.execute(sql`
      SELECT relname FROM pg_class
      WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
      ORDER BY relname
    `);
    const found = new Set((tableRows.rows as Array<{ relname: string }>).map((r) => r.relname));
    for (const t of expectedTables) {
      if (!found.has(t)) throw new Error(`missing table: ${t}`);
    }
    console.warn(`[verify] tables present: ${[...found].join(', ')}`);

    console.warn('[verify] inserting seed users…');
    const passwordHash = await bcrypt.hash('Admin123!@#456', 12);
    await client.db
      .insert(users)
      .values([
        { email: 'admin@example.com', name: 'Admin', role: 'admin', passwordHash },
        { email: 'csm1@example.com', name: 'CSM One', role: 'csm', passwordHash },
        { email: 'csm2@example.com', name: 'CSM Two', role: 'csm', passwordHash },
      ])
      .onConflictDoNothing();

    console.warn('[verify] querying users…');
    const rowsResult = await client.db.execute(
      sql`SELECT email, name, role FROM users ORDER BY email`,
    );
    const rows = rowsResult.rows as Array<{ email: string; name: string; role: string }>;
    if (rows.length !== 3) throw new Error(`expected 3 users, got ${rows.length}`);
    for (const row of rows) {
      console.warn(`  ${row.email.padEnd(20)} ${row.role.padEnd(6)} ${row.name}`);
    }

    console.warn('[verify] checking updated_at trigger fires on UPDATE…');
    const before = await client.db.execute(
      sql`SELECT updated_at FROM users WHERE email = 'admin@example.com'`,
    );
    const beforeAt = (before.rows[0] as { updated_at: Date }).updated_at;
    await new Promise((r) => setTimeout(r, 50));
    await client.db.execute(
      sql`UPDATE users SET name = 'Admin (touched)' WHERE email = 'admin@example.com'`,
    );
    const after = await client.db.execute(
      sql`SELECT updated_at FROM users WHERE email = 'admin@example.com'`,
    );
    const afterAt = (after.rows[0] as { updated_at: Date }).updated_at;
    if (new Date(afterAt).getTime() <= new Date(beforeAt).getTime()) {
      throw new Error('updated_at trigger did not fire');
    }
    console.warn(`[verify] updated_at advanced: ${beforeAt} → ${afterAt}`);

    console.warn('[verify] OK ✅');
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
