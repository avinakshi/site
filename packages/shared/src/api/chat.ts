import { z } from 'zod';
import { sessionStatusSchema, uuidSchema } from '../primitives.js';
import { listMessagesResponseSchema, sendMessageRequestSchema } from './messages.js';

// ─── POST /v1/chat/verify ───────────────────────────────────────────────
export const chatVerifyRequestSchema = z.object({
  // The URL token is a JWT; here we keep it loose and let the token
  // service do strict signature/exp validation.
  token: z.string().min(1).max(2048),
});
export type ChatVerifyRequest = z.infer<typeof chatVerifyRequestSchema>;

export const chatVerifyResponseSchema = z.object({
  sessionId: uuidSchema,
  clientName: z.string(),
  csmName: z.string().nullable(),
  status: sessionStatusSchema,
  sessionJwt: z.string(),
  wsToken: z.string(),
  expiresAt: z.string().datetime(),
});
export type ChatVerifyResponse = z.infer<typeof chatVerifyResponseSchema>;

// ─── GET /v1/chat/session ───────────────────────────────────────────────
export const chatSessionResponseSchema = z.object({
  sessionId: uuidSchema,
  clientName: z.string(),
  csmName: z.string().nullable(),
  status: sessionStatusSchema,
  csmOnline: z.boolean(),
  csmLastSeenAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
});
export type ChatSessionResponse = z.infer<typeof chatSessionResponseSchema>;

// ─── GET /v1/chat/messages ──────────────────────────────────────────────
// Reuses listMessagesResponseSchema. Query mirrors the CSM endpoint.
export { listMessagesQuerySchema as chatListMessagesQuerySchema } from './messages.js';
export const chatListMessagesResponseSchema = listMessagesResponseSchema;
export type ChatListMessagesResponse = z.infer<typeof chatListMessagesResponseSchema>;

// ─── POST /v1/chat/messages ─────────────────────────────────────────────
export const chatSendMessageRequestSchema = sendMessageRequestSchema;
export type ChatSendMessageRequest = z.infer<typeof chatSendMessageRequestSchema>;
