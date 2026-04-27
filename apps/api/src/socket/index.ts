import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import type { Database } from '@csm-chat/db';
import type { Config } from '../config.js';
import type { TokenService } from '../services/token.service.js';
import type { MessageService } from '../services/message.service.js';
import { registerSocketAuth, type ChatNamespace } from './auth.js';
import { registerSocketHandlers } from './handlers.js';
import { SocketBroadcaster, type LazyBroadcaster, type MessageBroadcaster } from './broadcaster.js';

export interface AttachSocketOptions {
  httpServer: HttpServer;
  config: Config;
  db: Database;
  tokenService: TokenService;
  messageService: MessageService;
  /** Existing LazyBroadcaster from server build — its impl gets swapped to SocketBroadcaster. */
  broadcaster: LazyBroadcaster;
}

export interface SocketHandle {
  io: SocketIOServer;
  broadcaster: MessageBroadcaster;
  close(): Promise<void>;
}

export function attachSocketServer(opts: AttachSocketOptions): SocketHandle {
  const io = new SocketIOServer(opts.httpServer, {
    cors: {
      origin: opts.config.CORS_ORIGINS,
      credentials: true,
    },
    pingInterval: opts.config.WS_PING_INTERVAL_MS,
    pingTimeout: opts.config.WS_PING_TIMEOUT_MS,
    // CLAUDE.md: 8 KB max payload per event.
    maxHttpBufferSize: 8 * 1024,
  });

  // Cast to the typed namespace so socket.data flows as SocketData.
  const ns = io.of('/chat') as unknown as ChatNamespace;

  registerSocketAuth(ns, {
    tokenService: opts.tokenService,
    accessSecret: opts.config.JWT_ACCESS_SECRET,
    sessionJwtSecret: opts.config.SESSION_JWT_SECRET,
  });

  const socketBroadcaster = new SocketBroadcaster(ns);
  opts.broadcaster.setImplementation(socketBroadcaster);

  registerSocketHandlers({
    ns,
    db: opts.db,
    messageService: opts.messageService,
    broadcaster: socketBroadcaster,
    enableRateLimit: opts.config.NODE_ENV !== 'test',
  });

  return {
    io,
    broadcaster: socketBroadcaster,
    async close() {
      await new Promise<void>((resolve, reject) => {
        io.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
