import { JOB_STATUSES, type UserRole } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler, minutes } from '../queues/index';
import { afterTransition, newJobRef, transitionJob } from '../services/jobs/lifecycle';
import { findMatchingTechnicians } from '../services/matching';
import { waDeepLink } from '../services/messaging/whatsapp';

export const jobsRouter = Router();

const CreateJob = z.object({
  categoryId: z.number().int().positive(),
  title: z.string().trim().min(3).max(140),
  description: z.string().max(4000).optional(),
  address: z.string().trim().min(3).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  scheduledFor: z.iso.datetime().optional(),
  budgetMinor: z.number().int().min(0).optional(),
  currency: z.string().length(3).toUpperCase(),
  boqFileId: z.uuid().optional(),
  photoFileIds: z.array(z.uuid()).max(10).default([]),
});

jobsRouter.post('/jobs', authenticate, requireUser('customer'), async (req, res) => {
  const b = parse(CreateJob, req.body);
  const customer = currentUser(req);
  const job = await tx(async (db) => {
    const ownFiles = [...b.photoFileIds, ...(b.boqFileId ? [b.boqFileId] : [])];
    if (ownFiles.length) {
      const owned = await one<{ n: number }>('SELECT count(*)::int AS n FROM files WHERE id = ANY($1) AND owner_id = $2', [ownFiles, customer.id], db);
      if (owned?.n !== new Set(ownFiles).size) throw badRequest('Unknown file id');
    }
    const created = await one(
      `INSERT INTO jobs (ref, customer_id, category_id, title, description, address, lat, lng, scheduled_for, budget_minor, currency, boq_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [newJobRef(), customer.id, b.categoryId, b.title, b.description ?? null, b.address, b.lat, b.lng, b.scheduledFor ?? null, b.budgetMinor ?? null, b.currency, b.boqFileId ?? null],
      db,
    );
    for (const fileId of b.photoFileIds) {
      await db.query('INSERT INTO job_files (job_id, file_id) VALUES ($1, $2)', [created.id, fileId]);
    }
    await db.query(`INSERT INTO job_status_history (job_id, to_status, actor_id) VALUES ($1, 'open', $2)`, [created.id, customer.id]);
    return created;
  });

  const matches = await findMatchingTechnicians(job, Number(job.match_radius_km));
  await Promise.all(
    matches.map((t) =>
      scheduler().notify(t.user_id, {
        title: 'New job near you',
        body: `${job.title} — ${t.distance_km.toFixed(1)} km away`,
        data: { jobId: job.id, type: 'job.new' },
      }),
    ),
  );
  await scheduler().scheduleEscalation({ kind: 'no_quote_widen', jobId: job.id }, minutes(env.ESCALATE_NO_QUOTE_WIDEN_AFTER_MIN));
  res.status(201).json({ job, matchedTechnicians: matches.length });
});

const ListJobs = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  /** Technicians: jobs open for quoting near them instead of their own jobs. */
  feed: z.enum(['nearby']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

jobsRouter.get('/jobs', authenticate, requireUser(), async (req, res) => {
  const q = parse(ListJobs, req.query);
  const user = currentUser(req);

  if (q.feed === 'nearby') {
    if (user.role !== 'technician') throw forbidden('Only technicians have a job feed');
    const rows = await query(
      `SELECT j.id, j.ref, j.title, j.description, j.address, j.lat, j.lng, j.status, j.scheduled_for,
              j.budget_minor, j.currency, j.category_id, j.created_at,
              2 * 6371 * asin(sqrt(power(sin(radians(tp.base_lat - j.lat) / 2), 2) +
                cos(radians(j.lat)) * cos(radians(tp.base_lat)) * power(sin(radians(tp.base_lng - j.lng) / 2), 2))) AS distance_km,
              EXISTS (SELECT 1 FROM quotes qq WHERE qq.job_id = j.id AND qq.technician_id = $1) AS already_quoted
         FROM jobs j
         JOIN technician_profiles tp ON tp.user_id = $1
         JOIN technician_services ts ON ts.technician_id = $1 AND ts.category_id = j.category_id
        WHERE j.status IN ('open', 'quoted') AND tp.verification_status = 'verified'
          AND tp.base_lat IS NOT NULL
          AND 2 * 6371 * asin(sqrt(power(sin(radians(tp.base_lat - j.lat) / 2), 2) +
                cos(radians(j.lat)) * cos(radians(tp.base_lat)) * power(sin(radians(tp.base_lng - j.lng) / 2), 2)))
              <= GREATEST(j.match_radius_km, tp.service_radius_km)
        ORDER BY j.created_at DESC LIMIT $2`,
      [user.id, q.limit],
    );
    res.json({ jobs: rows });
    return;
  }

  const column: Partial<Record<UserRole, string>> = { customer: 'customer_id', technician: 'technician_id' };
  const col = column[user.role];
  if (!col && user.role !== 'admin') throw forbidden();
  const rows = await query(
    `SELECT j.*, c.name AS category_name FROM jobs j JOIN service_categories c ON c.id = j.category_id
      WHERE ($1::text IS NULL OR j.${col ?? 'customer_id'} = $1::uuid) AND ($2::job_status IS NULL OR j.status = $2)
      ORDER BY j.created_at DESC LIMIT $3`,
    [col ? user.id : null, q.status ?? null, q.limit],
  );
  res.json({ jobs: rows });
});

async function loadJobFor(jobId: string, userId: string, role: UserRole) {
  const job = await one('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw notFound('Job');
  const isParty = job.customer_id === userId || job.technician_id === userId;
  // Technicians may view open jobs they could quote on.
  const canBrowse = role === 'technician' && (job.status === 'open' || job.status === 'quoted');
  if (!isParty && !canBrowse && role !== 'admin') throw notFound('Job');
  return job;
}

jobsRouter.get('/jobs/:id', authenticate, requireUser(), async (req, res) => {
  const user = currentUser(req);
  const job = await loadJobFor(parse(z.uuid(), req.params.id), user.id, user.role);
  const isCustomer = job.customer_id === user.id || user.role === 'admin';
  const [quotes, history] = await Promise.all([
    query(
      `SELECT q.id, q.technician_id, q.amount_minor, q.currency, q.message, q.eta_minutes, q.status, q.created_at,
              u.full_name AS technician_name, tp.rating_avg, tp.rating_count
         FROM quotes q JOIN users u ON u.id = q.technician_id JOIN technician_profiles tp ON tp.user_id = q.technician_id
        WHERE q.job_id = $1 AND ($2 OR q.technician_id = $3) ORDER BY q.amount_minor`,
      [job.id, isCustomer, user.id],
    ),
    query('SELECT from_status, to_status, note, created_at FROM job_status_history WHERE job_id = $1 ORDER BY created_at', [job.id]),
  ]);
  const isParty = job.customer_id === user.id || job.technician_id === user.id;
  res.json({ job, quotes, history, whatsappLink: isParty && job.technician_id ? (waDeepLink(job.ref) ?? null) : null });
});

const QuoteBody = z.object({
  amountMinor: z.number().int().positive(),
  message: z.string().max(2000).optional(),
  etaMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
});

jobsRouter.post('/jobs/:id/quotes', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(QuoteBody, req.body);
  const tech = currentUser(req);
  const { quote, job, promoted } = await tx(async (db) => {
    const job = await one('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId], db);
    if (!job) throw notFound('Job');
    if (job.status !== 'open' && job.status !== 'quoted') throw conflict('Job is no longer accepting quotes');
    const eligible = await one(
      `SELECT 1 FROM technician_profiles tp JOIN technician_services ts ON ts.technician_id = tp.user_id AND ts.category_id = $2
        WHERE tp.user_id = $1 AND tp.verification_status = 'verified'`,
      [tech.id, job.category_id],
      db,
    );
    if (!eligible) throw forbidden('You must be verified and offer this service to quote');
    const quote = await one(
      `INSERT INTO quotes (job_id, technician_id, amount_minor, currency, message, eta_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [jobId, tech.id, b.amountMinor, job.currency, b.message ?? null, b.etaMinutes ?? null],
      db,
    );
    let promoted = null;
    if (job.status === 'open') {
      promoted = await transitionJob(jobId, 'quoted', { id: null, role: 'system' }, { db, note: 'first quote received' });
    }
    return { quote, job, promoted };
  });
  if (promoted) await afterTransition(promoted);
  await scheduler().notify(job.customer_id, {
    title: 'New quote received',
    body: `${tech.full_name} quoted on "${job.title}"`,
    data: { jobId, type: 'quote.new' },
  });
  res.status(201).json({ quote });
});

jobsRouter.post('/jobs/:id/quotes/:quoteId/accept', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const customer = currentUser(req);
  const job = await tx(async (db) => {
    const quote = await one(`SELECT * FROM quotes WHERE id = $1 AND job_id = $2 AND status = 'pending' FOR UPDATE`, [quoteId, jobId], db);
    if (!quote) throw notFound('Quote');
    const job = await transitionJob(jobId, 'assigned', { id: customer.id, role: 'customer' }, {
      db,
      note: `accepted quote ${quoteId}`,
      extra: async (d) => {
        await d.query('UPDATE jobs SET technician_id = $2, budget_minor = $3 WHERE id = $1', [jobId, quote.technician_id, quote.amount_minor]);
      },
    });
    await db.query(`UPDATE quotes SET status = CASE WHEN id = $2 THEN 'accepted'::quote_status ELSE 'rejected'::quote_status END WHERE job_id = $1 AND status = 'pending'`, [jobId, quoteId]);
    await db.query(
      'INSERT INTO conversations (job_id, customer_id, technician_id) VALUES ($1, $2, $3) ON CONFLICT (job_id) DO NOTHING',
      [jobId, customer.id, quote.technician_id],
    );
    return job;
  });
  await afterTransition(job);
  res.json({ job, whatsappLink: waDeepLink(job.ref) ?? null });
});

const StatusBody = z.object({
  status: z.enum(['en_route', 'in_progress', 'completed', 'cancelled', 'disputed']),
  note: z.string().max(1000).optional(),
});

jobsRouter.post('/jobs/:id/status', authenticate, requireUser('customer', 'technician', 'admin'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(StatusBody, req.body);
  const user = currentUser(req);
  const job = await transitionJob(jobId, b.status, { id: user.id, role: user.role }, { note: b.note });
  // The relay stays open through completion so the parties can sort out payment; it closes once paid.
  if (job.status === 'cancelled') {
    await query('UPDATE conversations SET is_open = false WHERE job_id = $1', [jobId]);
  }
  res.json({ job });
});

const ReviewBody = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() });

jobsRouter.post('/jobs/:id/review', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(ReviewBody, req.body);
  const customer = currentUser(req);
  const review = await tx(async (db) => {
    const job = await one('SELECT * FROM jobs WHERE id = $1 AND customer_id = $2', [jobId, customer.id], db);
    if (!job) throw notFound('Job');
    if (!['completed', 'paid'].includes(job.status) || !job.technician_id) throw conflict('You can review a job once it is completed');
    const review = await one(
      'INSERT INTO reviews (job_id, reviewer_id, reviewee_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [jobId, customer.id, job.technician_id, b.rating, b.comment ?? null],
      db,
    );
    await db.query(
      `UPDATE technician_profiles tp SET rating_count = s.n, rating_avg = s.avg
         FROM (SELECT count(*) AS n, round(avg(rating)::numeric, 2) AS avg FROM reviews WHERE reviewee_id = $1) s
        WHERE tp.user_id = $1`,
      [job.technician_id],
    );
    return review;
  });
  res.status(201).json({ review });
});
