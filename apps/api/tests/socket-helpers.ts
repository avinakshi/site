import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@csm-chat/db';
import { buildServer } from '../src/server.js';
import { buildDbClient } from '../src/db.js';
import { loadConfig, type Config } from '../src/config.js';
import { attachSocketServer, type SocketHandle } from '../src/socket/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '..', '..', '..', 'packages', 'db', 'drizzle');

export interface SocketHarness {
  app: FastifyInstance;
  dbClient: DbClient;
  config: Config;
  port: number;
  baseUrl: string;
  socket: SocketHandle;
  cleanup: () => Promise<void>;
}

/**
 * Like buildHarness, but actually listens on a free port and attaches the
 * Socket.IO server. Required for any test that uses socket.io-client.
 */
export async function buildSocketHarness(): Promise<SocketHarness> {
  const tempDir = await mkdtemp(resolve(tmpdir(), 'csm-chat-ws-test-'));

  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: `file:${tempDir}/db`,
    PORT: '4002',
    JWT_ACCESS_SECRET: 'test-jwt-access-secret-' + 'x'.repeat(40),
    SESSION_TOKEN_SECRET: 'test-session-token-secret-' + 'x'.repeat(40),
    SESSION_JWT_SECRET: 'test-session-jwt-secret-' + 'x'.repeat(40),
    CORS_ORIGINS: 'http://localhost:3000',
    APP_BASE_URL: 'http://localhost:3000',
    API_BASE_URL: 'http://localhost:4000',
    // Speed up disconnect detection in tests.
    WS_PING_INTERVAL_MS: '500',
    WS_PING_TIMEOUT_MS: '1500',
  };

  const config = loadConfig(env as NodeJS.ProcessEnv);
  const dbClient = buildDbClient(config);
  if (dbClient.driver !== 'pglite') throw new Error('socket harness expects PGlite');
  await migratePglite(dbClient.db, { migrationsFolder });

  const built = await buildServer({ config, dbClient, version: 'test' });

  // Bind to a free local port so socket.io-client can connect.
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address() as AddressInfo;
  const port = addr.port;

  const socket = attachSocketServer({
    httpServer: built.app.server,
    config,
    db: dbClient.db,
    tokenService: built.services.tokenService,
    messageService: built.services.messageService,
    broadcaster: built.broadcaster,
  });

  return {
    app: built.app,
    dbClient,
    config,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    socket,
    cleanup: async () => {
      try {
        await socket.close();
      } catch {
        /* ignore */
      }
      await built.app.close();
      await dbClient.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
