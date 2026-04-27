import { asc, count, ilike, or, sql } from 'drizzle-orm';
import { clients, type Database } from '@csm-chat/db';
import {
  createProblem,
  type Client,
  type ListClientsQuery,
  type ListClientsResponse,
} from '@csm-chat/shared';

export interface ClientDeps {
  db: Database;
}

export interface RequestContext {
  requestId: string;
  instance?: string;
}

function rowToClient(row: typeof clients.$inferSelect): Client {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    company: row.company,
    metadata: row.metadata as Client['metadata'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface FindOrCreateInput {
  email: string;
  name: string;
  company?: string;
  metadata?: Record<string, unknown>;
}

export interface ClientService {
  findOrCreateByEmail(input: FindOrCreateInput): Promise<Client>;
  list(query: ListClientsQuery): Promise<ListClientsResponse>;
  getById(id: string, ctx: RequestContext): Promise<Client>;
}

export function buildClientService(deps: ClientDeps): ClientService {
  const { db } = deps;

  return {
    async findOrCreateByEmail(input) {
      const lower = input.email.toLowerCase();
      const existing = await db
        .select()
        .from(clients)
        .where(sql`LOWER(${clients.email}) = ${lower}`)
        .limit(1);
      if (existing[0]) return rowToClient(existing[0]);

      const inserted = await db
        .insert(clients)
        .values({
          email: lower,
          name: input.name,
          company: input.company ?? null,
          metadata: input.metadata ?? {},
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('failed to insert client');
      return rowToClient(row);
    },

    async list(query) {
      const { search, page, limit } = query;
      const offset = (page - 1) * limit;

      const where = search
        ? or(ilike(clients.email, `%${search}%`), ilike(clients.name, `%${search}%`))
        : undefined;

      const [items, totalRow] = await Promise.all([
        db
          .select()
          .from(clients)
          .where(where)
          .orderBy(asc(clients.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ n: count() }).from(clients).where(where),
      ]);

      const total = Number(totalRow[0]?.n ?? 0);
      return {
        items: items.map(rowToClient),
        page,
        limit,
        total,
        hasMore: offset + items.length < total,
      };
    },

    async getById(id, ctx) {
      const rows = await db
        .select()
        .from(clients)
        .where(sql`${clients.id} = ${id}`)
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw createProblem('NOT_FOUND', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Client not found.',
        });
      }
      return rowToClient(row);
    },
  };
}

export { rowToClient };
