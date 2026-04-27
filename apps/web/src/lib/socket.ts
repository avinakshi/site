import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

export type ChatSocket = Socket;

export function connectAsCsm(accessToken: string): ChatSocket {
  return io(`${API_URL}/chat`, {
    auth: { type: 'csm', accessToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 250,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.3,
  });
}

export function connectAsClient(wsToken: string, lastSeenMessageId?: string): ChatSocket {
  return io(`${API_URL}/chat`, {
    auth: { type: 'client', wsToken, lastSeenMessageId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 250,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.3,
  });
}
