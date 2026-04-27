import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { users, type Database } from '@csm-chat/db';
import {
  createProblem,
  type CreateUserRequest,
  type ListUsersQuery,
  type ListUsersResponse,
  type UpdateUserRequest,
  type User,
} from '@csm-chat/shared';
import type { Config } from '../config.js';
import { assertStrongPassword, hashPassword } from '../lib/passwords.js';

export interface UserDeps {
  db: Database;
  config: Config;
}

export interface RequestContext {
  requestId: string;
  instance?: string;
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

export interface UserService {
  list(query: ListUsersQuery, ctx: RequestContext): Promise<ListUsersResponse>;
  create(input: CreateUserRequest, ctx: RequestContext): Promise<User>;
  getById(id: string, ctx: RequestContext): Promise<User>;
  update(id: string, input: UpdateUserRequest, ctx: RequestContext): Promise<User>;
  /** Soft delete — sets deleted_at, preserves the row. */
  softDelete(id: string, ctx: RequestContext): Promise<void>;
}

export function buildUserService(deps: UserDeps): UserService {
  const { db } = deps;

  async function loadActive(id: string, ctx: RequestContext): Promise<typeof users.$inferSelect> {
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw createProblem('NOT_FOUND', {
        requestId: ctx.requestId,
        instance: ctx.instance,
        detail: 'User not found.',
      });
    }
    return row;
  }

  return {
    async list(query, _ctx) {
      const { page, limit, role } = query;
      const offset = (page - 1) * limit;

      const baseFilter = role
        ? and(isNull(users.deletedAt), eq(users.role, role))
        : isNull(users.deletedAt);

      const [items, totalRow] = await Promise.all([
        db
          .select()
          .from(users)
          .where(baseFilter)
          .orderBy(asc(users.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ n: count() }).from(users).where(baseFilter),
      ]);

      const total = Number(totalRow[0]?.n ?? 0);
      return {
        items: items.map(rowToUser),
        page,
        limit,
        total,
        hasMore: offset + items.length < total,
      };
    },

    async create(input, ctx) {
      assertStrongPassword(input.password, ctx.requestId, ctx.instance);

      const lower = input.email.toLowerCase();
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(sql`LOWER(${users.email}) = ${lower}`, isNull(users.deletedAt)))
        .limit(1);
      if (existing.length > 0) {
        throw createProblem('CONFLICT', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'A user with that email already exists.',
        });
      }

      const passwordHash = await hashPassword(input.password);
      const inserted = await db
        .insert(users)
        .values({ email: lower, passwordHash, name: input.name, role: input.role })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('failed to insert user');
      return rowToUser(row);
    },

    async getById(id, ctx) {
      return rowToUser(await loadActive(id, ctx));
    },

    async update(id, input, ctx) {
      const existing = await loadActive(id, ctx);

      if (input.password !== undefined) {
        assertStrongPassword(input.password, ctx.requestId, ctx.instance);
      }

      const patch: Partial<typeof users.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.role !== undefined) patch.role = input.role;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.password !== undefined) patch.passwordHash = await hashPassword(input.password);

      // Defensive: if a user is being deactivated, also clear any lock.
      if (input.isActive === false) {
        patch.failedLoginAttempts = 0;
        patch.lockedUntil = null;
      }

      if (Object.keys(patch).length === 0) {
        // Nothing to do — return the loaded row.
        return rowToUser(existing);
      }

      const updated = await db.update(users).set(patch).where(eq(users.id, id)).returning();
      const row = updated[0];
      if (!row) throw new Error('update returned no rows');
      return rowToUser(row);
    },

    async softDelete(id, ctx) {
      const existing = await loadActive(id, ctx);
      await db
        .update(users)
        .set({ deletedAt: new Date(), isActive: false })
        .where(eq(users.id, existing.id));
    },
  };
}
