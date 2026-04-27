import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

// Order: monorepo root .env, then packages/db/.env override.
loadEnv({ path: resolve(repoRoot, '.env') });
loadEnv({ path: resolve(here, '..', '.env'), override: true });

// Local-dev default: PGlite file-backed in <repo>/.local-data/dev-db so the
// monorepo works out of the box without Docker or a cloud Postgres. Real
// deployments MUST set DATABASE_URL to a postgres:// URL via the platform.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${resolve(repoRoot, '.local-data', 'dev-db')}`;
}
