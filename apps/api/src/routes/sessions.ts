import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
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
import type { AuditService } from '../services/audit.service.js';

export interface SessionsRoutesOptions {
  clientService: ClientService;
  sessionService: SessionService;
  messageService: MessageService;
  auditService: AuditService;
}

function reqMeta(req: FastifyRequest) {
  return {
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

const sessionsRoutes: FastifyPluginAsync<SessionsRoutesOptions> = async (app, opts) => {
  const { clientService, sessionService, messageService, auditService } = opts;

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
      await auditService.record({
        action: 'session.create',
        actorType: 'user',
        actorId: req.user.id,
        targetType: 'session',
        targetId: result.session.id,
        metadata: {
          clientId: client.id,
          assignedCsmId: result.session.assignedCsmId,
          expiresInDays: body.expiresInDays,
        },
        ...reqMeta(req),
      });
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
      const result = await sessionService.update(sessionId, body, {
        requestId: req.id,
        instance: req.url,
      });
      await auditService.record({
        action: 'session.update',
        actorType: 'user',
        actorId: req.user?.id ?? null,
        targetType: 'session',
        targetId: sessionId,
        metadata: { fields: Object.keys(body) },
        ...reqMeta(req),
      });
      return result;
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
      const closed = await sessionService.close(sessionId, body.reason, req.user.id, {
        requestId: req.id,
        instance: req.url,
      });
      await auditService.record({
        action: 'session.close',
        actorType: 'user',
        actorId: req.user.id,
        targetType: 'session',
        targetId: sessionId,
        metadata: body.reason ? { reason: body.reason } : {},
        ...reqMeta(req),
      });
      return closed;
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
