import { z } from 'zod';

// ─── Identity ────────────────────────────────────────────────────────────
export const uuidSchema = z.string().uuid();
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .email()
  .transform((v) => v.toLowerCase());

// ─── Domain enums ────────────────────────────────────────────────────────
export const userRoleSchema = z.enum(['csm', 'admin']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const sessionStatusSchema = z.enum([
  'pending',
  'active',
  'csm_handling',
  'closed',
  'expired',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// 'ai' is reserved for Phase 2.
export const messageSenderTypeSchema = z.enum(['client', 'csm', 'system']);
export type MessageSenderType = z.infer<typeof messageSenderTypeSchema>;

// ─── Free-form metadata ──────────────────────────────────────────────────
// Recursive JSON-compatible type used for `metadata` columns. Kept
// permissive so callers can store anything serializable.
type Json = string | number | boolean | null | { [k: string]: Json } | Json[];
export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(jsonSchema),
  ]),
);
export const metadataSchema = z.record(jsonSchema).default({});

// ─── Pagination ──────────────────────────────────────────────────────────
const paginationBase = {
  page: z.coerce.number().int().min(1).default(1),
};

export const paginationQuerySchema = z.object({
  ...paginationBase,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// Message endpoints may load up to 200 in a single batch (older history).
export const messagesPaginationQuerySchema = z.object({
  ...paginationBase,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MessagesPaginationQuery = z.infer<typeof messagesPaginationQuerySchema>;

/** Wraps a row schema in `{ items, page, limit, total, hasMore }`. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  });
}

/** Cursor-style pagination response (used by message endpoints). */
export function cursorPaginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    hasMore: z.boolean(),
    oldestCreatedAt: z.string().datetime().nullable(),
  });
}
