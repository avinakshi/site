import type { DefaultEventsMap, Namespace, Socket as RawSocket } from 'socket.io';
import { isExpiredJwt, verifyAccessToken, verifySessionJwt } from '../lib/jwt.js';
import type { TokenService } from '../services/token.service.js';
import type { UserRole } from '@csm-chat/shared';

export type ClientIdentity = {
  identityType: 'client';
  sessionId: string;
  deviceId: string;
};

export type CsmIdentity = {
  identityType: 'csm';
  userId: string;
  role: UserRole;
};

export type SocketIdentity = ClientIdentity | CsmIdentity;

export type SocketData = SocketIdentity & {
  lastSeenMessageId?: string;
};

/** Typed socket alias used across the WS layer. */
export type ChatSocket = RawSocket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

export type ChatNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

interface HandshakeAuth {
  type?: 'client' | 'csm';
  wsToken?: string;
  accessToken?: string;
  lastSeenMessageId?: string;
}

interface AuthDeps {
  tokenService: TokenService;
  accessSecret: string;
  sessionJwtSecret: string;
}

/**
 * Registers the namespace-level handshake middleware that validates
 * either a client wsToken (single-use, 60s) OR a CSM access JWT.
 */
export function registerSocketAuth(ns: ChatNamespace, deps: AuthDeps): void {
  const { tokenService, accessSecret } = deps;

  ns.use(async (socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as HandshakeAuth;
      const lastSeenMessageId =
        typeof auth.lastSeenMessageId === 'string' ? auth.lastSeenMessageId : undefined;

      if (auth.type === 'client') {
        if (!auth.wsToken) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        const consumed = tokenService.consumeWsToken(auth.wsToken);
        if (!consumed) {
          next(new Error('INVALID_TOKEN'));
          return;
        }
        socket.data = {
          identityType: 'client',
          sessionId: consumed.sessionId,
          deviceId: consumed.deviceId,
          lastSeenMessageId,
        };
        next();
        return;
      }

      if (auth.type === 'csm') {
        if (!auth.accessToken) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        try {
          const payload = await verifyAccessToken(auth.accessToken, accessSecret);
          socket.data = {
            identityType: 'csm',
            userId: payload.sub,
            role: payload.role,
            lastSeenMessageId,
          };
          next();
          return;
        } catch (err) {
          next(new Error(isExpiredJwt(err) ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'));
          return;
        }
      }

      next(new Error('UNAUTHENTICATED'));
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  // Helper exposed via module so callers can verify session JWTs from
  // ad-hoc places (currently unused; reserved for future intra-WS auth).
  void verifySessionJwt;
  void deps.sessionJwtSecret;
}
