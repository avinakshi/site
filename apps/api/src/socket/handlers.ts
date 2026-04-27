import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { messages, sessions, users, type Database } from '@csm-chat/db';
import { ProblemError, sendMessageRequestSchema, type Message } from '@csm-chat/shared';
import type { MessageService } from '../services/message.service.js';
import { rowToMessage } from '../services/message.service.js';
import type { SocketBroadcaster } from './broadcaster.js';
import type { ChatNamespace, ChatSocket } from './auth.js';

const REPLAY_CAP = 200;

/** Number of events a single socket can fire per second. */
const EVENT_RATE_LIMIT = 10;

interface HandlerDeps {
  ns: ChatNamespace;
  db: Database;
  messageService: MessageService;
  /** Real broadcaster for cross-socket fan-out. */
  broadcaster: SocketBroadcaster;
  /** When false, skip per-socket rate-limiting (test harness). */
  enableRateLimit: boolean;
}

interface RateState {
  windowStart: number;
  count: number;
}

function checkRate(state: RateState, now: number): boolean {
  if (now - state.windowStart >= 1000) {
    state.windowStart = now;
    state.count = 1;
    return true;
  }
  state.count += 1;
  return state.count <= EVENT_RATE_LIMIT;
}

export function registerSocketHandlers(deps: HandlerDeps): void {
  const { ns, db, messageService, broadcaster, enableRateLimit } = deps;

  ns.on('connection', (socket: ChatSocket) => {
    void handleConnection(socket, deps);

    const rateState: RateState = { windowStart: Date.now(), count: 0 };

    socket.on('message:send', async (payload: unknown, ack?: (resp: unknown) => void) => {
      if (enableRateLimit && !checkRate(rateState, Date.now())) {
        ack?.({ ok: false, error: 'RATE_LIMITED' });
        return;
      }
      try {
        const result = await handleMessageSend(socket, db, messageService, payload);
        ack?.({ ok: true, message: result });
      } catch (err) {
        const code =
          err instanceof ProblemError
            ? err.code
            : err instanceof Error && err.message
              ? err.message
              : 'INTERNAL_ERROR';
        ack?.({ ok: false, error: code });
      }
    });

    socket.on('presence:ping', async (_payload: unknown, ack?: (resp: unknown) => void) => {
      if (enableRateLimit && !checkRate(rateState, Date.now())) {
        ack?.({ ok: false, error: 'RATE_LIMITED' });
        return;
      }
      try {
        if (socket.data.identityType === 'csm') {
          await markCsmSeen(db, socket.data.userId);
        }
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('session:join', async (payload: unknown, ack?: (resp: unknown) => void) => {
      if (socket.data.identityType !== 'csm') {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      const sessionId = (payload as { sessionId?: unknown })?.sessionId;
      if (typeof sessionId !== 'string') {
        ack?.({ ok: false, error: 'VALIDATION_ERROR' });
        return;
      }
      const rows = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!rows[0]) {
        ack?.({ ok: false, error: 'NOT_FOUND' });
        return;
      }
      socket.join(`session:${sessionId}`);
      // Announce CSM-online to anyone listening on this session room
      // (clients viewing /c/<token> get presence:csm { online: true }).
      broadcaster.broadcastCsmPresence(sessionId, true, new Date().toISOString());
      ack?.({ ok: true });
    });

    // Typing indicator. Either side can fire typing:start; the server
    // re-emits as typing:other to everyone else in the same session room.
    // Clients keep a 4-second sliding-window timeout — no typing:stop
    // event is needed.
    socket.on('typing:start', (payload: unknown, ack?: (resp: unknown) => void) => {
      let sid: string | null = null;
      let from: 'client' | 'csm';
      if (socket.data.identityType === 'client') {
        sid = socket.data.sessionId;
        from = 'client';
      } else {
        from = 'csm';
        const incoming = (payload as { sessionId?: unknown })?.sessionId;
        if (typeof incoming === 'string') sid = incoming;
      }
      if (!sid) {
        ack?.({ ok: false, error: 'VALIDATION_ERROR' });
        return;
      }
      ns.to(`session:${sid}`).except(socket.id).emit('typing:other', { from, sessionId: sid });
      ack?.({ ok: true });
    });

    // Heartbeat for CSM connections — keeps users.last_seen_at fresh
    // every 30s while a socket is open.
    let heartbeat: NodeJS.Timeout | undefined;
    if (socket.data.identityType === 'csm') {
      const userId = socket.data.userId;
      heartbeat = setInterval(() => {
        void markCsmSeen(db, userId);
      }, 30_000);
    }

    socket.on('disconnecting', () => {
      // While disconnecting, socket.rooms still contains the joined rooms.
      if (socket.data.identityType === 'csm') {
        const lastSeenAt = new Date().toISOString();
        for (const room of socket.rooms) {
          if (room.startsWith('session:')) {
            const sessionId = room.slice('session:'.length);
            broadcaster.broadcastCsmPresence(sessionId, false, lastSeenAt);
          }
        }
      }
    });

    socket.on('disconnect', () => {
      if (heartbeat) clearInterval(heartbeat);
    });
  });
}

async function handleConnection(socket: ChatSocket, deps: HandlerDeps): Promise<void> {
  const { db, broadcaster } = deps;

  if (socket.data.identityType === 'client') {
    socket.join(`session:${socket.data.sessionId}`);
    if (socket.data.lastSeenMessageId) {
      await replayMissedMessages(socket, db, socket.data.sessionId, socket.data.lastSeenMessageId);
    }
    return;
  }

  // CSM: join personal room + session rooms for assigned active sessions.
  socket.join(`csm:${socket.data.userId}`);
  const assigned = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.assignedCsmId, socket.data.userId),
        inArray(sessions.status, ['pending', 'active', 'csm_handling']),
      ),
    );
  for (const row of assigned) {
    socket.join(`session:${row.id}`);
    // Announce CSM came online to each session room.
    broadcaster.broadcastCsmPresence(row.id, true, new Date().toISOString());
  }

  await markCsmSeen(db, socket.data.userId);
}

async function replayMissedMessages(
  socket: ChatSocket,
  db: Database,
  sessionId: string,
  lastSeenMessageId: string,
): Promise<void> {
  // Look up the cutoff time of the last-seen message.
  const cutoffRows = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, lastSeenMessageId))
    .limit(1);
  const cutoff = cutoffRows[0]?.createdAt;
  if (!cutoff) return; // unknown id — skip replay

  const missed = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, cutoff)))
    .orderBy(asc(messages.createdAt))
    .limit(REPLAY_CAP);

  for (const row of missed) {
    socket.emit('message:new', rowToMessage(row));
  }
}

async function handleMessageSend(
  socket: ChatSocket,
  _db: Database,
  messageService: MessageService,
  payload: unknown,
): Promise<Message> {
  const parsed = sendMessageRequestSchema.safeParse(payload);
  if (!parsed.success) throw new Error('VALIDATION_ERROR');

  const ctx = { requestId: socket.id, instance: 'ws:message:send' };

  if (socket.data.identityType === 'client') {
    return messageService.send(
      {
        sessionId: socket.data.sessionId,
        senderType: 'client',
        senderId: null,
        content: parsed.data.content,
        clientMessageId: parsed.data.clientMessageId,
      },
      ctx,
    );
  }

  // CSM path: sessionId comes from the payload (CSMs aren't bound to one).
  const sessionId = (payload as { sessionId?: unknown })?.sessionId;
  if (typeof sessionId !== 'string') throw new Error('VALIDATION_ERROR');

  return messageService.send(
    {
      sessionId,
      senderType: 'csm',
      senderId: socket.data.userId,
      content: parsed.data.content,
      clientMessageId: parsed.data.clientMessageId,
    },
    ctx,
  );
}

async function markCsmSeen(db: Database, userId: string): Promise<void> {
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
}
