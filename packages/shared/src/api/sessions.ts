import { z } from 'zod';
import {
  emailSchema,
  metadataSchema,
  paginationQuerySchema,
  paginated,
  sessionStatusSchema,
  uuidSchema,
} from '../primitives.js';
import { clientSchema } from './clients.js';
import { userSchema } from './auth.js';

// ─── Core session shape ─────────────────────────────────────────────────
export const sessionSchema = z.object({
  id: uuidSchema,
  clientId: uuidSchema,
  assignedCsmId: uuidSchema.nullable(),
  createdByUserId: uuidSchema,
  status: sessionStatusSchema,
  firstAccessedAt: z.string().datetime().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  closedByUserId: uuidSchema.nullable(),
  closedReason: z.string().nullable(),
  metadata: metadataSchema,
  // Phase 2 placeholders surfaced for forward-compat. Always 0 / null in Phase 1.
  emailThreadId: z.string().nullable(),
  aiInterventionCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Session = z.infer<typeof sessionSchema>;

// Detailed view returned by GET /v1/sessions/:sessionId
export const sessionDetailSchema = sessionSchema.extend({
  client: clientSchema,
  assignedCsm: userSchema.nullable(),
  messageCount: z.number().int().min(0),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

// ─── POST /v1/sessions ──────────────────────────────────────────────────
// expiresInDays: optional, default 7, range [1, 30].
export const createSessionRequestSchema = z.object({
  clientEmail: emailSchema,
  clientName: z.string().trim().min(1).max(255),
  clientCompany: z.string().trim().min(1).max(255).optional(),
  assignedCsmId: uuidSchema.optional(),
  expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
  metadata: metadataSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = z.object({
  session: sessionSchema,
  chatUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

// ─── GET /v1/sessions ───────────────────────────────────────────────────
// Coerced array filter for repeated `?status[]=foo&status[]=bar`.
const statusArray = z
  .union([sessionStatusSchema, z.array(sessionStatusSchema)])
  .optional()
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

export const listSessionsQuerySchema = paginationQuerySchema.extend({
  status: statusArray,
  assignedCsmId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const listSessionsResponseSchema = paginated(sessionSchema);
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

// ─── Path params for /v1/sessions/:sessionId ────────────────────────────
export const sessionIdParamSchema = z.object({ sessionId: uuidSchema });
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

// ─── PATCH /v1/sessions/:sessionId ──────────────────────────────────────
export const updateSessionRequestSchema = z
  .object({
    assignedCsmId: uuidSchema.nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' });
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

// ─── POST /v1/sessions/:sessionId/close ─────────────────────────────────
export const closeSessionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CloseSessionRequest = z.infer<typeof closeSessionRequestSchema>;
