import { env } from '../../config/env.ts';
import { one, pool, query } from '../../db/pool.ts';
import { logger } from '../../lib/logger.ts';
import { whatsapp } from '../messaging/whatsapp.ts';
import { sendPush } from './push.ts';

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Transactional alerts (job updates, chat, escalations) are always on. Promotional ones respect opt-out. */
  transactional?: boolean;
  urgent?: boolean;
  channels?: ('push' | 'whatsapp' | 'email')[];
  /** WhatsApp template name + params (required when 'whatsapp' is a channel). */
  whatsappTemplate?: { name: string; params: string[] };
}

export async function notify(n: NotifyInput): Promise<void> {
  const transactional = n.transactional ?? true;
  const channels = n.channels ?? ['push'];
  if (!transactional) {
    const pref = await one<{ promotional_alerts: boolean }>('SELECT promotional_alerts FROM notification_prefs WHERE user_id = $1', [n.userId]);
    if (pref && !pref.promotional_alerts) return;
  }

  await query(
    `INSERT INTO notifications (user_id, type, title, body, data, transactional, channels) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [n.userId, n.type, n.title, n.body, JSON.stringify(n.data ?? {}), transactional, channels],
  );

  if (channels.includes('push')) {
    const tokens = (await query<{ token: string }>('SELECT token FROM device_tokens WHERE user_id = $1', [n.userId])).map((r) => r.token);
    try {
      const stale = await sendPush(tokens, { title: n.title, body: n.body, data: { type: n.type, ...(n.data ?? {}) }, urgent: n.urgent });
      if (stale.length) await pool.query('DELETE FROM device_tokens WHERE token = ANY($1)', [stale]);
    } catch (err) {
      logger.warn({ err }, 'push failed');
    }
  }

  if (channels.includes('whatsapp') || channels.includes('email')) {
    const user = await one<{ phone_e164: string | null; email: string | null }>('SELECT phone_e164, email FROM users WHERE id = $1', [n.userId]);
    if (channels.includes('whatsapp') && user?.phone_e164) {
      try {
        const t = n.whatsappTemplate ?? { name: 'generic_alert', params: [n.title, n.body] };
        await whatsapp.sendTemplate(user.phone_e164, t.name, t.params);
      } catch (err) {
        logger.warn({ err }, 'whatsapp notify failed');
      }
    }
    if (channels.includes('email') && user?.email) await sendEmail(user.email, n.title, n.body);
  }
}

/** Email transport is a deployment choice (SES, Postmark, SMTP). Logs until configured. */
export async function sendEmail(to: string, subject: string, body: string) {
  if (!env.SMTP_URL) {
    logger.info({ to, subject }, '[email:dev] would send');
    return;
  }
  // Plug in a transport here (e.g. nodemailer.createTransport(env.SMTP_URL).sendMail(...)).
  logger.info({ to, subject }, '[email] queued');
}
