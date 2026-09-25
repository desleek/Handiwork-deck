import { maskContactInfo } from '@handiwork/shared';
import { one, query } from '../../db/pool';
import { isApproved } from './conversations';
import { logger } from '../../lib/logger';
import { type InboundWhatsAppMessage, parseJobRef, whatsapp } from './whatsapp';

export type RelayOutcome =
  | { status: 'relayed'; conversationId: string; toUserId: string }
  | { status: 'duplicate' }
  | { status: 'unknown_sender' }
  | { status: 'no_conversation' }
  | { status: 'ambiguous'; refs: string[] };

interface ConversationRow {
  id: string;
  job_status: string;
  job_technician_id: string | null;
  job_ref: string;
  job_title: string;
  customer_id: string;
  technician_id: string;
  customer_name: string;
  technician_name: string;
  customer_phone: string | null;
  technician_phone: string | null;
}

/**
 * Relays an inbound WhatsApp message from one party of a job to the other via the
 * platform number. Neither party ever sees the other's phone number.
 *
 * Conversation selection: a leading `#HW-XXXXX` job ref wins; otherwise the sender's
 * only open conversation is used; with several open conversations we ask them to
 * prefix the job ref.
 */
export async function relayInbound(msg: InboundWhatsAppMessage): Promise<RelayOutcome> {
  const sender = await one<{ id: string; full_name: string }>(
    'SELECT id, full_name FROM users WHERE phone_e164 = $1 AND is_active',
    [msg.fromE164],
  );
  if (!sender) {
    await whatsapp().sendText(
      msg.fromE164,
      "Hi! This number relays messages for HANDIWORK-DECK jobs. We couldn't find an account for your number — please sign up in the app.",
    );
    return { status: 'unknown_sender' };
  }

  const { ref, body } = parseJobRef(msg.text);
  const conversations = await query<ConversationRow>(
    `SELECT c.id, j.status AS job_status, j.technician_id AS job_technician_id, j.ref AS job_ref, j.title AS job_title, c.customer_id, c.technician_id,
            cu.full_name AS customer_name, te.full_name AS technician_name,
            cu.phone_e164 AS customer_phone, te.phone_e164 AS technician_phone
       FROM conversations c
       JOIN jobs j ON j.id = c.job_id
       JOIN users cu ON cu.id = c.customer_id
       JOIN users te ON te.id = c.technician_id
      WHERE c.is_open AND (c.customer_id = $1 OR c.technician_id = $1)
        AND ($2::text IS NULL OR j.ref = $2)
      ORDER BY c.last_message_at DESC`,
    [sender.id, ref ?? null],
  );
  // A customer can have several threads on one job (one per technician who quoted).
  // Over WhatsApp we route to the hired technician; otherwise they must use the app.
  const byJob = new Map<string, ConversationRow[]>();
  for (const c of conversations) byJob.set(c.job_ref, [...(byJob.get(c.job_ref) ?? []), c]);
  for (const [jobRef, list] of byJob) {
    if (list.length > 1) {
      const hired = list.filter((c) => c.job_technician_id === c.technician_id);
      byJob.set(jobRef, hired.length ? hired : list.slice(0, 0));
      if (!hired.length && ref === jobRef) {
        await whatsapp().sendText(
          msg.fromE164,
          `Several technicians are quoting on #${jobRef}. Please reply to them in the HANDIWORK-DECK app until you approve a quote.`,
        );
        return { status: 'ambiguous', refs: [jobRef] };
      }
    }
  }
  conversations.splice(0, conversations.length, ...[...byJob.values()].flat());

  if (conversations.length === 0) {
    await whatsapp().sendText(
      msg.fromE164,
      ref ? `We couldn't find an open job ${ref} on your account.` : 'You have no active jobs to message about right now.',
    );
    return { status: 'no_conversation' };
  }
  if (conversations.length > 1) {
    const refs = conversations.map((c) => c.job_ref);
    await whatsapp().sendText(
      msg.fromE164,
      `You have several active jobs. Start your message with the job reference, e.g. "#${refs[0]} On my way".\n${conversations
        .map((c) => `#${c.job_ref} — ${c.job_title}`)
        .join('\n')}`,
    );
    return { status: 'ambiguous', refs };
  }

  const convo = conversations[0]!;
  // No real contact details are exchanged before the customer approves this technician.
  const { text: safeBody, masked } = isApproved({ status: convo.job_status, technician_id: convo.job_technician_id }, convo.technician_id)
    ? { text: body, masked: false }
    : maskContactInfo(body);
  // Idempotent on the WhatsApp message id: Meta retries webhooks.
  const inserted = await one<{ id: number }>(
    `INSERT INTO messages (conversation_id, sender_id, body, wa_inbound_id, channel, masked)
     VALUES ($1, $2, $3, $4, 'whatsapp', $5) ON CONFLICT (wa_inbound_id) DO NOTHING RETURNING id`,
    [convo.id, sender.id, safeBody, msg.waMessageId, masked],
  );
  if (!inserted) return { status: 'duplicate' };

  const senderIsCustomer = convo.customer_id === sender.id;
  const toUserId = senderIsCustomer ? convo.technician_id : convo.customer_id;
  const toPhone = senderIsCustomer ? convo.technician_phone : convo.customer_phone;
  const label = senderIsCustomer ? `Customer (${firstName(convo.customer_name)})` : `Technician (${firstName(convo.technician_name)})`;

  await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [convo.id]);
  if (!toPhone) {
    logger.warn({ conversationId: convo.id, toUserId }, 'relay recipient has no phone number; stored only');
    return { status: 'relayed', conversationId: convo.id, toUserId };
  }
  const sent = await whatsapp().sendText(toPhone, `[#${convo.job_ref}] ${label}: ${safeBody}`);
  if (sent.messageId) {
    await query('UPDATE messages SET wa_outbound_id = $1 WHERE id = $2', [sent.messageId, inserted.id]);
  }
  return { status: 'relayed', conversationId: convo.id, toUserId };
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
