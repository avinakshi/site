import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { initSentry } from './lib/sentry.js';
import { buildDbClient } from './db.js';
import { buildServer } from './server.js';
import { attachSocketServer } from './socket/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

  initSentry({
    dsn: config.SENTRY_DSN_API,
    environment: config.SENTRY_ENVIRONMENT,
    release: pkg.version,
  });

  const dbClient = buildDbClient(config);
  const built = await buildServer({ config, dbClient, version: pkg.version });
  const { app, broadcaster, services } = built;

  let socketHandle: { close(): Promise<void> } | null = null;

  const onShutdown = async (signal: string): Promise<void> => {
    app.log.warn({ signal }, 'shutting down');
    try {
      if (socketHandle) await socketHandle.close();
    } catch (err) {
      app.log.error({ err }, 'socket.close failed');
    }
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'app.close failed');
    }
    try {
      await dbClient.close();
    } catch (err) {
      app.log.error({ err }, 'dbClient.close failed');
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void onShutdown('SIGINT'));
  process.once('SIGTERM', () => void onShutdown('SIGTERM'));

  try {
    const address = await app.listen({ port: config.PORT, host: '0.0.0.0' });

    // Attach Socket.IO to the live HTTP server now that it's listening.
    socketHandle = attachSocketServer({
      httpServer: app.server,
      config,
      db: dbClient.db,
      tokenService: services.tokenService,
      messageService: services.messageService,
      broadcaster,
    });

    app.log.info(
      { version: pkg.version, env: config.NODE_ENV, address, dbDriver: dbClient.driver },
      'csm-chat api ready (HTTP + WS)',
    );
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
