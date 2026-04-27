import { eq } from 'drizzle-orm';
import { attachments, type Database } from '@csm-chat/db';
import { createProblem } from '@csm-chat/shared';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * MIME whitelist. Keep tight on purpose — bytes go straight to the
 * client browser via Content-Type, so anything HTML-ish would let an
 * uploader smuggle XSS into a chat by tricking a CSM into uploading.
 */
export const ATTACHMENT_MIME_WHITELIST = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export interface AttachmentMeta {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AttachmentBytes extends AttachmentMeta {
  data: Buffer;
}

export interface SaveInput {
  sessionId: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedByUserId: string | null;
}

export interface AttachmentService {
  save(input: SaveInput, ctx: { requestId: string; instance?: string }): Promise<AttachmentMeta>;
  /** Fetch metadata only — used to authorize before streaming bytes. */
  getMeta(id: string): Promise<AttachmentMeta | null>;
  /** Fetch metadata + bytes for streaming. */
  getBytes(id: string): Promise<AttachmentBytes | null>;
}

export function buildAttachmentService(deps: { db: Database }): AttachmentService {
  const { db } = deps;

  return {
    async save(input, ctx) {
      if (input.data.byteLength > ATTACHMENT_MAX_BYTES) {
        throw createProblem('VALIDATION_ERROR', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: `File exceeds ${ATTACHMENT_MAX_BYTES} bytes.`,
          errors: [{ field: 'file', message: 'too_large' }],
        });
      }
      if (!ATTACHMENT_MIME_WHITELIST.has(input.mimeType)) {
        throw createProblem('VALIDATION_ERROR', {
          requestId: ctx.requestId,
          instance: ctx.instance,
          detail: `Mime type not allowed: ${input.mimeType}`,
          errors: [{ field: 'file', message: 'mime_not_allowed' }],
        });
      }

      const inserted = await db
        .insert(attachments)
        .values({
          sessionId: input.sessionId,
          filename: input.filename.slice(0, 255),
          mimeType: input.mimeType,
          sizeBytes: input.data.byteLength,
          data: input.data,
          uploadedByUserId: input.uploadedByUserId,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('attachment insert returned no rows');
      return {
        id: row.id,
        sessionId: row.sessionId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt.toISOString(),
      };
    },

    async getMeta(id) {
      const rows = await db
        .select({
          id: attachments.id,
          sessionId: attachments.sessionId,
          filename: attachments.filename,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
          createdAt: attachments.createdAt,
        })
        .from(attachments)
        .where(eq(attachments.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        sessionId: row.sessionId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt.toISOString(),
      };
    },

    async getBytes(id) {
      const rows = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        sessionId: row.sessionId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt.toISOString(),
        data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as Uint8Array),
      };
    },
  };
}
