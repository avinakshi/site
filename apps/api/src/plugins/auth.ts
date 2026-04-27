import fp from 'fastify-plugin';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { createProblem, type UserRole } from '@csm-chat/shared';
import { isExpiredJwt, verifyAccessToken } from '../lib/jwt.js';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
  interface FastifyInstance {
    /** Verify a Bearer access token; sets req.user or throws 401. */
    verifyAuth: preHandlerHookHandler;
    /** Verify Bearer + require role==='admin'. */
    requireAdmin: preHandlerHookHandler;
  }
}

interface AuthPluginOptions {
  accessSecret: string;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const { accessSecret } = opts;

  async function verifyAuthHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw createProblem('UNAUTHENTICATED', { requestId: req.id, instance: req.url });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw createProblem('UNAUTHENTICATED', { requestId: req.id, instance: req.url });
    }
    try {
      const payload = await verifyAccessToken(token, accessSecret);
      req.user = { id: payload.sub, role: payload.role };
    } catch (err) {
      throw createProblem(isExpiredJwt(err) ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', {
        requestId: req.id,
        instance: req.url,
      });
    }
  }

  async function requireAdminHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await verifyAuthHandler(req, reply);
    if (req.user?.role !== 'admin') {
      throw createProblem('FORBIDDEN', { requestId: req.id, instance: req.url });
    }
  }

  app.decorate('verifyAuth', verifyAuthHandler);
  app.decorate('requireAdmin', requireAdminHandler);
};

export default fp(authPlugin, { name: 'auth' });
