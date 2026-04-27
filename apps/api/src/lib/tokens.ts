import { createHash, randomBytes } from 'node:crypto';

/** Length in bytes of the opaque refresh token before base64url encoding. */
const REFRESH_TOKEN_BYTES = 32;

export interface RefreshTokenMaterial {
  /** The raw token returned to the client (only place it ever exists in plaintext). */
  token: string;
  /** SHA-256 of the raw token, hex-encoded — what gets stored in `refresh_tokens.token_hash`. */
  hash: string;
}

/** Cryptographically random 32 bytes → base64url, plus its sha256 hash for storage. */
export function generateRefreshToken(): RefreshTokenMaterial {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const hash = sha256Hex(token);
  return { token, hash };
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
