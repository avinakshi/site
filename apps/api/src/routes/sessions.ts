import type { FastifyPluginAsync } from 'fastify';
import {
  closeSessionRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  listMessagesQuerySchema,
  listMessagesResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  messageSchema,
  sendMessageRequestSchema,
  sessionDetailSchema,
  sessionIdParamSchema,
  sessionSchema,
  updateSessionRequestSchema,
  type CloseSessionRequest,
  type CreateSessionRequest,
  type ListMessagesQuery,
  type ListSessionsQuery,
  type SendMessageRequest,
  type SessionIdParam,
  type UpdateSessionRequest,
} from '@csm-chat/shared';
import type { ClientService } from '../services/client.service.js';
import type { MessageService } from '../services/message.service.js';
import type { SessionService } from '../services/session.service.js';

export interface SessionsRoutesOptions {
  clientService: ClientService;
  sessionService: SessionService;
  messageService: MessageService;
}

const sessionsRoutes: FastifyPluginAsync<SessionsRoutesOptions> = async (app, opts) => {
  const { clientService, sessionService, messageService } = opts;

  // ── POST /v1/sessions ───────────────────────────────────────────────
  app.post(
    '/v1/sessions',
    {
      preHandler: app.verifyAuth,
      schema: {
        body: createSessionRequestSchema,
        response: { 201: createSessionResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) throw new Error('preHandler did not set req.user');
      const body = req.body as CreateSessionRequest;
      const ctx = { requestId: req.id, instance: req.url };

      const client = await clientService.findOrCreateByEmail({
        email: body.clientEmail,
        name: body.clientName,
        company: body.clientCompany,
      });

      const result = await sessionService.create(
        {
          clientId: client.id,
          assignedCsmId: body.assignedCsmId ?? null,
          createdByUserId: req.user.id,
          expiresInDays: body.expiresInDays,
          metadata: body.metadata,
        },
        ctx,
      );
      reply.status(201);
      return result;
    },
  );

  // ── GET /v1/sessions ────────────────────────────────────────────────
  app.get(
    '/v1/sessions',
    {
      preHandler: app.verifyAuth,
      schema: {
        querystring: listSessionsQuerySchema,
        response: { 200: listSessionsResponseSchema },
      },
    },
    async (req) => {
      const query = req.query as ListSessionsQuery;
      return sessionService.list(query, { requestId: req.id, instance: req.url });
    },
  );

  // ── GET /v1/sessions/:sessionId ─────────────────────────────────────
  app.get(
    '/v1/sessions/:sessionId',
    {
      preHandler: app.verifyAuth,
      schema: {
        params: sessionIdParamSchema,
        response: { 200: sessionDetailSchema },
      },
    },
    async (req) => {
      const { sessionId } = req.params as SessionIdParam;
      return sessionService.getById(sessionId, { requestId: req.id, instance: req.url });
    },
  );

  // ── PATCH /v1/sessions/:sessionId ───────────────────────────────────
  app.patch(
    '/v1/sessions/:sessionId',
    {
      preHandler: app.verifyAuth,
      schema: {
        params: sessionIdParamSchema,
        body: updateSessionRequestSchema,
        response: { 200: sessionSchema },
      },
    },
    async (req) => {
      const { sessionId } = req.params as SessionIdParam;
      const body = req.body as UpdateSessionRequest;
      return sessionService.update(sessionId, body, { requestId: req.id, instance: req.url });
    },
  );

  // ── POST /v1/sessions/:sessionId/close ──────────────────────────────
  app.post(
    '/v1/sessions/:sessionId/close',
    {
      preHandler: app.verifyAuth,
      schema: {
        params: sessionIdParamSchema,
        body: closeSessionRequestSchema,
        response: { 200: sessionSchema },
      },
    },
    async (req) => {
      if (!req.user) throw new Error('preHandler did not set req.user');
      const { sessionId } = req.params as SessionIdParam;
      const body = req.body as CloseSessionRequest;
      return sessionService.close(sessionId, body.reason, req.user.id, {
        requestId: req.id,
        instance: req.url,
      });
    },
  );

  // ── GET /v1/sessions/:sessionId/messages — CSM message history ──────
  app.get(
    '/v1/sessions/:sessionId/messages',
    {
      preHandler: app.verifyAuth,
      schema: {
        params: sessionIdParamSchema,
        querystring: listMessagesQuerySchema,
        response: { 200: listMessagesResponseSchema },
      },
    },
    async (req) => {
      const { sessionId } = req.params as SessionIdParam;
      const query = req.query as ListMessagesQuery;
      return messageService.list({
        sessionId,
        before: query.before,
        limit: query.limit,
      });
    },
  );

  // ── POST /v1/sessions/:sessionId/messages — CSM message send ────────
  app.post(
    '/v1/sessions/:sessionId/messages',
    {
      preHandler: app.verifyAuth,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
        },
      },
      schema: {
        params: sessionIdParamSchema,
        body: sendMessageRequestSchema,
        response: { 200: messageSchema },
      },
    },
    async (req) => {
      if (!req.user) throw new Error('preHandler did not set req.user');
      const { sessionId } = req.params as SessionIdParam;
      const body = req.body as SendMessageRequest;
      return messageService.send(
        {
          sessionId,
          senderType: 'csm',
          senderId: req.user.id,
          content: body.content,
          clientMessageId: body.clientMessageId,
        },
        { requestId: req.id, instance: req.url },
      );
    },
  );
};

export default sessionsRoutes;
