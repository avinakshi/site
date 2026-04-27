import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { sessions, type Database } from '@csm-chat/db';
import { createProblem, messageSchema } from '@csm-chat/shared';
import type { Config } from '../config.js';
import {
  isExpiredJwt,
  verifyAccessToken,
  verifySessionJwt,
} from '../lib/jwt.js';
import type { AttachmentService } from '../services/attachment.service.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_WHITELIST,
} from '../services/attachment.service.js';
import type { MessageService } from '../services/message.service.js';

export interface AttachmentsRoutesOptions {
  db: Database;
  config: Config;
  attachmentService: AttachmentService;
  messageService: MessageService;
}

interface DownloadAuth {
  sessionId: string | null; // null = full CSM access (any session)
}

const attachmentsRoutes: FastifyPluginAsync<AttachmentsRoutesOptions> = async (app, opts) => {
  const { db, config, attachmentService, messageService } = opts;

  /**
   * Resolve who's asking for these bytes. Accepts either a CSM access
   * token (full read) or a chat session JWT (limited to the matching
   * session). Used only by GET /v1/attachments/:id.
   */
  async function resolveDownloadAuth(req: FastifyRequest): Promise<DownloadAuth> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw createProblem('UNAUTHENTICATED', { requestId: req.id, instance: req.url });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw createProblem('UNAUTHENTICATED', { requestId: req.id, instance: req.url });
    }

    // Try CSM access token first (most common in dashboard usage).
    try {
      await verifyAccessToken(token, config.JWT_ACCESS_SECRET);
      return { sessionId: null };
    } catch (csmErr) {
      // Fall through to session JWT below — but if the failure was
      // expiry, surface that immediately so the client refreshes.
      if (isExpiredJwt(csmErr)) {
        // Could still be a valid session JWT; try that path too.
      }
    }

    try {
      const payload = await verifySessionJwt(token, config.SESSION_JWT_SECRET);
      return { sessionId: payload.sub };
    } catch (chatErr) {
      throw createProblem(isExpiredJwt(chatErr) ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', {
        requestId: req.id,
        instance: req.url,
      });
    }
  }

  // ── POST /v1/sessions/:sessionId/attachments — CSM upload ─────────
  app.post(
    '/v1/sessions/:sessionId/attachments',
    {
      preHandler: app.verifyAuth,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
        },
      },
      schema: {
        response: { 200: messageSchema },
      },
    },
    async (req) => {
      if (!req.user) throw new Error('preHandler did not set req.user');
      const { sessionId } = req.params as { sessionId: string };
      const ctx = { requestId: req.id, instance: req.url };

      // Verify the session exists and is open.
      const sessionRows = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        throw createProblem('NOT_FOUND', { ...ctx, detail: 'Session not found.' });
      }
      if (
        session.status !== 'active' &&
        session.status !== 'pending' &&
        session.status !== 'csm_handling'
      ) {
        throw createProblem('SESSION_CLOSED', {
          ...ctx,
          detail: 'Cannot attach to a closed or expired session.',
        });
      }

      const file = await req.file({ limits: { fileSize: ATTACHMENT_MAX_BYTES } });
      if (!file) {
        throw createProblem('VALIDATION_ERROR', {
          ...ctx,
          detail: 'No file in multipart body.',
        });
      }
      if (!ATTACHMENT_MIME_WHITELIST.has(file.mimetype)) {
        throw createProblem('VALIDATION_ERROR', {
          ...ctx,
          detail: `Mime type not allowed: ${file.mimetype}`,
        });
      }
      const buffer = await file.toBuffer();
      // toBuffer throws on truncation but be paranoid.
      if (buffer.byteLength > ATTACHMENT_MAX_BYTES) {
        throw createProblem('VALIDATION_ERROR', {
          ...ctx,
          detail: 'File exceeds size limit.',
        });
      }

      const meta = await attachmentService.save(
        {
          sessionId,
          filename: file.filename || 'file',
          mimeType: file.mimetype,
          data: buffer,
          uploadedByUserId: req.user.id,
        },
        ctx,
      );

      // The associated message carries the attachment ref in metadata.
      // Content is set to the filename so older clients (no attachment
      // renderer) still see something readable.
      return messageService.send(
        {
          sessionId,
          senderType: 'csm',
          senderId: req.user.id,
          content: meta.filename,
          clientMessageId: randomUUID(),
          metadata: {
            attachment: {
              id: meta.id,
              filename: meta.filename,
              mimeType: meta.mimeType,
              sizeBytes: meta.sizeBytes,
            },
          },
        },
        ctx,
      );
    },
  );

  // ── POST /v1/chat/attachments — client-side upload (chat session JWT) ──
  app.post(
    '/v1/chat/attachments',
    {
      preHandler: app.verifyChatAuth,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.chat?.sessionId ?? req.ip ?? 'unknown',
        },
      },
      schema: {
        response: { 200: messageSchema },
      },
    },
    async (req) => {
      if (!req.chat) throw new Error('preHandler did not set req.chat');
      const sessionId = req.chat.sessionId;
      const ctx = { requestId: req.id, instance: req.url };

      const sessionRows = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        throw createProblem('NOT_FOUND', { ...ctx, detail: 'Session not found.' });
      }
      if (
        session.status !== 'active' &&
        session.status !== 'pending' &&
        session.status !== 'csm_handling'
      ) {
        throw createProblem('SESSION_CLOSED', {
          ...ctx,
          detail: 'Cannot attach to a closed or expired session.',
        });
      }

      const file = await req.file({ limits: { fileSize: ATTACHMENT_MAX_BYTES } });
      if (!file) {
        throw createProblem('VALIDATION_ERROR', {
          ...ctx,
          detail: 'No file in multipart body.',
        });
      }
      if (!ATTACHMENT_MIME_WHITELIST.has(file.mimetype)) {
        throw createProblem('VALIDATION_ERROR', {
          ...ctx,
          detail: `Mime type not allowed: ${file.mimetype}`,
        });
      }
      const buffer = await file.toBuffer();
      if (buffer.byteLength > ATTACHMENT_MAX_BYTES) {
        throw createProblem('VALIDATION_ERROR', {
          ...ctx,
          detail: 'File exceeds size limit.',
        });
      }

      const meta = await attachmentService.save(
        {
          sessionId,
          filename: file.filename || 'file',
          mimeType: file.mimetype,
          data: buffer,
          uploadedByUserId: null,
        },
        ctx,
      );

      return messageService.send(
        {
          sessionId,
          senderType: 'client',
          senderId: null,
          content: meta.filename,
          clientMessageId: randomUUID(),
          metadata: {
            attachment: {
              id: meta.id,
              filename: meta.filename,
              mimeType: meta.mimeType,
              sizeBytes: meta.sizeBytes,
            },
          },
        },
        ctx,
      );
    },
  );

  // ── GET /v1/attachments/:id — stream bytes (CSM or matching client) ──
  app.get('/v1/attachments/:id', async (req, reply) => {
    const auth = await resolveDownloadAuth(req);
    const { id } = req.params as { id: string };
    const att = await attachmentService.getBytes(id);
    if (!att) {
      throw createProblem('NOT_FOUND', { requestId: req.id, instance: req.url });
    }
    if (auth.sessionId !== null && auth.sessionId !== att.sessionId) {
      // Chat session JWT can only fetch its own session's files.
      throw createProblem('FORBIDDEN', { requestId: req.id, instance: req.url });
    }

    // Inline rendering for images/PDFs; download otherwise. Filename is
    // RFC 5987 encoded so non-ASCII names survive.
    const inline =
      att.mimeType.startsWith('image/') || att.mimeType === 'application/pdf';
    const dispositionType = inline ? 'inline' : 'attachment';
    const safeName = encodeURIComponent(att.filename);

    return reply
      .header('Content-Type', att.mimeType)
      .header('Content-Length', String(att.sizeBytes))
      .header(
        'Content-Disposition',
        `${dispositionType}; filename*=UTF-8''${safeName}`,
      )
      .header('Cache-Control', 'private, max-age=3600')
      .send(att.data);
  });
};

export default attachmentsRoutes;
