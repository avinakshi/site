import fp from 'fastify-plugin';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { createProblem } from '@csm-chat/shared';
import { isExpiredJwt, verifySessionJwt } from '../lib/jwt.js';

export interface ChatIdentity {
  sessionId: string;
  deviceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    chat?: ChatIdentity;
  }
  interface FastifyInstance {
    /** Verify session JWT bearer; sets req.chat or throws 401. */
    verifyChatAuth: preHandlerHookHandler;
  }
}

interface ChatAuthOptions {
  sessionJwtSecret: string;
}

const chatAuthPlugin: FastifyPluginAsync<ChatAuthOptions> = async (app, opts) => {
  const { sessionJwtSecret } = opts;

  async function verifyChatAuthHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw createProblem('UNAUTHENTICATED', { requestId: req.id, instance: req.url });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw createProblem('UNAUTHENTICATED', { requestId: req.id, instance: req.url });
    }
    try {
      const payload = await verifySessionJwt(token, sessionJwtSecret);
      req.chat = { sessionId: payload.sub, deviceId: payload.did };
    } catch (err) {
      throw createProblem(isExpiredJwt(err) ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', {
        requestId: req.id,
        instance: req.url,
      });
    }
  }

  app.decorate('verifyChatAuth', verifyChatAuthHandler);
};

export default fp(chatAuthPlugin, { name: 'chat-auth' });
