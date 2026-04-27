import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { auditLog, users } from '@csm-chat/db';
import { buildHarness, type TestHarness } from './helpers.js';

const SEED_PASSWORD = 'TestUser_Pass!1234';

interface Setup {
  adminId: string;
  csmId: string;
  adminToken: string;
}

async function seedAndLogin(harness: TestHarness): Promise<Setup> {
  if (harness.dbClient.driver !== 'pglite') throw new Error('expects pglite');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const inserted = await harness.dbClient.db
    .insert(users)
    .values([
      { email: 'admin@example.com', name: 'Admin', role: 'admin', passwordHash },
      { email: 'csm@example.com', name: 'CSM', role: 'csm', passwordHash },
    ])
    .returning({ id: users.id, email: users.email });
  const adminId = inserted.find((u) => u.email === 'admin@example.com')!.id;
  const csmId = inserted.find((u) => u.email === 'csm@example.com')!.id;

  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'admin@example.com', password: SEED_PASSWORD },
  });
  return { adminId, csmId, adminToken: login.json().accessToken };
}

async function readAudit(harness: TestHarness, action: string) {
  return harness.dbClient.db.select().from(auditLog).where(eq(auditLog.action, action));
}

describe('audit log — auth events', () => {
  let harness: TestHarness | undefined;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('records auth.login.succeeded with actor + requestId + ip + ua', async () => {
    const { adminId } = await seedAndLogin(harness!);
    const rows = await readAudit(harness!, 'auth.login.succeeded');
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actorType).toBe('user');
    expect(row.actorId).toBe(adminId);
    expect(row.targetType).toBe('user');
    expect(row.targetId).toBe(adminId);
    expect(row.requestId).toMatch(/^req_/);
    expect(row.ipAddress).toBeTruthy();
  });

  it('records auth.login.failed with the attempted email and no actorId', async () => {
    await seedAndLogin(harness!);
    await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: 'WrongPass_1A!' },
    });
    const rows = await readAudit(harness!, 'auth.login.failed');
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actorType).toBe('system');
    expect(row.actorId).toBeNull();
    expect((row.metadata as { email?: string }).email).toBe('admin@example.com');
  });

  it('records auth.logout with actor when cookie identifies the user', async () => {
    const { adminId } = await seedAndLogin(harness!);
    // Re-login to grab the cookie value.
    const login = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: SEED_PASSWORD },
    });
    const setCookie = login.headers['set-cookie'];
    const cookieLine = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const m = /csm_refresh=([^;]+)/.exec(cookieLine ?? '');
    const cookieValue = m ? decodeURIComponent(m[1]!) : '';

    await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { csm_refresh: cookieValue },
    });
    const rows = await readAudit(harness!, 'auth.logout');
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1]!;
    expect(row.actorType).toBe('user');
    expect(row.actorId).toBe(adminId);
  });
});

describe('audit log — user events', () => {
  let harness: TestHarness | undefined;
  let s: Setup;

  beforeEach(async () => {
    harness = await buildHarness();
    s = await seedAndLogin(harness);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('records user.create / user.update / user.delete', async () => {
    const create = await harness!.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        email: 'fresh@example.com',
        name: 'Fresh',
        role: 'csm',
        password: 'Fresh_Pass!2345',
      },
    });
    const newUserId = create.json().id;

    await harness!.app.inject({
      method: 'PATCH',
      url: `/v1/users/${newUserId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { name: 'Fresh Renamed' },
    });

    await harness!.app.inject({
      method: 'DELETE',
      url: `/v1/users/${newUserId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });

    const created = await readAudit(harness!, 'user.create');
    expect(created.some((r) => r.targetId === newUserId && r.actorId === s.adminId)).toBe(true);

    const updated = await readAudit(harness!, 'user.update');
    expect(updated.some((r) => r.targetId === newUserId)).toBe(true);

    const deleted = await readAudit(harness!, 'user.delete');
    expect(deleted.some((r) => r.targetId === newUserId)).toBe(true);
  });
});

describe('audit log — session + chat events', () => {
  let harness: TestHarness | undefined;
  let s: Setup;

  beforeEach(async () => {
    harness = await buildHarness();
    s = await seedAndLogin(harness);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('records session.create, session.update, session.close, and chat.verify (success)', async () => {
    const create = await harness!.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        clientEmail: 'audit-client@example.com',
        clientName: 'Audit Client',
        assignedCsmId: s.csmId,
      },
    });
    const sessionId = create.json().session.id as string;
    const urlToken = (create.json().chatUrl as string).split('/c/')[1]!;

    await harness!.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { metadata: { topic: 'pricing' } },
    });

    await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: urlToken },
    });

    await harness!.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/close`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { reason: 'audit test' },
    });

    expect(
      (await readAudit(harness!, 'session.create')).some((r) => r.targetId === sessionId),
    ).toBe(true);
    expect(
      (await readAudit(harness!, 'session.update')).some((r) => r.targetId === sessionId),
    ).toBe(true);
    expect((await readAudit(harness!, 'session.close')).some((r) => r.targetId === sessionId)).toBe(
      true,
    );

    const verifyRows = await readAudit(harness!, 'chat.verify');
    expect(verifyRows.some((r) => r.targetId === sessionId && r.actorType === 'client')).toBe(true);
    const verifyRow = verifyRows.find((r) => r.targetId === sessionId)!;
    expect((verifyRow.metadata as { firstVisit?: boolean }).firstVisit).toBe(true);
    expect(verifyRow.requestId).toMatch(/^req_/);
  });

  it('does NOT record an audit event for chat.verify failures', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: '/v1/chat/verify',
      payload: { token: 'not-a-jwt' },
    });
    const rows = await harness!.dbClient.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'chat.verify')));
    expect(rows.length).toBe(0);
  });
});
