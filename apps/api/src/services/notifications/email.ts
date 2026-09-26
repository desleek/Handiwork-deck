import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailClient {
  send(msg: EmailMessage): Promise<void>;
}

class SendGridClient implements EmailClient {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(msg: EmailMessage) {
    const m = /^(.*)<(.+)>$/.exec(this.from.trim());
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: m ? { name: m[1]!.trim(), email: m[2]!.trim() } : { email: this.from },
        subject: msg.subject,
        content: [{ type: 'text/plain', value: msg.text }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid send failed: ${res.status}`);
  }
}

/** Logs instead of sending; the default in development and tests. */
export class LoggingEmailClient implements EmailClient {
  public readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
    logger.info({ to: msg.to, subject: msg.subject }, 'email (dry-run)');
  }
}

let client: EmailClient | undefined;
export function email(): EmailClient {
  client ??= env.EMAIL_PROVIDER === 'sendgrid' && env.SENDGRID_API_KEY ? new SendGridClient(env.SENDGRID_API_KEY, env.EMAIL_FROM) : new LoggingEmailClient();
  return client;
}
export function setEmailClient(c: EmailClient) {
  client = c;
}
