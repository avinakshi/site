import type { FastifyPluginAsync } from 'fastify';
import { healthResponseSchema, readyResponseSchema } from '@csm-chat/shared';
import type { DbClient } from '@csm-chat/db';
import { pingDb } from '../db.js';

interface HealthRoutesOptions {
  dbClient: DbClient;
  version: string;
}

const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, opts) => {
  const { dbClient, version } = opts;

  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: { response: { 200: healthResponseSchema } },
    },
    async () => ({
      status: 'ok' as const,
      uptime: process.uptime(),
      version,
    }),
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema } },
    },
    async (_req, reply) => {
      const dbOk = await pingDb(dbClient);
      const body = {
        status: (dbOk ? 'ok' : 'degraded') as 'ok' | 'degraded',
        checks: { database: (dbOk ? 'ok' : 'fail') as 'ok' | 'fail' },
      };
      reply.status(dbOk ? 200 : 503);
      return body;
    },
  );
};

export default healthRoutes;
