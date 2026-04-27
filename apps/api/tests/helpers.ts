import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildServer } from '../src/server.js';
import { buildDbClient } from '../src/db.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DbClient } from '@csm-chat/db';
import type { FastifyInstance } from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '..', '..', '..', 'packages', 'db', 'drizzle');

export interface TestHarness {
  app: FastifyInstance;
  dbClient: DbClient;
  config: Config;
  tempDir: string;
  cleanup: () => Promise<void>;
}

export interface BuildHarnessOptions {
  /** Override env values for this run. */
  env?: Record<string, string | undefined>;
  /** Skip running migrations on the temp DB (used by db-down tests). */
  skipMigrations?: boolean;
}

/**
 * Spins up a Fastify server with a fresh PGlite database in a temp dir.
 * Migrations are applied unless `skipMigrations` is set.
 */
export async function buildHarness(opts: BuildHarnessOptions = {}): Promise<TestHarness> {
  const tempDir = await mkdtemp(resolve(tmpdir(), 'csm-chat-api-test-'));

  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: `file:${tempDir}/db`,
    PORT: '4001',
    JWT_ACCESS_SECRET: 'test-jwt-access-secret-' + 'x'.repeat(40),
    SESSION_TOKEN_SECRET: 'test-session-token-secret-' + 'x'.repeat(40),
    SESSION_JWT_SECRET: 'test-session-jwt-secret-' + 'x'.repeat(40),
    CORS_ORIGINS: 'http://localhost:3000',
    APP_BASE_URL: 'http://localhost:3000',
    API_BASE_URL: 'http://localhost:4000',
    ...opts.env,
  };

  const config = loadConfig(env as NodeJS.ProcessEnv);
  const dbClient = buildDbClient(config);

  if (!opts.skipMigrations) {
    if (dbClient.driver !== 'pglite') {
      throw new Error('Test harness expects PGlite');
    }
    await migratePglite(dbClient.db, { migrationsFolder });
  }

  const app = await buildServer({ config, dbClient, version: 'test' });

  return {
    app,
    dbClient,
    config,
    tempDir,
    cleanup: async () => {
      await app.close();
      await dbClient.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
