import { auditLog, type Database } from '@csm-chat/db';

export type ActorType = 'user' | 'client' | 'system';

export interface AuditEvent {
  /** Dotted action name, e.g. 'auth.login.succeeded'. */
  action: string;
  actorType: ActorType;
  actorId?: string | null;
  /** Logical resource type the action applied to (e.g. 'user', 'session'). */
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId: string;
}

export interface AuditService {
  /** Persist a single audit event. Failures are logged but never throw. */
  record(event: AuditEvent): Promise<void>;
}

export interface AuditDeps {
  db: Database;
  /**
   * Optional sink for write failures. Defaults to console.error so a broken
   * audit insert can't take down a request — but the operator can wire pino.
   */
  onError?: (err: unknown, event: AuditEvent) => void;
}

export function buildAuditService(deps: AuditDeps): AuditService {
  const onError =
    deps.onError ??
    ((err, event) => {
      console.error('audit-log write failed', { action: event.action, err });
    });

  return {
    async record(event) {
      try {
        await deps.db.insert(auditLog).values({
          actorType: event.actorType,
          actorId: event.actorId ?? null,
          action: event.action,
          targetType: event.targetType ?? null,
          targetId: event.targetId ?? null,
          metadata: event.metadata ?? {},
          ipAddress: event.ipAddress ?? null,
          userAgent: event.userAgent ?? null,
          requestId: event.requestId,
        });
      } catch (err) {
        onError(err, event);
      }
    },
  };
}
