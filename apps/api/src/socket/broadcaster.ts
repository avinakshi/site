import type { Namespace } from 'socket.io';
import type { Message, SessionStatus } from '@csm-chat/shared';

/**
 * Cross-cutting fan-out used by both REST routes and WS handlers after a
 * successful persist. Decoupled from socket.io so HTTP-only tests can use
 * a no-op implementation and real WS tests can plug in a SocketBroadcaster.
 */
export interface MessageBroadcaster {
  broadcastNewMessage(message: Message): void;
  broadcastSessionStatus(sessionId: string, status: SessionStatus, csmName?: string | null): void;
  broadcastCsmPresence(sessionId: string, online: boolean, lastSeenAt: string | null): void;
}

class NoopBroadcaster implements MessageBroadcaster {
  broadcastNewMessage(): void {
    /* no-op */
  }
  broadcastSessionStatus(): void {
    /* no-op */
  }
  broadcastCsmPresence(): void {
    /* no-op */
  }
}

export class SocketBroadcaster implements MessageBroadcaster {
  constructor(private readonly ns: Namespace) {}

  broadcastNewMessage(message: Message): void {
    this.ns.to(`session:${message.sessionId}`).emit('message:new', message);
  }

  broadcastSessionStatus(sessionId: string, status: SessionStatus, csmName?: string | null): void {
    this.ns.to(`session:${sessionId}`).emit('session:status', { status, csmName });
  }

  broadcastCsmPresence(sessionId: string, online: boolean, lastSeenAt: string | null): void {
    this.ns.to(`session:${sessionId}`).emit('presence:csm', { online, lastSeenAt });
  }
}

/**
 * Indirection: routes use this directly, and the actual implementation is
 * swapped in once the socket server is attached after the HTTP server is
 * listening. Before that, broadcasts are silently dropped.
 */
export class LazyBroadcaster implements MessageBroadcaster {
  private impl: MessageBroadcaster = new NoopBroadcaster();

  setImplementation(impl: MessageBroadcaster): void {
    this.impl = impl;
  }

  broadcastNewMessage(message: Message): void {
    this.impl.broadcastNewMessage(message);
  }

  broadcastSessionStatus(sessionId: string, status: SessionStatus, csmName?: string | null): void {
    this.impl.broadcastSessionStatus(sessionId, status, csmName);
  }

  broadcastCsmPresence(sessionId: string, online: boolean, lastSeenAt: string | null): void {
    this.impl.broadcastCsmPresence(sessionId, online, lastSeenAt);
  }
}
