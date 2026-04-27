import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { refreshTokens, users } from '@csm-chat/db';
import { REFRESH_COOKIE } from '../src/routes/auth.js';
import { sha256Hex } from '../src/lib/tokens.js';
import { buildHarness, type TestHarness } from './helpers.js';

const SEED_PASSWORD = 'TestUser_Pass!1234';
const ADMIN_EMAIL = 'admin@example.com';
const CSM_EMAIL = 'csm1@example.com';

async function seedUsers(harness: TestHarness): Promise<{ adminId: string; csmId: string }> {
  if (harness.dbClient.driver !== 'pglite') throw new Error('expects pglite');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const inserted = await harness.dbClient.db
    .insert(users)
    .values([
      { email: ADMIN_EMAIL, name: 'Admin', role: 'admin', passwordHash },
      { email: CSM_EMAIL, name: 'CSM', role: 'csm', passwordHash },
    ])
    .returning({ id: users.id, email: users.email });
  const admin = inserted.find((u) => u.email === ADMIN_EMAIL);
  const csm = inserted.find((u) => u.email === CSM_EMAIL);
  if (!admin || !csm) throw new Error('seed insert returned wrong shape');
  return { adminId: admin.id, csmId: csm.id };
}

/** Pull the value of a Set-Cookie header by name. */
function readSetCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of headers) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(line);
    if (m && m[1] !== undefined) return decodeURIComponent(m[1]);
  }
  return null;
}

describe('auth — login', () => {
  let harness: TestHarness | undefined;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedUsers(harness);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('issues access token + sets csm_refresh cookie on success', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: SEED_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWS
    expect(body.expiresIn).toBe(900);
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.user.role).toBe('admin');
    expect(body).not.toHaveProperty('refreshToken'); // never in body
    const refresh = readSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);
    expect(refresh).toBeTruthy();
    const setCookies = res.headers['set-cookie'];
    const cookieLine = Array.isArray(setCookies) ? setCookies.join(';') : (setCookies ?? '');
    expect(cookieLine).toMatch(/HttpOnly/i);
    expect(cookieLine).toMatch(/Path=\/v1\/auth/);
  });

  it('returns INVALID_CREDENTIALS on bad password', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'wrong-password-but-policy-OK!1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('returns INVALID_CREDENTIALS for unknown email (no enumeration)', async () => {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'whatever-1A!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failed attempts; even right password fails while locked', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await harness!.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: CSM_EMAIL, password: 'WrongPass-' + i + '_X1!' },
      });
      expect(res.statusCode).toBe(401);
    }
    const locked = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: CSM_EMAIL, password: SEED_PASSWORD },
    });
    expect(locked.statusCode).toBe(401);

    const row = await harness!.dbClient.db
      .select({ failed: users.failedLoginAttempts, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.email, CSM_EMAIL))
      .limit(1);
    expect(row[0]?.failed).toBeGreaterThanOrEqual(5);
    expect(row[0]?.lockedUntil).toBeTruthy();
    expect(row[0]?.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('resets failed counter and stamps lastSeenAt on successful login', async () => {
    await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: CSM_EMAIL, password: 'WrongOne_1A!' },
    });
    const after = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: CSM_EMAIL, password: SEED_PASSWORD },
    });
    expect(after.statusCode).toBe(200);
    const row = await harness!.dbClient.db
      .select({ failed: users.failedLoginAttempts, lastSeen: users.lastSeenAt })
      .from(users)
      .where(eq(users.email, CSM_EMAIL))
      .limit(1);
    expect(row[0]?.failed).toBe(0);
    expect(row[0]?.lastSeen).toBeTruthy();
  });
});

describe('auth — refresh + logout', () => {
  let harness: TestHarness | undefined;

  beforeEach(async () => {
    harness = await buildHarness();
    await seedUsers(harness);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function loginAndGetCookie(): Promise<string> {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: SEED_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = readSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);
    if (!cookie) throw new Error('no refresh cookie set on login');
    return cookie;
  }

  it('rotates the refresh cookie on each /refresh call', async () => {
    const first = await loginAndGetCookie();
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: first },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body).not.toHaveProperty('refreshToken');
    const second = readSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('refreshing with a previously rotated (revoked) token returns 401', async () => {
    const first = await loginAndGetCookie();
    // Rotate once.
    await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: first },
    });
    // Try to use the now-revoked first token.
    const replay = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: first },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('INVALID_TOKEN');
  });

  it('refresh with no cookie returns 401', async () => {
    const res = await harness!.app.inject({ method: 'POST', url: '/v1/auth/refresh' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });

  it('logout revokes the refresh token and clears the cookie', async () => {
    const cookie = await loginAndGetCookie();
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { [REFRESH_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(204);
    const setCookies = res.headers['set-cookie'];
    const cookieLine = Array.isArray(setCookies) ? setCookies.join(';') : (setCookies ?? '');
    expect(cookieLine).toMatch(/csm_refresh=/);
    expect(cookieLine).toMatch(/Expires=|Max-Age=0/i);

    // Token row revoked in DB.
    const tokenHash = sha256Hex(cookie);
    const rows = await harness!.dbClient.db
      .select({ revokedAt: refreshTokens.revokedAt, reason: refreshTokens.revokedReason })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    expect(rows[0]?.revokedAt).toBeTruthy();
    expect(rows[0]?.reason).toBe('user_logout');

    // Subsequent refresh with the same cookie fails.
    const after = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('auth — /me + Bearer auth plugin', () => {
  let harness: TestHarness | undefined;
  let adminId = '';

  beforeEach(async () => {
    harness = await buildHarness();
    const ids = await seedUsers(harness);
    adminId = ids.adminId;
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function loginAccessToken(): Promise<string> {
    const res = await harness!.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: SEED_PASSWORD },
    });
    return res.json().accessToken as string;
  }

  it('returns the user profile with a valid Bearer token', async () => {
    const token = await loginAccessToken();
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(adminId);
    expect(body.email).toBe(ADMIN_EMAIL);
    expect(body.role).toBe('admin');
  });

  it('returns 401 UNAUTHENTICATED with no Authorization header', async () => {
    const res = await harness!.app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 INVALID_TOKEN with a tampered Bearer', async () => {
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });

  it('returns 401 TOKEN_EXPIRED for an already-expired token', async () => {
    const expired = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('csm-chat-api')
      .setAudience('csm-chat')
      .setSubject(adminId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 30)
      .sign(new TextEncoder().encode(harness!.config.JWT_ACCESS_SECRET));
    const res = await harness!.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('TOKEN_EXPIRED');
  });
});
