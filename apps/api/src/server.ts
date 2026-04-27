import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ulid } from 'ulid';
import type { DbClient } from '@csm-chat/db';
import type { Config } from './config.js';
import requestIdPlugin from './plugins/request-id.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import authPlugin from './plugins/auth.js';
import chatAuthPlugin from './plugins/chat-auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import clientsRoutes from './routes/clients.js';
import sessionsRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import { buildAuthService } from './services/auth.service.js';
import { buildUserService } from './services/user.service.js';
import { buildClientService } from './services/client.service.js';
import { buildSessionService } from './services/session.service.js';
import { buildTokenService } from './services/token.service.js';
import { buildMessageService } from './services/message.service.js';

export interface BuildServerOptions {
  config: Config;
  dbClient: DbClient;
  version: string;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const { config, dbClient, version } = opts;

  const app = Fastify({
    genReqId: () => `req_${ulid()}`,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true, ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    disableRequestLogging: config.NODE_ENV === 'test',
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 1. CORS
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // 2. Helmet
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  });

  // 3. Cookie
  await app.register(fastifyCookie, {
    parseOptions: {
      domain: config.COOKIE_DOMAIN,
      sameSite: config.COOKIE_SAMESITE,
      secure: config.COOKIE_SECURE,
      httpOnly: true,
      path: '/',
    },
  });

  // 4. Request ID
  await app.register(requestIdPlugin);

  // 5. Rate limit (defaults; per-route overrides set in their routes).
  // Skipped in test mode so service-layer tests (lockout, rotation, etc.)
  // can exercise the underlying logic without 429-before-401 false fails.
  if (config.NODE_ENV !== 'test') {
    await app.register(fastifyRateLimit, {
      global: true,
      max: 60,
      timeWindow: '1 minute',
      allowList: (req) => req.url.startsWith('/health'),
      keyGenerator: (req) => req.ip ?? 'unknown',
    });
  }

  // 6. Logger — already configured.

  // 7. fastify-type-provider-zod — already wired.

  // 8. Error handler
  await app.register(errorHandlerPlugin, { baseUrl: config.API_BASE_URL });

  // ── Auth plugin (Bearer verifier decorators) ────────────────────────
  await app.register(authPlugin, { accessSecret: config.JWT_ACCESS_SECRET });
  await app.register(chatAuthPlugin, { sessionJwtSecret: config.SESSION_JWT_SECRET });

  // ── Routes ──────────────────────────────────────────────────────────
  await app.register(healthRoutes, { dbClient, version });

  const authService = buildAuthService({ db: dbClient.db, config });
  await app.register(authRoutes, { authService, config });

  const userService = buildUserService({ db: dbClient.db, config });
  await app.register(usersRoutes, { userService });

  const clientService = buildClientService({ db: dbClient.db });
  await app.register(clientsRoutes, { clientService });

  const sessionService = buildSessionService({ db: dbClient.db, config });
  const messageService = buildMessageService({ db: dbClient.db });
  await app.register(sessionsRoutes, { clientService, sessionService, messageService });

  const tokenService = buildTokenService({ db: dbClient.db, config });
  await app.register(chatRoutes, { db: dbClient.db, config, tokenService, messageService });

  return app;
}
