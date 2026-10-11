import { one, query, type Db } from '../db/pool.ts';
import { redactContactDetails, shouldRedact } from '../domain/privacy.ts';
import { logger } from '../lib/logger.ts';
import { getJob, type JobRow } from './jobs.ts';
import { whatsapp } from './messaging/whatsapp.ts';
import { notify } from './notifications/notify.ts';

/**
 * Masked chat (Section 8). In-app chat is primary and fully logged. Messages to the technician
 * are also relayed through the platform's central WhatsApp number; the technician never sees
 * the customer's number, and their WhatsApp replies are routed back into the same thread.
 */
export async function postMessage(
  db: Db,
  p: { job: JobRow; senderId: string | null; body: string; channel: 'app' | 'whatsapp' | 'system'; clientMsgId?: string; externalId?: string },
) {
  const { text, redacted } = p.senderId && shouldRedact(p.job.status) ? redactContactDetails(p.body) : { text: p.body, redacted: false };
  const msg = await one(
    `INSERT INTO chat_messages (job_id, sender_id, body, channel, client_msg_id, external_id, redacted)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (sender_id, client_msg_id) DO UPDATE SET client_msg_id = EXCLUDED.client_msg_id
     RETURNING *`,
    [p.job.id, p.senderId, text, p.channel, p.clientMsgId ?? null, p.externalId ?? null, redacted],
    db,
  );
  return msg;
}

/** Fan out a new message to the other party: push to both, plus WhatsApp relay to technicians. */
export async function deliverMessage(job: JobRow, senderId: string | null, body: string) {
  const recipients = [job.customer_id, job.technician_id].filter((id) => id !== senderId);
  for (const userId of recipients) {
    await notify({
      userId,
      type: 'chat.message',
      title: `Job #${job.short_code}`,
      body: body.length > 120 ? body.slice(0, 117) + '…' : body,
      data: { jobId: job.id },
    });
  }
  if (senderId !== job.technician_id) {
    const tech = await one<{ phone_e164: string | null }>('SELECT phone_e164 FROM users WHERE id = $1', [job.technician_id]);
    if (tech?.phone_e164) {
      try {
        // Template (not free text): works outside WhatsApp's 24h session window.
        await whatsapp.sendTemplate(tech.phone_e164, 'job_message_relay', [job.short_code, body.slice(0, 900)]);
        await query(
          `INSERT INTO whatsapp_relay_sessions (technician_id, job_id, last_outbound_at) VALUES ($1, $2, now())
           ON CONFLICT (technician_id) DO UPDATE SET job_id = EXCLUDED.job_id, last_outbound_at = now()`,
          [job.technician_id, job.id],
        );
      } catch (err) {
        logger.warn({ err }, 'whatsapp relay failed');
      }
    }
  }
}

/**
 * Inbound WhatsApp reply from a technician. "#HW7K2Q message" targets a specific job; otherwise the
 * reply goes to the job they were last messaged about.
 */
export async function routeInboundWhatsApp(db: Db, fromE164: string, text: string, externalId: string) {
  const tech = await one<{ id: string }>(
    `SELECT u.id FROM users u JOIN technician_profiles t ON t.user_id = u.id WHERE u.phone_e164 = $1 AND u.status <> 'deleted'`,
    [fromE164],
    db,
  );
  if (!tech) return { routed: false as const, reason: 'unknown_sender' as const };

  let jobId: string | undefined;
  let body = text.trim();
  const m = body.match(/^#(HW[A-Z0-9]{5})\b\s*/i);
  if (m) {
    const j = await one<{ id: string }>('SELECT id FROM jobs WHERE short_code = $1 AND technician_id = $2', [m[1].toUpperCase(), tech.id], db);
    jobId = j?.id;
    body = body.slice(m[0].length);
  } else {
    const s = await one<{ job_id: string }>('SELECT job_id FROM whatsapp_relay_sessions WHERE technician_id = $1', [tech.id], db);
    jobId = s?.job_id;
  }
  if (!jobId || !body) return { routed: false as const, reason: 'no_thread' as const };
  const job = await getJob(jobId, db);
  const msg = await postMessage(db, { job, senderId: tech.id, body, channel: 'whatsapp', externalId });
  return { routed: true as const, job, message: msg };
}
