import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { sessions, type Database } from '@csm-chat/db';
import { createProblem } from '@csm-chat/shared';
import type { Config } from '../config.js';
import { isExpiredJwt, signSessionJwt, verifySessionUrlToken } from '../lib/jwt.js';
import { sha256Hex } from '../lib/tokens.js';

const WS_TOKEN_TTL_MS = 60_000;

interface WsTokenEntry {
  sessionId: string;
  deviceId: string;
  expiresAt: number;
}

export interface TokenDeps {
  db: Database;
  config: Config;
}

export interface RequestContext {
  requestId: string;
  instance?: string;
}

export interface TokenService {
  /**
   * Implements the §"Client session flow" steps a–d:
   * verify JWT signature → exp → token_hash exists → status is open.
   * Returns the session row on success.
   */
  verifySessionToken(token: string, ctx: RequestContext): Promise<typeof sessions.$inferSelect>;
  issueSessionJwt(sessionId: string, deviceId: string): Promise<string>;
  /** Mints a single-use, 60s WebSocket-handshake token. */
  issueWsToken(sessionId: string, deviceId: string): string;
  /** Single-use consumption — returns null if missing, expired, or already used. */
  consumeWsToken(token: string): { sessionId: string; deviceId: string } | null;
}

export function buildTokenService(deps: TokenDeps): TokenService {
  const { db, config } = deps;
  const wsTokens = new Map<string, WsTokenEntry>();

  function purgeExpiredWsTokens(now: number): void {
    for (const [k, v] of wsTokens.entries()) {
      if (v.expiresAt <= now) wsTokens.delete(k);
    }
  }

  return {
    async verifySessionToken(token, ctx) {
      // a/b. JWT signature + exp.
      let payload;
      try {
        payload = await verifySessionUrlToken(token, config.SESSION_TOKEN_SECRET);
      } catch (err) {
        throw createProblem(isExpiredJwt(err) ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Session URL token is invalid.',
        });
      }

      // c. token_hash exists in DB.
      const tokenHash = sha256Hex(token);
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      if (!row || row.id !== payload.sid) {
        throw createProblem('INVALID_TOKEN', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Session URL token is invalid.',
        });
      }

      // d. status must be one of the open states.
      if (row.status !== 'pending' && row.status !== 'active' && row.status !== 'csm_handling') {
        throw createProblem('SESSION_CLOSED', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Session is closed or expired.',
        });
      }
      return row;
    },

    async issueSessionJwt(sessionId, deviceId) {
      return signSessionJwt(
        { sub: sessionId, did: deviceId },
        config.SESSION_JWT_SECRET,
        config.SESSION_JWT_TTL_SEC,
      );
    },

    issueWsToken(sessionId, deviceId) {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      purgeExpiredWsTokens(now);
      wsTokens.set(token, { sessionId, deviceId, expiresAt: now + WS_TOKEN_TTL_MS });
      return token;
    },

    consumeWsToken(token) {
      const now = Date.now();
      const entry = wsTokens.get(token);
      if (!entry) return null;
      wsTokens.delete(token);
      if (entry.expiresAt <= now) return null;
      return { sessionId: entry.sessionId, deviceId: entry.deviceId };
    },
  };
}
