import { z } from 'zod';
import {
  cursorPaginated,
  messageSenderTypeSchema,
  messagesPaginationQuerySchema,
  metadataSchema,
  uuidSchema,
} from '../primitives.js';

// ─── Core message shape ─────────────────────────────────────────────────
export const messageSchema = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  senderType: messageSenderTypeSchema,
  senderId: uuidSchema.nullable(),
  content: z.string(),
  clientMessageId: uuidSchema.nullable(),
  deliveredAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  metadata: metadataSchema,
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;

// ─── Send a message (CSM and Chat both share this body) ─────────────────
// Max payload aligns with the WebSocket 8 KB cap. UTF-8 char count is a
// proxy; bytes-precise enforcement happens at the route layer.
export const MESSAGE_CONTENT_MAX_LEN = 8000;

export const sendMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(MESSAGE_CONTENT_MAX_LEN),
  clientMessageId: uuidSchema,
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

// ─── List messages (CSM side) ───────────────────────────────────────────
// GET /v1/sessions/:sessionId/messages
export const listMessagesQuerySchema = messagesPaginationQuerySchema.extend({
  before: z.coerce.date().optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listMessagesResponseSchema = cursorPaginated(messageSchema);
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;
