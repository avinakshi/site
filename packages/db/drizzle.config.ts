import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Load env from monorepo root, then allow a packages/db/.env override.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '..', '.env') });
loadEnv({ path: resolve(here, '.env'), override: true });

// `generate` doesn't need a real DB; allow a placeholder so schema diffing
// works without a running Postgres. `push`, `migrate`, `studio` will fail
// loudly later if DATABASE_URL is unset.
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
