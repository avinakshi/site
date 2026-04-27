import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { sessions, users } from '@csm-chat/db';
import { sha256Hex } from '../src/lib/tokens.js';
import { verifySessionUrlToken } from '../src/lib/jwt.js';
import { buildHarness, type TestHarness } from './helpers.js';

const SEED_PASSWORD = 'TestUser_Pass!1234';

interface SeedResult {
  adminId: string;
  csm1Id: string;
  csm2Id: string;
  adminToken: string;
  csm1Token: string;
}

async function seedAndLogin(harness: TestHarness): Promise<SeedResult> {
  if (harness.dbClient.driver !== 'pglite') throw new Error('expects pglite');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const inserted = await harness.dbClient.db
    .insert(users)
    .values([
      { email: 'admin@example.com', name: 'Admin', role: 'admin', passwordHash },
      { email: 'csm1@example.com', name: 'CSM One', role: 'csm', passwordHash },
      { email: 'csm2@example.com', name: 'CSM Two', role: 'csm', passwordHash },
    ])
    .returning({ id: users.id, email: users.email });
  const adminId = inserted.find((u) => u.email === 'admin@example.com')!.id;
  const csm1Id = inserted.find((u) => u.email === 'csm1@example.com')!.id;
  const csm2Id = inserted.find((u) => u.email === 'csm2@example.com')!.id;

  const adminLogin = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'admin@example.com', password: SEED_PASSWORD },
  });
  const csm1Login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'csm1@example.com', password: SEED_PASSWORD },
  });
  return {
    adminId,
    csm1Id,
    csm2Id,
    adminToken: adminLogin.json().accessToken,
    csm1Token: csm1Login.json().accessToken,
  };
}

describe('sessions — create + chat URL', () => {
  let harness: TestHarness | undefined;
  let s: SeedResult;

  beforeEach(async () => {
    harness = await buildHarness();
    s = await seedAndLogin(harness);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('CSM creates a session for a brand-new client and gets a chat URL', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: {
        clientEmail: 'alice@acme.com',
        clientName: 'Alice',
        clientCompany: 'Acme',
        assignedCsmId: s.csm1Id,
        expiresInDays: 7,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.session.status).toBe('pending');
    expect(body.session.assignedCsmId).toBe(s.csm1Id);
    expect(body.session.createdByUserId).toBe(s.csm1Id);
    expect(body.chatUrl).toMatch(/\/c\/[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Token in URL is a JWT signed with SESSION_TOKEN_SECRET; sub === sessionId.
    const token = body.chatUrl.split('/c/')[1] as string;
    const payload = await verifySessionUrlToken(token, harness!.config.SESSION_TOKEN_SECRET);
    expect(payload.sid).toBe(body.session.id);
    expect(payload.ver).toBe(1);

    // DB row stores ONLY the sha256 hash of that token.
    const row = await harness!.dbClient.db
      .select({ tokenHash: sessions.tokenHash, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, body.session.id))
      .limit(1);
    expect(row[0]?.tokenHash).toBe(sha256Hex(token));
    expect(row[0]?.status).toBe('pending');
  });

  it('reuses an existing client when the email matches (case-insensitive)', async () => {
    const a = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: {
        clientEmail: 'bob@example.com',
        clientName: 'Bob',
      },
    });
    const b = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: {
        clientEmail: 'BOB@EXAMPLE.com',
        clientName: 'Bob (later)',
      },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().session.clientId).toBe(b.json().session.clientId);
  });

  it('rejects expiresInDays < 1 or > 30', async () => {
    const tooSmall = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { clientEmail: 'x@example.com', clientName: 'X', expiresInDays: 0 },
    });
    expect(tooSmall.statusCode).toBe(400);
    expect(tooSmall.json().code).toBe('VALIDATION_ERROR');

    const tooBig = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { clientEmail: 'y@example.com', clientName: 'Y', expiresInDays: 31 },
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('returns 401 without a Bearer token', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { clientEmail: 'z@example.com', clientName: 'Z' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('sessions — list, get, patch, close', () => {
  let harness: TestHarness | undefined;
  let s: SeedResult;
  let sessionAId = '';
  let sessionBId = '';

  beforeEach(async () => {
    harness = await buildHarness();
    s = await seedAndLogin(harness);

    const a = await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: {
        clientEmail: 'alpha@acme.com',
        clientName: 'Alpha',
        assignedCsmId: s.csm1Id,
      },
    });
    sessionAId = a.json().session.id;

    const b = await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        clientEmail: 'beta@acme.com',
        clientName: 'Beta',
        assignedCsmId: s.csm2Id,
      },
    });
    sessionBId = b.json().session.id;
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('lists sessions filtered by assignedCsmId', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: `/v1/sessions?assignedCsmId=${s.csm1Id}`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(sessionAId);
  });

  it('lists sessions filtered by status[]', async () => {
    // Close session A so we can filter on it.
    await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionAId}/close`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { reason: 'test wrap-up' },
    });
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/sessions?status=closed',
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(sessionAId);
    expect(body.items[0].status).toBe('closed');
  });

  it('GET /:sessionId returns the detailed view with embedded client + CSM + messageCount', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionAId}`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(sessionAId);
    expect(body.client.email).toBe('alpha@acme.com');
    expect(body.assignedCsm.id).toBe(s.csm1Id);
    expect(body.messageCount).toBe(0);
  });

  it('GET /:sessionId returns 404 for an unknown session', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: `/v1/sessions/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('PATCH reassigns a session to another CSM', async () => {
    const res = await harness!.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${sessionBId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { assignedCsmId: s.csm1Id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignedCsmId).toBe(s.csm1Id);
  });

  it('POST /close sets status=closed, closedAt, closedBy, closedReason', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionAId}/close`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { reason: 'resolved' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('closed');
    expect(body.closedAt).toBeTruthy();
    expect(body.closedByUserId).toBe(s.csm1Id);
    expect(body.closedReason).toBe('resolved');
  });

  it('Closing an already-closed session returns 410 SESSION_CLOSED', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionAId}/close`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { reason: 'first' },
    });
    const second = await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionAId}/close`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { reason: 'second' },
    });
    expect(second.statusCode).toBe(410);
    expect(second.json().code).toBe('SESSION_CLOSED');
  });
});

describe('clients — list + get', () => {
  let harness: TestHarness | undefined;
  let s: SeedResult;

  beforeEach(async () => {
    harness = await buildHarness();
    s = await seedAndLogin(harness);
    // Seed a couple of clients via session creation.
    await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { clientEmail: 'one@acme.com', clientName: 'One' },
    });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.csm1Token}` },
      payload: { clientEmail: 'two@beta.io', clientName: 'Two' },
    });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('GET /v1/clients lists all clients', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/clients',
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(2);
  });

  it('GET /v1/clients?search=acme filters by ILIKE on email or name', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/clients?search=acme',
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].email).toBe('one@acme.com');
  });

  it('GET /v1/clients/:id returns the single client', async () => {
    const list = await harness!.app.inject({
      method: 'GET',
      url: '/v1/clients?search=beta',
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    const id = list.json().items[0].id;
    const res = await harness!.app.inject({
      method: 'GET',
      url: `/v1/clients/${id}`,
      headers: { authorization: `Bearer ${s.csm1Token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });
});
