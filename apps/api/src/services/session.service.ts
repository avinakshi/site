import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { clients, messages, sessions, users, type Database } from '@csm-chat/db';
import {
  createProblem,
  type CreateSessionResponse,
  type ListSessionsQuery,
  type ListSessionsResponse,
  type Session,
  type SessionDetail,
  type SessionStatus,
} from '@csm-chat/shared';
import type { Config } from '../config.js';
import { signSessionUrlToken } from '../lib/jwt.js';
import { sha256Hex } from '../lib/tokens.js';
import { rowToClient } from './client.service.js';

export interface SessionDeps {
  db: Database;
  config: Config;
}

export interface RequestContext {
  requestId: string;
  instance?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function rowToSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    clientId: row.clientId,
    assignedCsmId: row.assignedCsmId,
    createdByUserId: row.createdByUserId,
    status: row.status,
    firstAccessedAt: row.firstAccessedAt ? row.firstAccessedAt.toISOString() : null,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedByUserId: row.closedByUserId,
    closedReason: row.closedReason,
    metadata: row.metadata as Session['metadata'],
    emailThreadId: row.emailThreadId,
    aiInterventionCount: row.aiInterventionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToUserView(row: typeof users.$inferSelect) {
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

export interface CreateInput {
  clientId: string;
  assignedCsmId?: string | null;
  createdByUserId: string;
  expiresInDays: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateInput {
  assignedCsmId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionService {
  create(input: CreateInput, ctx: RequestContext): Promise<CreateSessionResponse>;
  list(query: ListSessionsQuery, ctx: RequestContext): Promise<ListSessionsResponse>;
  getById(id: string, ctx: RequestContext): Promise<SessionDetail>;
  update(id: string, input: UpdateInput, ctx: RequestContext): Promise<Session>;
  close(
    id: string,
    reason: string | undefined,
    closedByUserId: string,
    ctx: RequestContext,
  ): Promise<Session>;
}

export function buildSessionService(deps: SessionDeps): SessionService {
  const { db, config } = deps;

  async function loadOrThrow(id: string, ctx: RequestContext) {
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      throw createProblem('NOT_FOUND', {
        requestId: ctx.requestId,
        instance: ctx.instance,
        detail: 'Session not found.',
      });
    }
    return row;
  }

  return {
    async create(input, _ctx) {
      const days = input.expiresInDays;
      const sessionId = randomUUID();
      const ttlSec = days * 86400;
      const expiresAt = new Date(Date.now() + days * DAY_MS);

      const token = await signSessionUrlToken(
        { sid: sessionId, ver: 1 },
        config.SESSION_TOKEN_SECRET,
        ttlSec,
      );
      const tokenHash = sha256Hex(token);

      const inserted = await db
        .insert(sessions)
        .values({
          id: sessionId,
          clientId: input.clientId,
          assignedCsmId: input.assignedCsmId ?? null,
          createdByUserId: input.createdByUserId,
          tokenHash,
          status: 'pending',
          expiresAt,
          metadata: input.metadata ?? {},
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('failed to insert session');

      return {
        session: rowToSession(row),
        chatUrl: `${config.APP_BASE_URL.replace(/\/+$/, '')}/c/${token}`,
        expiresAt: expiresAt.toISOString(),
      };
    },

    async list(query, _ctx) {
      const { status, assignedCsmId, clientId, from, to, page, limit } = query;
      const offset = (page - 1) * limit;

      const conds = [];
      if (status && status.length > 0) {
        conds.push(inArray(sessions.status, status as SessionStatus[]));
      }
      if (assignedCsmId) conds.push(eq(sessions.assignedCsmId, assignedCsmId));
      if (clientId) conds.push(eq(sessions.clientId, clientId));
      if (from) conds.push(gte(sessions.createdAt, from));
      if (to) conds.push(lte(sessions.createdAt, to));
      const where = conds.length > 0 ? and(...conds) : undefined;

      const [items, totalRow] = await Promise.all([
        db
          .select()
          .from(sessions)
          .where(where)
          .orderBy(desc(sessions.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ n: count() }).from(sessions).where(where),
      ]);

      const total = Number(totalRow[0]?.n ?? 0);
      return {
        items: items.map(rowToSession),
        page,
        limit,
        total,
        hasMore: offset + items.length < total,
      };
    },

    async getById(id, ctx) {
      const session = await loadOrThrow(id, ctx);

      const clientRows = await db
        .select()
        .from(clients)
        .where(eq(clients.id, session.clientId))
        .limit(1);
      const clientRow = clientRows[0];
      if (!clientRow) throw new Error('session has no client row — schema invariant violated');

      let assignedCsm: ReturnType<typeof rowToUserView> | null = null;
      if (session.assignedCsmId) {
        const csmRows = await db
          .select()
          .from(users)
          .where(eq(users.id, session.assignedCsmId))
          .limit(1);
        if (csmRows[0]) assignedCsm = rowToUserView(csmRows[0]);
      }

      const countRow = await db
        .select({ n: count() })
        .from(messages)
        .where(eq(messages.sessionId, session.id));

      return {
        ...rowToSession(session),
        client: rowToClient(clientRow),
        assignedCsm,
        messageCount: Number(countRow[0]?.n ?? 0),
      };
    },

    async update(id, input, ctx) {
      await loadOrThrow(id, ctx);

      const patch: Partial<typeof sessions.$inferInsert> = {};
      if (input.assignedCsmId !== undefined) patch.assignedCsmId = input.assignedCsmId;
      if (input.metadata !== undefined) patch.metadata = input.metadata;

      if (Object.keys(patch).length === 0) {
        const fresh = await loadOrThrow(id, ctx);
        return rowToSession(fresh);
      }

      const updated = await db.update(sessions).set(patch).where(eq(sessions.id, id)).returning();
      const row = updated[0];
      if (!row) throw new Error('update returned no rows');
      return rowToSession(row);
    },

    async close(id, reason, closedByUserId, ctx) {
      const existing = await loadOrThrow(id, ctx);
      if (existing.status === 'closed' || existing.status === 'expired') {
        throw createProblem('SESSION_CLOSED', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Session is already closed.',
        });
      }
      const updated = await db
        .update(sessions)
        .set({
          status: 'closed',
          closedAt: new Date(),
          closedByUserId,
          closedReason: reason ?? null,
        })
        .where(eq(sessions.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error('close returned no rows');
      return rowToSession(row);
    },
  };
}

export { rowToSession };
