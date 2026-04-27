import './env.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDbClient } from './client.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '..', 'drizzle');

  const { db, close } = createDbClient({ connectionString: url });
  console.warn('Running migrations from', migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.warn('Migrations complete.');
  await close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
