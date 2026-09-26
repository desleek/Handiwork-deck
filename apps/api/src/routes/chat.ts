import { maskContactInfo } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, pool, query } from '../db/pool';
import { badRequest, conflict, forbidden, HttpError } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { audit } from '../services/audit';
import { ensureConversation, isApproved } from '../services/messaging/conversations';
import { loadJobFor } from './jobs';

/**
 * Section 8: masked in-app chat is the primary channel — one thread per
 * (job, technician), fully logged for dispute evidence. Technicians are also
 * notified via the central WhatsApp number and their WhatsApp replies land in the
 * same thread. Until the job is approved, phone numbers / emails / chat links are
 * hidden, and real contact details are only released afterwards (GET /jobs/:id/contact).
 */
export const chatRouter = Router();

/** Resolves which technician's thread the caller means, and checks access. */
async function resolveThread(jobId: string, req: any, technicianIdParam?: string) {
  const user = currentUser(req);
  const job = await loadJobFor(jobId, user.id, user.role);
  let technicianId: string;
  if (user.role === 'technician') {
    technicianId = user.id;
  } else if (user.role === 'customer' && job.customer_id === user.id) {
    if (!technicianIdParam) throw badRequest('technicianId is required');
    technicianId = technicianIdParam;
    // Customers can only talk to technicians engaged with this job.
    const engaged =
      job.technician_id === technicianId ||
      job.target_technician_id === technicianId ||
      (await one('SELECT 1 FROM quotes WHERE job_id = $1 AND technician_id = $2', [jobId, technicianId])) ||
      (await one('SELECT 1 FROM conversations WHERE job_id = $1 AND technician_id = $2', [jobId, technicianId]));
    if (!engaged) throw forbidden('That technician is not engaged with this job');
  } else if (user.role === 'admin') {
    if (!technicianIdParam) throw badRequest('technicianId is required');
    technicianId = technicianIdParam;
  } else {
    throw forbidden();
  }
  return { job, technicianId, user };
}

chatRouter.get('/jobs/:id/conversations', authenticate, requireUser(), async (req, res) => {
  const user = currentUser(req);
  const job = await loadJobFor(parse(z.uuid(), req.params.id), user.id, user.role);
  const rows = await query(
    `SELECT c.id, c.technician_id, u.full_name AS technician_name, c.is_open, c.last_message_at,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM conversations c JOIN users u ON u.id = c.technician_id
      WHERE c.job_id = $1 AND ($2 OR c.technician_id = $3)
      ORDER BY c.last_message_at DESC`,
    [job.id, job.customer_id === user.id || user.role === 'admin', user.id],
  );
  res.json({ conversations: rows });
});

chatRouter.get('/jobs/:id/messages', authenticate, requireUser(), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const { technicianId } = parse(z.object({ technicianId: z.uuid().optional() }), req.query);
  const { job, technicianId: tid, user } = await resolveThread(jobId, req, technicianId);
  const convo = await one('SELECT id, is_open FROM conversations WHERE job_id = $1 AND technician_id = $2', [jobId, tid]);
  const messages = convo
    ? await query(
        `SELECT id, sender_id, body, channel, masked, created_at, (sender_id = $2) AS mine
           FROM messages WHERE conversation_id = $1 ORDER BY created_at LIMIT 500`,
        [convo.id, user.id],
      )
    : [];
  res.json({ messages, isOpen: convo?.is_open ?? true, contactUnlocked: isApproved(job, tid) });
});

const MessageBody = z.object({ body: z.string().trim().min(1).max(2000), technicianId: z.uuid().optional() });

chatRouter.post('/jobs/:id/messages', authenticate, requireUser('customer', 'technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(MessageBody, req.body);
  const { job, technicianId, user } = await resolveThread(jobId, req, b.technicianId);
  if (['cancelled', 'paid'].includes(job.status)) throw conflict('This conversation is closed');

  const convo = await ensureConversation(pool, jobId, job.customer_id, technicianId);
  if (!convo?.is_open) throw conflict('This conversation is closed');
  const { text, masked } = isApproved(job, technicianId) ? { text: b.body, masked: false } : maskContactInfo(b.body);
  const message = await one(
    `INSERT INTO messages (conversation_id, sender_id, body, original_body, channel, masked) VALUES ($1, $2, $3, $4, 'app', $5)
     RETURNING id, sender_id, body, channel, masked, created_at`,
    [convo.id, user.id, text, b.body, masked],
  );
  await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [convo.id]);
  const toTechnician = user.id !== technicianId;
  await scheduler().notify(toTechnician ? technicianId : job.customer_id, {
    title: toTechnician ? `Customer message` : `Message about #${job.ref}`,
    body: text.slice(0, 500),
    data: { jobId, jobRef: job.ref, type: 'chat.message', technicianId },
    // Technicians also get it on WhatsApp from the platform number (never the customer's).
    whatsapp: toTechnician,
  });
  res.status(201).json({ message: { ...message, mine: true } });
});

/**
 * Real contact details, released to both parties only once the job is approved
 * (a quote accepted). Every release is written to the job's audit trail.
 */
chatRouter.get('/jobs/:id/contact', authenticate, requireUser('customer', 'technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const user = currentUser(req);
  const job = await loadJobFor(jobId, user.id, user.role);
  const isParty = job.customer_id === user.id || job.technician_id === user.id;
  if (!isParty || !job.technician_id || !isApproved(job, job.technician_id) || job.status === 'cancelled') {
    throw new HttpError(403, 'Contact details are shared once the job is approved', 'contact_locked');
  }
  const otherId = user.id === job.customer_id ? job.technician_id : job.customer_id;
  const other = await one('SELECT full_name, phone_e164 FROM users WHERE id = $1', [otherId]);
  await audit(jobId, user.id, 'contact.released', { to: user.role });
  res.json({ contact: { name: other.full_name, phone: other.phone_e164 } });
});
