import { CUSTOMER_RATING_CATEGORIES } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler, minutes } from '../queues/index';
import { audit } from '../services/audit';
import { invoiceFor } from '../services/jobs/invoice';
import { transitionJob } from '../services/jobs/lifecycle';
import { findMatchingTechnicians } from '../services/matching';
import { loadJobFor } from './jobs';

/** Section 4: technicians accept/decline booking requests; invoices, audit trail, customer ratings. */
export const jobRequestsRouter = Router();
const techOnly = [authenticate, requireUser('technician')];

async function openToMarketplace(job: any, note: string) {
  const matches = (await findMatchingTechnicians(job, Number(job.match_radius_km))).filter((t) => t.user_id !== job.declined_by);
  await Promise.all(matches.map((t) => scheduler().notify(t.user_id, { title: 'New job near you', body: job.title, data: { jobId: job.id, type: 'job.new' } })));
  await scheduler().notify(job.customer_id, { title: 'Finding you another technician', body: note, data: { jobId: job.id, type: 'job.reopened' } });
  // A fresh escalation round each time a job is reopened (BullMQ dedupes on job id).
  await scheduler().scheduleEscalation({ kind: 'no_quote_widen', jobId: job.id, round: Date.now() }, minutes(env.ESCALATE_NO_QUOTE_WIDEN_AFTER_MIN));
}

/** Accept a booking request addressed to me (the itemized quote follows). */
jobRequestsRouter.post('/jobs/:id/request/accept', ...techOnly, async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const tech = currentUser(req);
  const job = await one(
    `UPDATE jobs SET request_accepted_at = now()
      WHERE id = $1 AND target_technician_id = $2 AND booking_mode = 'request' AND status IN ('open', 'quoted') AND request_accepted_at IS NULL
      RETURNING *`,
    [jobId, tech.id],
  );
  if (!job) throw conflict('No open booking request for you on this job');
  await audit(jobId, tech.id, 'request.accepted');
  await scheduler().notify(job.customer_id, { title: 'Request accepted', body: `${tech.full_name} accepted your request and will send an itemized quote.`, data: { jobId, type: 'request.accepted' } });
  res.json({ job });
});

/** Decline a booking request: the job is released to the marketplace straight away. */
jobRequestsRouter.post('/jobs/:id/request/decline', ...techOnly, async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
  const tech = currentUser(req);
  const job = await tx(async (db) => {
    const job = await one(
      `UPDATE jobs SET booking_mode = 'open', target_technician_id = NULL, request_accepted_at = NULL
        WHERE id = $1 AND target_technician_id = $2 AND booking_mode = 'request' AND status IN ('open', 'quoted') RETURNING *`,
      [jobId, tech.id],
      db,
    );
    if (!job) throw conflict('No open booking request for you on this job');
    await db.query(`UPDATE quotes SET status = 'withdrawn' WHERE job_id = $1 AND technician_id = $2 AND status IN ('pending', 'pending_exception', 'countered')`, [jobId, tech.id]);
    await db.query('INSERT INTO job_dismissals (technician_id, job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tech.id, jobId]);
    await audit(jobId, tech.id, 'request.declined', { reason: reason ?? null }, db);
    return job;
  });
  await openToMarketplace({ ...job, declined_by: tech.id }, `${tech.full_name.split(' ')[0]} can't take this one, so we've shared it with other nearby technicians.`);
  res.json({ ok: true });
});

/** Decline an instant booking: the job returns to the marketplace (assigned -> open). */
jobRequestsRouter.post('/jobs/:id/instant/decline', ...techOnly, async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
  const tech = currentUser(req);
  const job = await tx(async (db) => {
    const current = await one(`SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [jobId], db);
    if (!current || current.technician_id !== tech.id || current.booking_mode !== 'instant' || current.status !== 'assigned') {
      throw conflict('No instant booking of yours to decline on this job');
    }
    const job = await transitionJob(jobId, 'open', { id: null, role: 'system' }, {
      db,
      note: `technician declined instant booking${reason ? `: ${reason}` : ''}`,
      extra: async (d) => {
        await d.query(
          `UPDATE jobs SET technician_id = NULL, target_technician_id = NULL, booking_mode = 'open', budget_minor = NULL,
                  labor_commission_bps = NULL, markup_commission_bps = NULL WHERE id = $1`,
          [jobId],
        );
      },
    });
    await db.query(`UPDATE quotes SET status = 'withdrawn' WHERE job_id = $1 AND technician_id = $2`, [jobId, tech.id]);
    await db.query('UPDATE conversations SET is_open = false WHERE job_id = $1', [jobId]);
    await db.query('INSERT INTO job_dismissals (technician_id, job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tech.id, jobId]);
    await audit(jobId, tech.id, 'instant.declined', { reason: reason ?? null }, db);
    return job;
  });
  const full = await one('SELECT * FROM jobs WHERE id = $1', [job.id]);
  await openToMarketplace({ ...full, declined_by: tech.id }, `${tech.full_name.split(' ')[0]} couldn't take your instant booking, so we've shared it with other nearby technicians.`);
  res.json({ job: full });
});

/** "Not interested": hide an open job from my feed. */
jobRequestsRouter.post('/jobs/:id/dismiss', ...techOnly, async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const tech = currentUser(req);
  const job = await one('SELECT target_technician_id FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw notFound('Job');
  if (job.target_technician_id === tech.id) throw badRequest('Decline the booking request instead');
  await query('INSERT INTO job_dismissals (technician_id, job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tech.id, jobId]);
  res.status(204).end();
});

/**
 * The job invoice: Labor and Parts/Materials as separate sections, disclosed
 * markup per part, receipts. Commission is shown to the technician and admins.
 */
jobRequestsRouter.get('/jobs/:id/invoice', authenticate, requireUser(), async (req, res) => {
  const user = currentUser(req);
  const job = await loadJobFor(parse(z.uuid(), req.params.id), user.id, user.role);
  if (job.customer_id !== user.id && job.technician_id !== user.id && user.role !== 'admin') throw forbidden();
  const inv = await invoiceFor(job.id);
  res.json({ invoice: job.customer_id === user.id ? { ...inv, commission: undefined } : inv });
});

/** Section 5a: every request, piece of evidence and decision is logged here. */
jobRequestsRouter.get('/jobs/:id/audit', authenticate, requireUser(), async (req, res) => {
  const user = currentUser(req);
  const job = await loadJobFor(parse(z.uuid(), req.params.id), user.id, user.role);
  if (job.customer_id !== user.id && job.technician_id !== user.id && user.role !== 'admin') throw forbidden();
  const entries = await query(
    `SELECT a.id, a.action, a.details, a.created_at, u.full_name AS actor_name, u.role AS actor_role
       FROM job_audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.job_id = $1 ORDER BY a.id`,
    [job.id],
  );
  res.json({ entries });
});

const CustomerRatingBody = z.object({
  scores: z.object(Object.fromEntries(CUSTOMER_RATING_CATEGORIES.map((c) => [c, z.number().int().min(1).max(5)])) as Record<
    (typeof CUSTOMER_RATING_CATEGORIES)[number],
    z.ZodNumber
  >),
  comment: z.string().trim().max(1000).optional(),
});

/**
 * Section 7: the technician rates the customer on agreement compliance. Not
 * mandatory; only on verified, completed, platform-paid bookings.
 */
jobRequestsRouter.post('/jobs/:id/customer-rating', ...techOnly, async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(CustomerRatingBody, req.body);
  const tech = currentUser(req);
  const rating = await tx(async (db) => {
    const job = await one('SELECT * FROM jobs WHERE id = $1 AND technician_id = $2', [jobId, tech.id], db);
    if (!job) throw notFound('Job');
    if (job.status !== 'paid') throw conflict('Customers can be rated once the job is paid through the platform');
    const vals = Object.values(b.scores);
    const overall = Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100;
    const rating = await one(
      `INSERT INTO customer_ratings (job_id, technician_id, customer_id, scores, overall, comment) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [jobId, tech.id, job.customer_id, b.scores, overall, b.comment ?? null],
      db,
    );
    await db.query(
      `UPDATE users u SET customer_rating_count = s.n, customer_rating_avg = s.avg
         FROM (SELECT count(*) AS n, round(avg(overall), 2) AS avg FROM customer_ratings WHERE customer_id = $1) s WHERE u.id = $1`,
      [job.customer_id],
    );
    await audit(jobId, tech.id, 'customer.rated', { overall }, db);
    return rating;
  });
  res.status(201).json({ rating });
});
