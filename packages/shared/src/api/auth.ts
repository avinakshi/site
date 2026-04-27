import { z } from 'zod';
import { emailSchema, userRoleSchema, uuidSchema } from '../primitives.js';

// ─── Public user shape (no password_hash) ───────────────────────────────
export const userSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  name: z.string(),
  role: userRoleSchema,
  isActive: z.boolean(),
  lastSeenAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof userSchema>;

// ─── POST /v1/auth/login ────────────────────────────────────────────────
// Refresh token transport: the server sets `csm_refresh` httpOnly cookie.
// Body never carries the refresh token.
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: userSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

// ─── POST /v1/auth/refresh ──────────────────────────────────────────────
// No request body; refresh token comes from the cookie.
export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

// ─── POST /v1/auth/logout ───────────────────────────────────────────────
// No body in or out (204).

// ─── GET /v1/auth/me ────────────────────────────────────────────────────
export const meResponseSchema = userSchema;
export type MeResponse = User;
