import { eq } from 'drizzle-orm';
import { clients, sessions, users, type Database } from '@csm-chat/db';
import type { Message } from '@csm-chat/shared';
import type { Config } from '../config.js';
import type { MessageBroadcaster } from '../socket/broadcaster.js';
import {
  renderClientNotify,
  renderCsmNotify,
  type EmailService,
  type MinimalLogger,
} from './email.service.js';

export interface NotificationDeps {
  db: Database;
  config: Config;
  email: EmailService;
  broadcaster: MessageBroadcaster;
  log: MinimalLogger;
}

export interface NotificationService {
  /**
   * Decide whether the just-persisted message warrants an email and
   * send it. Fire-and-forget — never throws into the caller's path.
   */
  notifyForMessage(message: Message): Promise<void>;
}

/** Build the preview line shown in the email body. Falls back to a
 * sensible label when the message is an attachment (content === filename). */
function previewFor(message: Message): string {
  const meta = message.metadata as { attachment?: { filename?: string } } | null;
  if (meta?.attachment?.filename) return `📎 ${meta.attachment.filename}`;
  return message.content;
}

export function buildNotificationService(deps: NotificationDeps): NotificationService {
  const { db, config, email, broadcaster, log } = deps;
  const throttleMs = config.NOTIFICATION_THROTTLE_SEC * 1000;

  async function notifyClient(message: Message): Promise<void> {
    // Skip if a client socket is currently in the session room.
    if (await broadcaster.hasSideOnline(message.sessionId, 'client')) return;

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, message.sessionId))
      .limit(1);
    const session = sessionRows[0];
    if (!session) return;
    if (session.status === 'closed' || session.status === 'expired') return;
    if (!session.urlToken) {
      // Older sessions created before url_token was persisted — can't
      // build a valid chat URL from scratch, so skip silently.
      log.debug({ sessionId: session.id }, '[notify] no urlToken on session — skip client email');
      return;
    }

    const last = session.lastClientNotificationAt;
    if (last && Date.now() - last.getTime() < throttleMs) return;

    const clientRows = await db
      .select({ email: clients.email, name: clients.name })
      .from(clients)
      .where(eq(clients.id, session.clientId))
      .limit(1);
    const client = clientRows[0];
    if (!client?.email) return;

    let csmName: string | null = null;
    if (session.assignedCsmId) {
      const csmRows = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, session.assignedCsmId))
        .limit(1);
      csmName = csmRows[0]?.name ?? null;
    }

    const chatUrl = `${config.APP_BASE_URL.replace(/\/+$/, '')}/c/${session.urlToken}`;
    const tpl = renderClientNotify({
      clientName: client.name,
      csmName,
      preview: previewFor(message),
      chatUrl,
    });

    const sent = await email.send({ to: client.email, ...tpl });
    if (sent) {
      await db
        .update(sessions)
        .set({ lastClientNotificationAt: new Date() })
        .where(eq(sessions.id, session.id));
    }
  }

  async function notifyCsm(message: Message): Promise<void> {
    if (await broadcaster.hasSideOnline(message.sessionId, 'csm')) return;

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, message.sessionId))
      .limit(1);
    const session = sessionRows[0];
    if (!session) return;
    if (session.status === 'closed' || session.status === 'expired') return;

    const last = session.lastCsmNotificationAt;
    if (last && Date.now() - last.getTime() < throttleMs) return;

    // Prefer assigned CSM, fall back to whoever created the session.
    const targetUserId = session.assignedCsmId ?? session.createdByUserId;
    const userRows = await db
      .select({ email: users.email, name: users.name, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    const csm = userRows[0];
    if (!csm?.email || !csm.isActive) return;

    const clientRows = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, session.clientId))
      .limit(1);
    const clientName = clientRows[0]?.name ?? 'a client';

    const dashboardUrl = `${config.APP_BASE_URL.replace(/\/+$/, '')}/sessions/${session.id}`;
    const tpl = renderCsmNotify({
      csmName: csm.name,
      clientName,
      preview: previewFor(message),
      dashboardUrl,
    });

    const sent = await email.send({ to: csm.email, ...tpl });
    if (sent) {
      await db
        .update(sessions)
        .set({ lastCsmNotificationAt: new Date() })
        .where(eq(sessions.id, session.id));
    }
  }

  return {
    async notifyForMessage(message) {
      if (!email.enabled) return;
      try {
        if (message.senderType === 'csm') {
          await notifyClient(message);
        } else if (message.senderType === 'client') {
          await notifyCsm(message);
        }
      } catch (err) {
        log.warn({ err, messageId: message.id }, '[notify] dispatch failed');
      }
    },
  };
}
