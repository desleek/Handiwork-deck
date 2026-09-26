import { maskContactInfo } from '@handiwork/shared';
import { one, query } from '../../db/pool';
import { isApproved } from './conversations';
import { jobs } from '../../queues/index';
import { type InboundWhatsAppMessage, parseJobRef, whatsapp } from './whatsapp';

export type RelayOutcome =
  | { status: 'relayed'; conversationId: string; toUserId: string }
  | { status: 'duplicate' }
  | { status: 'unknown_sender' }
  | { status: 'customer_use_app' }
  | { status: 'no_conversation' }
  | { status: 'ambiguous'; refs: string[] };

interface ConversationRow {
  id: string;
  job_id: string;
  job_status: string;
  job_technician_id: string | null;
  job_ref: string;
  job_title: string;
  customer_id: string;
  technician_id: string;
  customer_name: string;
  technician_name: string;
}

/**
 * Section 8: routes a technician's WhatsApp reply (to the central platform number)
 * into the job's in-app chat thread. The customer is notified in the app; their
 * phone number is never involved.
 *
 * Conversation selection: a leading `#HW-XXXXX` job ref wins; otherwise the
 * technician's only open conversation; with several we ask them to add the ref.
 */
export async function relayInbound(msg: InboundWhatsAppMessage): Promise<RelayOutcome> {
  const sender = await one<{ id: string; full_name: string; role: string }>(
    'SELECT id, full_name, role FROM users WHERE phone_e164 = $1 AND is_active',
    [msg.fromE164],
  );
  if (!sender) {
    await whatsapp().sendText(
      msg.fromE164,
      "Hi! This number sends HANDIWORK-DECK job updates to technicians. We couldn't find a technician account for your number.",
    );
    return { status: 'unknown_sender' };
  }
  // Section 8: WhatsApp is the technicians' fallback channel only; customers use the in-app chat.
  if (sender.role !== 'technician') {
    await whatsapp().sendText(msg.fromE164, 'Please message your technician in the HANDIWORK-DECK app chat — it keeps a record for both of you.');
    return { status: 'customer_use_app' };
  }

  const { ref, body } = parseJobRef(msg.text);
  const conversations = await query<ConversationRow>(
    `SELECT c.id, j.status AS job_status, j.technician_id AS job_technician_id, j.ref AS job_ref, j.title AS job_title, j.id AS job_id,
            c.customer_id, c.technician_id, cu.full_name AS customer_name, te.full_name AS technician_name
       FROM conversations c
       JOIN jobs j ON j.id = c.job_id
       JOIN users cu ON cu.id = c.customer_id
       JOIN users te ON te.id = c.technician_id
      WHERE c.is_open AND c.technician_id = $1 AND ($2::text IS NULL OR j.ref = $2)
      ORDER BY c.last_message_at DESC`,
    [sender.id, ref ?? null],
  );

  if (conversations.length === 0) {
    await whatsapp().sendText(msg.fromE164, ref ? `We couldn't find an open conversation for job ${ref}.` : 'You have no open job conversations right now.');
    return { status: 'no_conversation' };
  }
  if (conversations.length > 1) {
    const refs = conversations.map((c) => c.job_ref);
    await whatsapp().sendText(
      msg.fromE164,
      `You have several open conversations. Start your message with the job reference, e.g. "#${refs[0]} On my way".\n${conversations
        .map((c) => `#${c.job_ref} — ${c.job_title}`)
        .join('\n')}`,
    );
    return { status: 'ambiguous', refs };
  }

  const convo = conversations[0]!;
  // No real contact details are exchanged before the job is approved.
  const { text: safeBody, masked } = isApproved({ status: convo.job_status, technician_id: convo.job_technician_id }, convo.technician_id)
    ? { text: body, masked: false }
    : maskContactInfo(body);
  // Idempotent on the WhatsApp message id: Meta retries webhooks.
  const inserted = await one<{ id: number }>(
    `INSERT INTO messages (conversation_id, sender_id, body, original_body, wa_inbound_id, channel, masked)
     VALUES ($1, $2, $3, $4, $5, 'whatsapp', $6) ON CONFLICT (wa_inbound_id) DO NOTHING RETURNING id`,
    [convo.id, sender.id, safeBody, body, msg.waMessageId, masked],
  );
  if (!inserted) return { status: 'duplicate' };
  await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [convo.id]);
  // The reply lands in the in-app thread; the customer is notified in the app, never on WhatsApp.
  await jobs().notify(convo.customer_id, {
    title: `${firstName(convo.technician_name)} replied`,
    body: safeBody.slice(0, 500),
    data: { jobId: convo.job_id, type: 'chat.message', technicianId: convo.technician_id },
  });
  return { status: 'relayed', conversationId: convo.id, toUserId: convo.customer_id };
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
