import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { UserRole } from '@csm-chat/shared';

const ALG = 'HS256';
const ISSUER = 'csm-chat-api';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

// ─── Access JWT (CSM/admin) ─────────────────────────────────────────────

export interface AccessTokenPayload {
  /** User UUID. Stored as JWT `sub`. */
  sub: string;
  role: UserRole;
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  ttlSec: number,
): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience('csm-chat')
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: 'csm-chat',
  });
  if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
  if (payload.role !== 'csm' && payload.role !== 'admin') throw new Error('jwt missing role');
  return { sub: payload.sub, role: payload.role };
}

// ─── Session JWT (chat — used in Step 8) ────────────────────────────────

export interface SessionTokenPayload {
  /** Session UUID. Stored as `sub`. */
  sub: string;
  /** Device UUID bound to this session (matches session_devices.device_id). */
  did: string;
}

export async function signSessionJwt(
  payload: SessionTokenPayload,
  secret: string,
  ttlSec: number,
): Promise<string> {
  return new SignJWT({ did: payload.did })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience('csm-chat-session')
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key(secret));
}

export async function verifySessionJwt(
  token: string,
  secret: string,
): Promise<SessionTokenPayload> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: 'csm-chat-session',
  });
  if (typeof payload.sub !== 'string') throw new Error('session jwt missing sub');
  if (typeof payload.did !== 'string') throw new Error('session jwt missing did');
  return { sub: payload.sub, did: payload.did };
}

// ─── Session URL token (the long-lived link a CSM sends to a client) ───
// Signed with SESSION_TOKEN_SECRET (distinct from SESSION_JWT_SECRET, which
// is the short-lived chat session JWT issued AFTER /chat/verify).

export interface SessionUrlTokenPayload {
  /** Session UUID. Stored as `sub`. */
  sid: string;
  /** Token version — bumped if we ever invalidate all in-flight URL tokens. */
  ver: 1;
}

export async function signSessionUrlToken(
  payload: SessionUrlTokenPayload,
  secret: string,
  ttlSec: number,
): Promise<string> {
  return new SignJWT({ ver: payload.ver })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience('csm-chat-url')
    .setSubject(payload.sid)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key(secret));
}

export async function verifySessionUrlToken(
  token: string,
  secret: string,
): Promise<SessionUrlTokenPayload> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: 'csm-chat-url',
  });
  if (typeof payload.sub !== 'string') throw new Error('url token missing sub');
  if (payload.ver !== 1) throw new Error('url token bad version');
  return { sid: payload.sub, ver: 1 };
}

// ─── Discriminate jose error kinds ──────────────────────────────────────

export function isExpiredJwt(err: unknown): boolean {
  return err instanceof joseErrors.JWTExpired;
}

export function isInvalidJwt(err: unknown): boolean {
  return (
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JOSEError
  );
}
