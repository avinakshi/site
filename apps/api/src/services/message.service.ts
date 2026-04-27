import { and, desc, eq, lt } from 'drizzle-orm';
import { messages, sessions, type Database } from '@csm-chat/db';
import {
  createProblem,
  type ListMessagesQuery,
  type ListMessagesResponse,
  type Message,
  type MessageSenderType,
} from '@csm-chat/shared';

export interface MessageDeps {
  db: Database;
}

export interface RequestContext {
  requestId: string;
  instance?: string;
}

/** Postgres SQLSTATE for unique_violation. Both pg and PGlite expose `code`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

function rowToMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    senderType: row.senderType,
    senderId: row.senderId,
    content: row.content,
    clientMessageId: row.clientMessageId,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    metadata: row.metadata as Message['metadata'],
    createdAt: row.createdAt.toISOString(),
  };
}

export interface SendInput {
  sessionId: string;
  senderType: MessageSenderType;
  /** users.id for `csm`, null otherwise. */
  senderId: string | null;
  content: string;
  /** Required: client-generated UUID for end-to-end idempotency. */
  clientMessageId: string;
}

export interface ListInput {
  sessionId: string;
  before?: Date;
  limit: number;
}

export interface MessageService {
  /**
   * Insert a message. Idempotent on (session_id, client_message_id) —
   * a duplicate insert returns the existing row instead of erroring.
   * Rejects sends to closed/expired sessions with 410 SESSION_CLOSED.
   */
  send(input: SendInput, ctx: RequestContext): Promise<Message>;
  list(input: ListInput): Promise<ListMessagesResponse>;
}

export function buildMessageService(deps: MessageDeps): MessageService {
  const { db } = deps;

  return {
    async send(input, ctx) {
      // Verify the session exists and accepts new messages.
      const sessionRows = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        throw createProblem('NOT_FOUND', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Session not found.',
        });
      }
      if (
        session.status !== 'active' &&
        session.status !== 'pending' &&
        session.status !== 'csm_handling'
      ) {
        throw createProblem('SESSION_CLOSED', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: 'Cannot send to a closed or expired session.',
        });
      }

      // Idempotent insert: catch the unique-violation on
      // (session_id, client_message_id) and return the existing row.
      // We use try/catch rather than ON CONFLICT because the underlying
      // index is partial (WHERE client_message_id IS NOT NULL), and
      // Postgres inference of partial-index arbiters via Drizzle's API
      // surface is brittle across drivers.
      let row: typeof messages.$inferSelect | undefined;
      try {
        const inserted = await db
          .insert(messages)
          .values({
            sessionId: input.sessionId,
            senderType: input.senderType,
            senderId: input.senderId,
            content: input.content,
            clientMessageId: input.clientMessageId,
          })
          .returning();
        row = inserted[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.sessionId, input.sessionId),
                eq(messages.clientMessageId, input.clientMessageId),
              ),
            )
            .limit(1);
          const existingRow = existing[0];
          if (!existingRow) throw new Error('unique violation but no matching row found');
          return rowToMessage(existingRow);
        }
        throw err;
      }

      if (!row) throw new Error('insert returned no rows');

      // Bump session.last_message_at on real new inserts.
      await db
        .update(sessions)
        .set({ lastMessageAt: row.createdAt })
        .where(eq(sessions.id, input.sessionId));

      return rowToMessage(row);
    },

    async list(input) {
      const { sessionId, before, limit } = input;
      const conds = [eq(messages.sessionId, sessionId)];
      if (before) conds.push(lt(messages.createdAt, before));
      const where = and(...conds);

      // Fetch limit+1 desc so we can detect "more older messages exist".
      const rows = await db
        .select()
        .from(messages)
        .where(where)
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const trimmed = hasMore ? rows.slice(0, limit) : rows;
      // Reverse to ASC (oldest first) for chronological display.
      const ascending = [...trimmed].reverse();
      const oldestCreatedAt = ascending[0]?.createdAt.toISOString() ?? null;

      return {
        items: ascending.map(rowToMessage),
        hasMore,
        oldestCreatedAt,
      };
    },
  };
}

export { rowToMessage };

export function listMessagesInputFromQuery(sessionId: string, query: ListMessagesQuery): ListInput {
  return {
    sessionId,
    before: query.before,
    limit: query.limit,
  };
}
