import { z } from 'zod';
import { metadataSchema, paginationQuerySchema, paginated, uuidSchema } from '../primitives.js';

export const clientSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  name: z.string(),
  company: z.string().nullable(),
  metadata: metadataSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Client = z.infer<typeof clientSchema>;

// ─── GET /v1/clients ────────────────────────────────────────────────────
export const listClientsQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(255).optional(),
});
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;

export const listClientsResponseSchema = paginated(clientSchema);
export type ListClientsResponse = z.infer<typeof listClientsResponseSchema>;

// ─── GET /v1/clients/:clientId ──────────────────────────────────────────
export const clientIdParamSchema = z.object({ clientId: uuidSchema });
export type ClientIdParam = z.infer<typeof clientIdParamSchema>;
