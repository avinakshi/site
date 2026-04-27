import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { users } from '@csm-chat/db';
import { buildSocketHarness, type SocketHarness } from './socket-helpers.js';

const SEED_PASSWORD = 'TestUser_Pass!1234';

interface Setup {
  csmId: string;
  csmAccessToken: string;
  sessionId: string;
  /** The raw URL JWT — kept so reconnect tests can re-call /v1/chat/verify. */
  urlToken: string;
  /** The deviceId stored in the csm_chat_device cookie. */
  deviceCookie: string;
  /** First wsToken (single-use). */
  wsToken: string;
  sessionJwt: string;
}

function readSetCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of lines) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(line);
    if (m && m[1] !== undefined) return decodeURIComponent(m[1]);
  }
  return null;
}

async function setupConversation(harness: SocketHarness): Promise<Setup> {
  if (harness.dbClient.driver !== 'pglite') throw new Error('expects pglite');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const inserted = await harness.dbClient.db
    .insert(users)
    .values([{ email: 'csm@example.com', name: 'CSM', role: 'csm', passwordHash }])
    .returning({ id: users.id });
  const csmId = inserted[0]!.id;

  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'csm@example.com', password: SEED_PASSWORD },
  });
  const csmAccessToken = login.json().accessToken as string;

  const create = await harness.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${csmAccessToken}` },
    payload: {
      clientEmail: 'client@example.com',
      clientName: 'Client',
      assignedCsmId: csmId,
    },
  });
  const sessionId = create.json().session.id as string;
  const urlToken = (create.json().chatUrl as string).split('/c/')[1]!;

  const verify = await harness.app.inject({
    method: 'POST',
    url: '/v1/chat/verify',
    payload: { token: urlToken },
  });
  const deviceCookie = readSetCookie(verify.headers['set-cookie'], 'csm_chat_device');
  if (!deviceCookie) throw new Error('verify did not set device cookie');

  return {
    csmId,
    csmAccessToken,
    sessionId,
    urlToken,
    deviceCookie,
    wsToken: verify.json().wsToken,
    sessionJwt: verify.json().sessionJwt,
  };
}

async function reissueWsToken(harness: SocketHarness, setup: Setup): Promise<string> {
  const verify = await harness.app.inject({
    method: 'POST',
    url: '/v1/chat/verify',
    cookies: { csm_chat_device: setup.deviceCookie },
    payload: { token: setup.urlToken },
  });
  if (verify.statusCode !== 200) {
    throw new Error(`reissue verify failed: ${verify.statusCode} ${verify.payload}`);
  }
  return verify.json().wsToken as string;
}

function connectClient(
  harness: SocketHarness,
  wsToken: string,
  lastSeenMessageId?: string,
): ClientSocket {
  return ioClient(`${harness.baseUrl}/chat`, {
    auth: { type: 'client', wsToken, lastSeenMessageId },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function connectCsm(harness: SocketHarness, accessToken: string): ClientSocket {
  return ioClient(`${harness.baseUrl}/chat`, {
    auth: { type: 'csm', accessToken },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

function waitForEvent<T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function emitWithAck<T = unknown>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ack on ${event}`)),
      timeoutMs,
    );
    socket.emit(event, payload, (resp: T) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
}

describe('socket.io — bi-directional messaging', () => {
  let harness: SocketHarness | undefined;

  beforeEach(async () => {
    harness = await buildSocketHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('client message:send → CSM receives message:new in real time', async () => {
    const setup = await setupConversation(harness!);
    const clientSock = connectClient(harness!, setup.wsToken);
    const csmSock = connectCsm(harness!, setup.csmAccessToken);
    await Promise.all([waitForConnect(clientSock), waitForConnect(csmSock)]);

    const incoming = waitForEvent<{ id: string; content: string; senderType: string }>(
      csmSock,
      'message:new',
    );
    const cid = randomUUID();
    const ack = await emitWithAck<{ ok: boolean; message: { id: string } }>(
      clientSock,
      'message:send',
      { content: 'hello from client', clientMessageId: cid },
    );
    expect(ack.ok).toBe(true);

    const received = await incoming;
    expect(received.id).toBe(ack.message.id);
    expect(received.content).toBe('hello from client');
    expect(received.senderType).toBe('client');

    clientSock.close();
    csmSock.close();
  });

  it('CSM message:send → client receives message:new', async () => {
    const setup = await setupConversation(harness!);
    const clientSock = connectClient(harness!, setup.wsToken);
    const csmSock = connectCsm(harness!, setup.csmAccessToken);
    await Promise.all([waitForConnect(clientSock), waitForConnect(csmSock)]);

    const incoming = waitForEvent<{ content: string; senderType: string }>(
      clientSock,
      'message:new',
    );
    const ack = await emitWithAck<{ ok: boolean }>(csmSock, 'message:send', {
      sessionId: setup.sessionId,
      content: 'hello from CSM',
      clientMessageId: randomUUID(),
    });
    expect(ack.ok).toBe(true);

    const received = await incoming;
    expect(received.content).toBe('hello from CSM');
    expect(received.senderType).toBe('csm');

    clientSock.close();
    csmSock.close();
  });

  it('idempotent message:send returns the same persisted id', async () => {
    const setup = await setupConversation(harness!);
    const clientSock = connectClient(harness!, setup.wsToken);
    await waitForConnect(clientSock);

    const cid = randomUUID();
    const a = await emitWithAck<{ ok: boolean; message: { id: string; content: string } }>(
      clientSock,
      'message:send',
      { content: 'first', clientMessageId: cid },
    );
    const b = await emitWithAck<{ ok: boolean; message: { id: string; content: string } }>(
      clientSock,
      'message:send',
      { content: 'ignored', clientMessageId: cid },
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect(b.message.content).toBe('first');

    clientSock.close();
  });

  it('rejects connections without auth', async () => {
    const sock = ioClient(`${harness!.baseUrl}/chat`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const err = await new Promise<Error>((resolve) => {
      sock.once('connect_error', resolve);
    });
    expect(err.message).toBe('UNAUTHENTICATED');
    sock.close();
  });

  it('client wsToken is single-use — second connect attempt fails', async () => {
    const setup = await setupConversation(harness!);
    const first = connectClient(harness!, setup.wsToken);
    await waitForConnect(first);
    first.close();

    const second = connectClient(harness!, setup.wsToken);
    const err = await new Promise<Error>((resolve) => {
      second.once('connect_error', resolve);
    });
    expect(err.message).toBe('INVALID_TOKEN');
    second.close();
  });
});

describe('socket.io — reconnection replay', () => {
  let harness: SocketHarness | undefined;

  beforeEach(async () => {
    harness = await buildSocketHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('reconnect with lastSeenMessageId replays messages missed while offline', async () => {
    const setup = await setupConversation(harness!);

    // First connection: send msg A, capture its id, disconnect.
    const sockA = connectClient(harness!, setup.wsToken);
    await waitForConnect(sockA);
    const ackA = await emitWithAck<{ ok: boolean; message: { id: string } }>(
      sockA,
      'message:send',
      { content: 'msg A', clientMessageId: randomUUID() },
    );
    sockA.close();
    await new Promise((r) => setTimeout(r, 100)); // let server process disconnect

    // While "offline": CSM posts msg B and msg C via REST.
    const csmPost = (content: string) =>
      harness!.app.inject({
        method: 'POST',
        url: `/v1/sessions/${setup.sessionId}/messages`,
        headers: { authorization: `Bearer ${setup.csmAccessToken}` },
        payload: { content, clientMessageId: randomUUID() },
      });
    expect((await csmPost('msg B')).statusCode).toBe(200);
    expect((await csmPost('msg C')).statusCode).toBe(200);

    // Reconnect: re-call /v1/chat/verify with the device cookie to mint a
    // fresh wsToken. Then connect with lastSeenMessageId set.
    const wsToken2 = await reissueWsToken(harness!, setup);
    const replayed: Array<{ content: string }> = [];
    const sockB = connectClient(harness!, wsToken2, ackA.message.id);
    sockB.on('message:new', (msg: { content: string }) => replayed.push(msg));
    await waitForConnect(sockB);
    await new Promise((r) => setTimeout(r, 300));

    const contents = replayed.map((m) => m.content).sort();
    expect(contents).toEqual(['msg B', 'msg C']);

    sockB.close();
  });
});

describe('socket.io — presence', () => {
  let harness: SocketHarness | undefined;

  beforeEach(async () => {
    harness = await buildSocketHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('CSM connect → presence:csm online; CSM disconnect → presence:csm offline', async () => {
    const setup = await setupConversation(harness!);
    const clientSock = connectClient(harness!, setup.wsToken);
    await waitForConnect(clientSock);

    const onlineP = waitForEvent<{ online: boolean }>(clientSock, 'presence:csm');
    const csmSock = connectCsm(harness!, setup.csmAccessToken);
    await waitForConnect(csmSock);
    const online = await onlineP;
    expect(online.online).toBe(true);

    const offlineP = waitForEvent<{ online: boolean }>(clientSock, 'presence:csm');
    csmSock.disconnect();
    const offline = await offlineP;
    expect(offline.online).toBe(false);

    clientSock.close();
  });
});
