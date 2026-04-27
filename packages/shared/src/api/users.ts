import { z } from 'zod';
import {
  emailSchema,
  paginationQuerySchema,
  paginated,
  userRoleSchema,
  uuidSchema,
} from '../primitives.js';
import { userSchema } from './auth.js';

// ─── Password policy (CLAUDE.md §"Password policy") ─────────────────────
// Min 12 chars, uppercase + lowercase + digit + special.
// Common-password rejection happens at the service layer.
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(256, 'Password is too long.')
  .refine((v) => /[a-z]/.test(v), { message: 'Must include a lowercase letter.' })
  .refine((v) => /[A-Z]/.test(v), { message: 'Must include an uppercase letter.' })
  .refine((v) => /\d/.test(v), { message: 'Must include a digit.' })
  .refine((v) => /[^A-Za-z0-9]/.test(v), { message: 'Must include a special character.' });

// ─── GET /v1/users ──────────────────────────────────────────────────────
export const listUsersQuerySchema = paginationQuerySchema.extend({
  role: userRoleSchema.optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const listUsersResponseSchema = paginated(userSchema);
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;

// ─── POST /v1/users ─────────────────────────────────────────────────────
export const createUserRequestSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(255),
  role: userRoleSchema,
  password: passwordSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

// ─── GET /v1/users/:userId ──────────────────────────────────────────────
export const userIdParamSchema = z.object({ userId: uuidSchema });
export type UserIdParam = z.infer<typeof userIdParamSchema>;

// ─── PATCH /v1/users/:userId ────────────────────────────────────────────
export const updateUserRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    role: userRoleSchema.optional(),
    isActive: z.boolean().optional(),
    password: passwordSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

// DELETE /v1/users/:userId → 204
