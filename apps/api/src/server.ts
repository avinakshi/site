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
import healthRoutes from './routes/health.js';

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
    bodyLimit: 1024 * 1024, // 1 MB; per-route overrides for chat.
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 1. CORS
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // 2. Helmet — security headers
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

  // 4. Request ID — sets X-Request-Id on every response.
  await app.register(requestIdPlugin);

  // 5. Rate limit — defaults; per-route overrides set in their respective steps.
  await app.register(fastifyRateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/health'),
    keyGenerator: (req) => req.ip ?? 'unknown',
  });

  // 6. Logger — already configured via Fastify constructor above.

  // 7. fastify-type-provider-zod — already wired via setValidatorCompiler.

  // 8. Error handler — RFC 7807 Problem responses.
  await app.register(errorHandlerPlugin, { baseUrl: config.API_BASE_URL });

  // ── Routes ───────────────────────────────────────────────────────────
  await app.register(healthRoutes, { dbClient, version });

  return app;
}
