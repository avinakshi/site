import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { clients, sessionDevices, sessions, users, type Database } from '@csm-chat/db';
import {
  chatListMessagesQuerySchema,
  chatListMessagesResponseSchema,
  chatSendMessageRequestSchema,
  chatSessionResponseSchema,
  chatVerifyRequestSchema,
  chatVerifyResponseSchema,
  createProblem,
  messageSchema,
  type ChatVerifyRequest,
  type ListMessagesQuery,
  type SendMessageRequest,
} from '@csm-chat/shared';
import type { Config } from '../config.js';
import type { TokenService } from '../services/token.service.js';
import type { MessageService } from '../services/message.service.js';

export const DEVICE_COOKIE = 'csm_chat_device';

/** Online if the CSM was seen in the last 90 seconds. */
const CSM_ONLINE_THRESHOLD_MS = 90_000;

export interface ChatRoutesOptions {
  db: Database;
  config: Config;
  tokenService: TokenService;
  messageService: MessageService;
}

const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (app, opts) => {
  const { db, config, tokenService, messageService } = opts;

  const deviceCookieOpts = {
    path: '/v1/chat',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    // Stays for the URL-token's lifetime (max 30d in spec); server is the source of truth.
    maxAge: 60 * 60 * 24 * 30,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  } as const;

  // ── POST /v1/chat/verify — full §"Client session flow" ─────────────
  app.post(
    '/v1/chat/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: chatVerifyRequestSchema,
        response: { 200: chatVerifyResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = { requestId: req.id, instance: req.url };
      const { token } = req.body as ChatVerifyRequest;

      // Steps a–d: signature, exp, hash exists, status open.
      const session = await tokenService.verifySessionToken(token, ctx);

      // Step e: device cookie binding (one device per session).
      const cookieDeviceId = req.cookies[DEVICE_COOKIE];
      const existingDevices = await db
        .select()
        .from(sessionDevices)
        .where(eq(sessionDevices.sessionId, session.id))
        .limit(1);
      const existingDevice = existingDevices[0];

      let deviceId: string;
      let isFirstVisit = false;

      if (existingDevice) {
        if (!cookieDeviceId || cookieDeviceId !== existingDevice.deviceId) {
          throw createProblem('DEVICE_MISMATCH', {
            requestId: req.id,
            instance: req.url,
            detail: 'This session is bound to another device.',
          });
        }
        deviceId = existingDevice.deviceId;
        await db
          .update(sessionDevices)
          .set({ lastSeenAt: new Date() })
          .where(eq(sessionDevices.id, existingDevice.id));
      } else {
        // First visit — register device, flip session to active.
        deviceId = randomUUID();
        isFirstVisit = true;
        await db.insert(sessionDevices).values({
          sessionId: session.id,
          deviceId,
          userAgent: req.headers['user-agent'] ?? null,
          ipAddress: req.ip,
        });
        if (session.status === 'pending') {
          await db
            .update(sessions)
            .set({ status: 'active', firstAccessedAt: new Date() })
            .where(eq(sessions.id, session.id));
          session.status = 'active';
          session.firstAccessedAt = new Date();
        }
      }

      // Issue session JWT (1h) and ws token (single-use, 60s).
      const sessionJwt = await tokenService.issueSessionJwt(session.id, deviceId);
      const wsToken = tokenService.issueWsToken(session.id, deviceId);

      if (isFirstVisit) {
        reply.setCookie(DEVICE_COOKIE, deviceId, deviceCookieOpts);
      }

      // Resolve client + CSM names for the chat header.
      const clientRow = await db
        .select({ name: clients.name })
        .from(clients)
        .where(eq(clients.id, session.clientId))
        .limit(1);
      let csmName: string | null = null;
      if (session.assignedCsmId) {
        const csmRow = await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, session.assignedCsmId))
          .limit(1);
        csmName = csmRow[0]?.name ?? null;
      }

      return {
        sessionId: session.id,
        clientName: clientRow[0]?.name ?? '',
        csmName,
        status: session.status,
        sessionJwt,
        wsToken,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  // ── GET /v1/chat/session — current session info + csmOnline ────────
  app.get(
    '/v1/chat/session',
    {
      preHandler: app.verifyChatAuth,
      schema: { response: { 200: chatSessionResponseSchema } },
    },
    async (req) => {
      if (!req.chat) throw new Error('preHandler did not set req.chat');
      const sessionRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, req.chat.sessionId))
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        throw createProblem('NOT_FOUND', { requestId: req.id, instance: req.url });
      }
      const clientRow = await db
        .select({ name: clients.name })
        .from(clients)
        .where(eq(clients.id, session.clientId))
        .limit(1);

      let csmName: string | null = null;
      let csmOnline = false;
      let csmLastSeenAt: string | null = null;
      if (session.assignedCsmId) {
        const csmRow = await db
          .select({ name: users.name, lastSeenAt: users.lastSeenAt })
          .from(users)
          .where(eq(users.id, session.assignedCsmId))
          .limit(1);
        const csm = csmRow[0];
        if (csm) {
          csmName = csm.name;
          csmLastSeenAt = csm.lastSeenAt ? csm.lastSeenAt.toISOString() : null;
          csmOnline =
            !!csm.lastSeenAt && Date.now() - csm.lastSeenAt.getTime() < CSM_ONLINE_THRESHOLD_MS;
        }
      }

      return {
        sessionId: session.id,
        clientName: clientRow[0]?.name ?? '',
        csmName,
        status: session.status,
        csmOnline,
        csmLastSeenAt,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  // ── GET /v1/chat/messages ──────────────────────────────────────────
  app.get(
    '/v1/chat/messages',
    {
      preHandler: app.verifyChatAuth,
      schema: {
        querystring: chatListMessagesQuerySchema,
        response: { 200: chatListMessagesResponseSchema },
      },
    },
    async (req) => {
      if (!req.chat) throw new Error('preHandler did not set req.chat');
      const query = req.query as ListMessagesQuery;
      return messageService.list({
        sessionId: req.chat.sessionId,
        before: query.before,
        limit: query.limit,
      });
    },
  );

  // ── POST /v1/chat/messages ─────────────────────────────────────────
  app.post(
    '/v1/chat/messages',
    {
      preHandler: app.verifyChatAuth,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.chat?.sessionId ?? req.ip ?? 'unknown',
        },
      },
      schema: {
        body: chatSendMessageRequestSchema,
        response: { 200: messageSchema },
      },
    },
    async (req) => {
      if (!req.chat) throw new Error('preHandler did not set req.chat');
      const body = req.body as SendMessageRequest;
      return messageService.send(
        {
          sessionId: req.chat.sessionId,
          senderType: 'client',
          senderId: null,
          content: body.content,
          clientMessageId: body.clientMessageId,
        },
        { requestId: req.id, instance: req.url },
      );
    },
  );
};

export default chatRoutes;
