import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve env in a way that's robust to cwd. Order: monorepo root .env,
// then packages/db/.env override.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '..', '..', '.env') });
loadEnv({ path: resolve(here, '..', '.env'), override: true });
