import './env.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { createDbClient } from './client.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '..', 'drizzle');

  const client = createDbClient({ connectionString: url });
  console.warn(`Running migrations from ${migrationsFolder} (driver: ${client.driver})`);

  if (client.driver === 'pglite') {
    await migratePglite(client.db, { migrationsFolder });
  } else {
    await migratePg(client.db, { migrationsFolder });
  }

  console.warn('Migrations complete.');
  await client.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
