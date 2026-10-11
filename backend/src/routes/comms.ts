import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.ts';
import { CUSTOMER_RATING_FIELDS, overallScore, TECHNICIAN_RATING_FIELDS } from '../domain/ratings.ts';
import { conflict, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { deliverMessage, postMessage } from '../services/chat.ts';
import { assertCustomer, assertParticipant, assertTechnician, getJob, logJobEvent } from '../services/jobs.ts';
import { refreshTechnicianRating } from '../services/ratings.ts';

export const comms = Router({ mergeParams: true });
comms.use(authenticate, requireUser());

const uuid = z.string().uuid();

/** Masked in-app chat (Section 8). `after` supports incremental polling and offline catch-up. */
comms.get('/messages', async (req, res) => {
  const job = await getJob(parse(uuid, req.params.id));
  assertParticipant(job, req.user!.id, req.user!.role);
  const q = parse(z.object({ after: z.coerce.date().optional() }), req.query);
  res.json(
    await query(
      `SELECT id, sender_id, body, channel, client_msg_id, redacted, created_at FROM chat_messages
        WHERE job_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2) ORDER BY created_at LIMIT 500`,
      [job.id, q.after ?? null],
    ),
  );
});

/** `clientMsgId` makes sends idempotent so the mobile offline queue can safely retry. */
comms.post('/messages', async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(4000), clientMsgId: z.string().min(8).max(64) }), req.body);
  const job = await getJob(parse(uuid, req.params.id));
  assertParticipant(job, req.user!.id, req.user!.role);
  if (['cancelled', 'declined', 'incomplete'].includes(job.status)) throw conflict('CLOSED', 'This conversation is closed');
  const msg = await tx((db) => postMessage(db, { job, senderId: req.user!.id, body: b.body, channel: 'app', clientMsgId: b.clientMsgId }));
  await deliverMessage(job, req.user!.id, msg.body);
  res.status(201).json(msg);
});

const TechRating = z.object({
  competence: z.number().int().min(1).max(5),
  punctuality: z.number().int().min(1).max(5),
  professionalism: z.number().int().min(1).max(5),
  courtesy: z.number().int().min(1).max(5),
  delivery_timeline: z.number().int().min(1).max(5),
  pricing_fairness: z.number().int().min(1).max(5),
  quality_of_work: z.number().int().min(1).max(5),
  review: z.string().trim().min(10).max(4000),
});

/**
 * Customer → technician (mandatory, Section 7). Only for completed, platform-paid jobs.
 * Submitting it lifts the new-booking block.
 */
comms.post('/rating', requireUser('customer'), async (req, res) => {
  const b = parse(TechRating, req.body);
  const result = await tx(async (db) => {
    const job = await getJob(parse(uuid, req.params.id), db, true);
    assertCustomer(job, req.user!.id);
    if (job.status !== 'completed') throw conflict('NOT_COMPLETED', 'You can rate a job once it is completed');
    const paid = await one(`SELECT 1 FROM payments WHERE job_id = $1 AND purpose = 'job' AND status = 'captured'`, [job.id], db);
    if (!paid) throw conflict('NOT_PLATFORM_PAID', 'Only jobs paid through Handiwork-Deck can be reviewed');
    const overall = overallScore(b, TECHNICIAN_RATING_FIELDS);
    const r = await one(
      `INSERT INTO technician_ratings (job_id, customer_id, technician_id, category_id, competence, punctuality, professionalism,
          courtesy, delivery_timeline, pricing_fairness, quality_of_work, overall, review_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [job.id, job.customer_id, job.technician_id, job.category_id, b.competence, b.punctuality, b.professionalism,
        b.courtesy, b.delivery_timeline, b.pricing_fairness, b.quality_of_work, overall, b.review],
      db,
    );
    await refreshTechnicianRating(db, job.technician_id);
    await logJobEvent(db, job.id, req.user!.id, 'rating.customer_to_technician', { overall });
    return r;
  });
  res.status(201).json(result);
});

/** Technician → customer agreement compliance (optional; visible to other technicians). */
comms.post('/customer-rating', requireUser('technician'), async (req, res) => {
  const b = parse(
    z.object({
      on_site_as_scheduled: z.number().int().min(1).max(5),
      granted_access: z.number().int().min(1).max(5),
      paid_through_platform: z.number().int().min(1).max(5),
      respectful_conduct: z.number().int().min(1).max(5),
      comment: z.string().trim().max(2000).optional(),
    }),
    req.body,
  );
  const r = await tx(async (db) => {
    const job = await getJob(parse(uuid, req.params.id), db, true);
    assertTechnician(job, req.user!.id);
    if (job.status !== 'completed') throw conflict('NOT_COMPLETED', 'You can rate a customer once the job is completed');
    const overall = overallScore(b, CUSTOMER_RATING_FIELDS);
    return one(
      `INSERT INTO customer_ratings (job_id, technician_id, customer_id, on_site_as_scheduled, granted_access, paid_through_platform,
          respectful_conduct, overall, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [job.id, job.technician_id, job.customer_id, b.on_site_as_scheduled, b.granted_access, b.paid_through_platform,
        b.respectful_conduct, overall, b.comment ?? null],
      db,
    );
  });
  res.status(201).json(r);
});
