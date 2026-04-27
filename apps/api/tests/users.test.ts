import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { users } from '@csm-chat/db';
import { buildHarness, type TestHarness } from './helpers.js';

const SEED_PASSWORD = 'TestUser_Pass!1234';
const NEW_USER_PASSWORD = 'BrandNew_Pass!9876';

interface SeedResult {
  adminId: string;
  csmId: string;
  adminToken: string;
  csmToken: string;
}

async function seedAndLogin(harness: TestHarness): Promise<SeedResult> {
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

  const adminLogin = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'admin@example.com', password: SEED_PASSWORD },
  });
  const csmLogin = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'csm@example.com', password: SEED_PASSWORD },
  });
  return {
    adminId,
    csmId,
    adminToken: adminLogin.json().accessToken,
    csmToken: csmLogin.json().accessToken,
  };
}

describe('users — admin CRUD', () => {
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

  it('admin creates a CSM, then lists & gets them', async () => {
    const create = await harness!.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        email: 'newcsm@example.com',
        name: 'New CSM',
        role: 'csm',
        password: NEW_USER_PASSWORD,
      },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.email).toBe('newcsm@example.com');
    expect(body.role).toBe('csm');
    expect(body.isActive).toBe(true);
    expect(body).not.toHaveProperty('passwordHash');

    const list = await harness!.app.inject({
      method: 'GET',
      url: '/v1/users?role=csm',
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(
      listBody.items.find((u: { email: string }) => u.email === 'newcsm@example.com'),
    ).toBeTruthy();
    expect(listBody.total).toBeGreaterThanOrEqual(2); // existing + new

    const get = await harness!.app.inject({
      method: 'GET',
      url: `/v1/users/${body.id}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(body.id);
  });

  it('admin updates a CSM role to admin', async () => {
    const res = await harness!.app.inject({
      method: 'PATCH',
      url: `/v1/users/${s.csmId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
  });

  it('admin deactivates a CSM and the CSM can no longer log in', async () => {
    const patch = await harness!.app.inject({
      method: 'PATCH',
      url: `/v1/users/${s.csmId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isActive).toBe(false);

    const login = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'csm@example.com', password: SEED_PASSWORD },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('admin soft-deletes a user; the row stays but login is denied', async () => {
    const del = await harness!.app.inject({
      method: 'DELETE',
      url: `/v1/users/${s.csmId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(del.statusCode).toBe(204);

    // Row remains, deletedAt is set.
    const row = await harness!.dbClient.db
      .select({ deletedAt: users.deletedAt, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, s.csmId))
      .limit(1);
    expect(row[0]?.deletedAt).toBeTruthy();
    expect(row[0]?.isActive).toBe(false);

    // Login fails for soft-deleted users.
    const login = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'csm@example.com', password: SEED_PASSWORD },
    });
    expect(login.statusCode).toBe(401);

    // GET on a soft-deleted user returns 404 from /v1/users/:id.
    const get = await harness!.app.inject({
      method: 'GET',
      url: `/v1/users/${s.csmId}`,
      headers: { authorization: `Bearer ${s.adminToken}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it('rejects creating a user with a duplicate email (409)', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        email: 'admin@example.com', // already exists
        name: 'Duplicate',
        role: 'csm',
        password: NEW_USER_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });

  it('rejects a weak password on create (400)', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        email: 'weak@example.com',
        name: 'Weak',
        role: 'csm',
        password: 'tooshort',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('rejects a top-common password (Password1!)', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.adminToken}` },
      payload: {
        email: 'common@example.com',
        name: 'Common',
        role: 'csm',
        password: 'Password1!',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('users — role guards', () => {
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

  it('CSM cannot list users (403)', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.csmToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('CSM cannot create users (403)', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${s.csmToken}` },
      payload: {
        email: 'sneaky@example.com',
        name: 'Sneaky',
        role: 'admin',
        password: NEW_USER_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSM can GET their own /v1/users/:id', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: `/v1/users/${s.csmId}`,
      headers: { authorization: `Bearer ${s.csmToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(s.csmId);
  });

  it('CSM cannot GET another user (403)', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: `/v1/users/${s.adminId}`,
      headers: { authorization: `Bearer ${s.csmToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('CSM cannot PATCH or DELETE another user (403)', async () => {
    const patch = await harness!.app.inject({
      method: 'PATCH',
      url: `/v1/users/${s.adminId}`,
      headers: { authorization: `Bearer ${s.csmToken}` },
      payload: { name: 'pwned' },
    });
    expect(patch.statusCode).toBe(403);

    const del = await harness!.app.inject({
      method: 'DELETE',
      url: `/v1/users/${s.adminId}`,
      headers: { authorization: `Bearer ${s.csmToken}` },
    });
    expect(del.statusCode).toBe(403);
  });

  it('unauthenticated requests are 401, not 403', async () => {
    const res = await harness!.app.inject({ method: 'GET', url: '/v1/users' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });
});
