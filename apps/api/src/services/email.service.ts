import { Resend } from 'resend';

/** Structural subset of Pino / FastifyBaseLogger we actually use. */
export interface MinimalLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export interface EmailDeps {
  apiKey: string | undefined;
  from: string;
  log: MinimalLogger;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailService {
  /** Resolves true when the email was accepted by Resend, false on failure or no-op. */
  send(input: SendEmailInput): Promise<boolean>;
  /** Whether the service is actually configured to send. */
  readonly enabled: boolean;
}

export function buildEmailService(deps: EmailDeps): EmailService {
  const { apiKey, from, log } = deps;

  if (!apiKey) {
    log.info('[email] RESEND_API_KEY not set — notifications will be no-ops');
    return {
      enabled: false,
      async send() {
        return false;
      },
    };
  }

  const resend = new Resend(apiKey);

  return {
    enabled: true,
    async send(input) {
      try {
        const res = await resend.emails.send({
          from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        if (res.error) {
          log.warn(
            { err: res.error, to: input.to, subject: input.subject },
            '[email] resend send returned error',
          );
          return false;
        }
        log.info({ to: input.to, subject: input.subject, id: res.data?.id }, '[email] sent');
        return true;
      } catch (err) {
        log.warn({ err, to: input.to, subject: input.subject }, '[email] resend threw');
        return false;
      }
    },
  };
}

// ─── Templates ────────────────────────────────────────────────────────

export interface ClientNotifyTemplateInput {
  clientName: string;
  csmName: string | null;
  preview: string;
  chatUrl: string;
}

export function renderClientNotify(input: ClientNotifyTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const fromLabel = input.csmName ?? 'Customer Success';
  const subject = `New message from ${fromLabel}`;
  const truncated = input.preview.length > 240 ? input.preview.slice(0, 237) + '…' : input.preview;
  const text = [
    `Hi ${input.clientName},`,
    '',
    `${fromLabel} sent you a message:`,
    '',
    `  "${truncated}"`,
    '',
    `Continue the conversation: ${input.chatUrl}`,
    '',
    '— CSM Chat',
  ].join('\n');
  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f5;margin:0;padding:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e4e4e7;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 8px 0;color:#71717a;font-size:13px;">New message from</p>
      <h2 style="margin:0 0 16px 0;font-size:18px;color:#18181b;">${escapeHtml(fromLabel)}</h2>
      <p style="margin:0 0 16px 0;color:#27272a;line-height:1.45;white-space:pre-wrap;">${escapeHtml(truncated)}</p>
      <p style="margin:24px 0 0 0;">
        <a href="${input.chatUrl}" style="background:#18181b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-size:14px;">Open chat</a>
      </p>
      <p style="margin:24px 0 0 0;color:#a1a1aa;font-size:12px;">If the button doesn't work, copy this link:<br>${escapeHtml(input.chatUrl)}</p>
    </td></tr>
  </table>
</body></html>`.trim();
  return { subject, text, html };
}

export interface CsmNotifyTemplateInput {
  csmName: string;
  clientName: string;
  preview: string;
  dashboardUrl: string;
}

export function renderCsmNotify(input: CsmNotifyTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `New message from ${input.clientName}`;
  const truncated = input.preview.length > 240 ? input.preview.slice(0, 237) + '…' : input.preview;
  const text = [
    `Hi ${input.csmName},`,
    '',
    `${input.clientName} sent a new message:`,
    '',
    `  "${truncated}"`,
    '',
    `Reply: ${input.dashboardUrl}`,
    '',
    '— CSM Chat',
  ].join('\n');
  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f5;margin:0;padding:24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e4e4e7;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 8px 0;color:#71717a;font-size:13px;">New message from</p>
      <h2 style="margin:0 0 16px 0;font-size:18px;color:#18181b;">${escapeHtml(input.clientName)}</h2>
      <p style="margin:0 0 16px 0;color:#27272a;line-height:1.45;white-space:pre-wrap;">${escapeHtml(truncated)}</p>
      <p style="margin:24px 0 0 0;">
        <a href="${input.dashboardUrl}" style="background:#18181b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-size:14px;">Reply in dashboard</a>
      </p>
    </td></tr>
  </table>
</body></html>`.trim();
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
