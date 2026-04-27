import { and, eq, isNull, sql } from 'drizzle-orm';
import { refreshTokens, users, type Database } from '@csm-chat/db';
import { createProblem, ERROR_CODES, type User, type UserRole } from '@csm-chat/shared';
import type { Config } from '../config.js';
import { assertStrongPassword, comparePassword, hashPassword } from '../lib/passwords.js';
import { generateRefreshToken, sha256Hex } from '../lib/tokens.js';
import { signAccessToken } from '../lib/jwt.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface AuthDeps {
  db: Database;
  config: Config;
}

export interface RequestContext {
  requestId: string;
  instance?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AuthService {
  login(input: LoginInput, ctx: RequestContext): Promise<LoginResult>;
  refresh(refreshToken: string, ctx: RequestContext): Promise<RefreshResult>;
  /** Returns the userId that owned the revoked token, if any. Idempotent. */
  logout(refreshToken: string, ctx: RequestContext): Promise<{ userId: string | null }>;
  me(userId: string, ctx: RequestContext): Promise<User>;
  register(input: RegisterInput, ctx: RequestContext): Promise<User>;
}

export function buildAuthService(deps: AuthDeps): AuthService {
  const { db, config } = deps;

  async function lookupActiveUserByEmail(email: string) {
    const lower = email.toLowerCase();
    const rows = await db
      .select()
      .from(users)
      .where(and(sql`LOWER(${users.email}) = ${lower}`, isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function issueTokens(
    user: typeof users.$inferSelect,
    ctx: RequestContext,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = await signAccessToken(
      { sub: user.id, role: user.role },
      config.JWT_ACCESS_SECRET,
      config.JWT_ACCESS_TTL_SEC,
    );
    const refresh = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return { accessToken, refreshToken: refresh.token };
  }

  return {
    async login(input, ctx) {
      const invalidCredentials = () =>
        createProblem('INVALID_CREDENTIALS', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Invalid email or password.',
        });

      const user = await lookupActiveUserByEmail(input.email);
      if (!user || !user.isActive) {
        // Burn time even on miss to limit user-enumeration via timing.
        await comparePassword(input.password, '$2b$12$' + 'x'.repeat(53));
        throw invalidCredentials();
      }

      // Account locked?
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw invalidCredentials();
      }

      const ok = await comparePassword(input.password, user.passwordHash);
      if (!ok) {
        const nextAttempts = user.failedLoginAttempts + 1;
        const reachedThreshold = nextAttempts >= MAX_FAILED_ATTEMPTS;
        await db
          .update(users)
          .set({
            failedLoginAttempts: nextAttempts,
            lockedUntil: reachedThreshold ? new Date(Date.now() + LOCK_DURATION_MS) : null,
          })
          .where(eq(users.id, user.id));
        throw invalidCredentials();
      }

      // Reset counters and stamp lastSeenAt.
      await db
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null, lastSeenAt: new Date() })
        .where(eq(users.id, user.id));

      const tokens = await issueTokens(user, ctx);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: config.JWT_ACCESS_TTL_SEC,
        user: rowToUser({
          ...user,
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastSeenAt: new Date(),
        }),
      };
    },

    async refresh(refreshToken, ctx) {
      const invalidToken = () =>
        createProblem('INVALID_TOKEN', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Refresh token is invalid or has been revoked.',
        });

      if (!refreshToken) throw invalidToken();
      const tokenHash = sha256Hex(refreshToken);

      const tokenRows = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      const tokenRow = tokenRows[0];
      if (!tokenRow) throw invalidToken();
      if (tokenRow.revokedAt) throw invalidToken();
      if (tokenRow.expiresAt.getTime() <= Date.now()) {
        throw createProblem('TOKEN_EXPIRED', {
          requestId: ctx.requestId,
          instance: ctx.instance,
        });
      }

      const userRows = await db
        .select()
        .from(users)
        .where(and(eq(users.id, tokenRow.userId), isNull(users.deletedAt)))
        .limit(1);
      const user = userRows[0];
      if (!user || !user.isActive) throw invalidToken();

      // Rotate: issue a new pair, then revoke the old row pointing to the new id.
      const newAccess = await signAccessToken(
        { sub: user.id, role: user.role },
        config.JWT_ACCESS_SECRET,
        config.JWT_ACCESS_TTL_SEC,
      );
      const newRefresh = generateRefreshToken();
      const newExpiresAt = new Date(Date.now() + config.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
      const inserted = await db
        .insert(refreshTokens)
        .values({
          userId: user.id,
          tokenHash: newRefresh.hash,
          expiresAt: newExpiresAt,
          userAgent: ctx.userAgent ?? null,
          ipAddress: ctx.ipAddress ?? null,
        })
        .returning({ id: refreshTokens.id });
      const newTokenId = inserted[0]?.id;
      if (!newTokenId) throw new Error('failed to insert rotated refresh token');

      await db
        .update(refreshTokens)
        .set({
          revokedAt: new Date(),
          revokedReason: 'rotated',
          rotatedToTokenId: newTokenId,
        })
        .where(eq(refreshTokens.id, tokenRow.id));

      return {
        accessToken: newAccess,
        refreshToken: newRefresh.token,
        expiresIn: config.JWT_ACCESS_TTL_SEC,
      };
    },

    async logout(refreshToken, _ctx) {
      // Idempotent: missing/invalid tokens silently succeed (logout never errors).
      if (!refreshToken) return { userId: null };
      const tokenHash = sha256Hex(refreshToken);
      const matching = await db
        .select({ userId: refreshTokens.userId })
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
        .limit(1);
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: 'user_logout' })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
      return { userId: matching[0]?.userId ?? null };
    },

    async me(userId, ctx) {
      const rows = await db
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);
      const user = rows[0];
      if (!user || !user.isActive) {
        throw createProblem('UNAUTHENTICATED', {
          requestId: ctx.requestId,
          instance: ctx.instance,
        });
      }
      return rowToUser(user);
    },

    async register(input, ctx) {
      assertStrongPassword(input.password, ctx.requestId, ctx.instance);

      const existing = await lookupActiveUserByEmail(input.email);
      if (existing) {
        throw createProblem(ERROR_CODES.CONFLICT, {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'A user with that email already exists.',
        });
      }

      const passwordHash = await hashPassword(input.password);
      const inserted = await db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          passwordHash,
          name: input.name,
          role: input.role,
        })
        .returning();

      const created = inserted[0];
      if (!created) throw new Error('failed to insert user');
      return rowToUser(created);
    },
  };
}
