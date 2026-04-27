import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { sessionDevices, sessions, users } from '@csm-chat/db';
import { DEVICE_COOKIE } from '../src/routes/chat.js';
import { buildHarness, type TestHarness } from './helpers.js';

const SEED_PASSWORD = 'TestUser_Pass!1234';

interface Setup {
  harness: TestHarness;
  csmId: string;
  csmToken: string;
  sessionId: string;
  urlToken: string;
}

async function setupSession(harness: TestHarness): Promise<Setup> {
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
  const csmToken = login.json().accessToken;

  const create = await harness.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${csmToken}` },
    payload: {
      clientEmail: 'client@example.com',
      clientName: 'Client',
      assignedCsmId: csmId,
    },
  });
  const body = create.json();
  const urlToken = (body.chatUrl as string).split('/c/')[1]!;
  return { harness, csmId, csmToken, sessionId: body.session.id, urlToken };
}

describe('chat — POST /v1/chat/verify (full flow)', () => {
  let harness: TestHarness | undefined;
  let s: Setup;

  beforeEach(async () => {
    harness = await buildHarness();
    s = await setupSession(harness);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('first visit creates device row, sets cookie, flips status to active, returns tokens', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe(s.sessionId);
    expect(body.clientName).toBe('Client');
    expect(body.csmName).toBe('CSM');
    expect(body.status).toBe('active');
    expect(body.sessionJwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.wsToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    // Cookie set on response.
    const setCookie = res.headers['set-cookie'];
    const line = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(line).toContain(`${DEVICE_COOKIE}=`);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/Path=\/v1\/chat/);

    // session_devices row exists; session.status flipped + firstAccessedAt set.
    const deviceRow = await harness!.dbClient.db
      .select()
      .from(sessionDevices)
      .where(eq(sessionDevices.sessionId, s.sessionId))
      .limit(1);
    expect(deviceRow[0]).toBeTruthy();

    const sessionRow = await harness!.dbClient.db
      .select({ status: sessions.status, firstAccessedAt: sessions.firstAccessedAt })
      .from(sessions)
      .where(eq(sessions.id, s.sessionId))
      .limit(1);
    expect(sessionRow[0]?.status).toBe('active');
    expect(sessionRow[0]?.firstAccessedAt).toBeTruthy();
  });

  it('second visit with the same cookie succeeds (no new device row)', async () => {
    const first = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    const cookie = (first.cookies ?? []).find((c) => c.name === DEVICE_COOKIE);
    expect(cookie).toBeTruthy();

    const second = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      cookies: { [DEVICE_COOKIE]: cookie!.value },
      payload: { token: s.urlToken },
    });
    expect(second.statusCode).toBe(200);

    const rows = await harness!.dbClient.db
      .select()
      .from(sessionDevices)
      .where(eq(sessionDevices.sessionId, s.sessionId));
    expect(rows.length).toBe(1);
  });

  it('visit without cookie when device row exists → 403 DEVICE_MISMATCH', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    const second = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().code).toBe('DEVICE_MISMATCH');
  });

  it('visit with wrong cookie → 403 DEVICE_MISMATCH', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    const wrong = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      cookies: { [DEVICE_COOKIE]: randomUUID() },
      payload: { token: s.urlToken },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe('DEVICE_MISMATCH');
  });

  it('verify on a closed session → 410 SESSION_CLOSED', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${s.sessionId}/close`,
      headers: { authorization: `Bearer ${s.csmToken}` },
      payload: { reason: 'done' },
    });
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('SESSION_CLOSED');
  });

  it('verify with an expired URL token → 401 TOKEN_EXPIRED', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ ver: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('csm-chat-api')
      .setAudience('csm-chat-url')
      .setSubject(s.sessionId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now - 30)
      .sign(new TextEncoder().encode(harness!.config.SESSION_TOKEN_SECRET));
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: expired },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('TOKEN_EXPIRED');
  });

  it('verify with a tampered URL token → 401 INVALID_TOKEN', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken.slice(0, -3) + 'xxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });
});

describe('chat — REST messaging + idempotency', () => {
  let harness: TestHarness | undefined;
  let s: Setup;
  let sessionJwt = '';

  beforeEach(async () => {
    harness = await buildHarness();
    s = await setupSession(harness);
    const verify = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: s.urlToken },
    });
    sessionJwt = verify.json().sessionJwt;
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('GET /v1/chat/session returns session info with csmOnline boolean', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/chat/session',
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe(s.sessionId);
    expect(body.clientName).toBe('Client');
    expect(body.csmName).toBe('CSM');
    expect(typeof body.csmOnline).toBe('boolean');
  });

  it('client sends a message, then lists it back', async () => {
    const cid = randomUUID();
    const send = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { content: 'hello from client', clientMessageId: cid },
    });
    expect(send.statusCode).toBe(200);
    const msg = send.json();
    expect(msg.senderType).toBe('client');
    expect(msg.senderId).toBeNull();
    expect(msg.content).toBe('hello from client');
    expect(msg.clientMessageId).toBe(cid);

    const list = await harness!.app.inject({
      method: 'GET',
      url: '/v1/chat/messages',
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(msg.id);
  });

  it('idempotent send: duplicate clientMessageId returns the same message', async () => {
    const cid = randomUUID();
    const a = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { content: 'first', clientMessageId: cid },
    });
    const b = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { content: 'this should be ignored', clientMessageId: cid },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(b.json().content).toBe('first'); // existing row, not the new content
  });

  it('sending to a closed session → 410', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${s.sessionId}/close`,
      headers: { authorization: `Bearer ${s.csmToken}` },
      payload: { reason: 'done' },
    });
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      headers: { authorization: `Bearer ${sessionJwt}` },
      payload: { content: 'too late', clientMessageId: randomUUID() },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('SESSION_CLOSED');
  });

  it('CSM POSTs to /v1/sessions/:id/messages and the chat client sees it via /v1/chat/messages', async () => {
    const csmCid = randomUUID();
    const send = await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${s.sessionId}/messages`,
      headers: { authorization: `Bearer ${s.csmToken}` },
      payload: { content: 'hi from CSM', clientMessageId: csmCid },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json().senderType).toBe('csm');
    expect(send.json().senderId).toBe(s.csmId);

    const list = await harness!.app.inject({
      method: 'GET',
      url: '/v1/chat/messages',
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    const body = list.json();
    expect(body.items.find((m: { id: string }) => m.id === send.json().id)).toBeTruthy();
  });

  it('chat endpoints reject missing / tampered session JWT', async () => {
    const noToken = await harness!.app.inject({ method: 'GET', url: '/v1/chat/session' });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().code).toBe('UNAUTHENTICATED');

    const bad = await harness!.app.inject({
      method: 'GET',
      url: '/v1/chat/session',
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('INVALID_TOKEN');
  });
});
