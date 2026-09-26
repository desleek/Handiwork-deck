import { BOOKING_MODES, JOB_STATUSES, overallRating, REVIEW_CATEGORIES, REVIEW_MIN_COMMENT_LENGTH, type UserRole } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler, minutes } from '../queues/index';
import { invoiceFor } from '../services/jobs/invoice';
import { afterTransition, type JobRecord, newJobRef, transitionJob } from '../services/jobs/lifecycle';
import { assignQuote, writeQuoteItems } from '../services/jobs/quotes';
import { findMatchingTechnicians } from '../services/matching';
import { waDeepLink } from '../services/messaging/whatsapp';
import { customerTrust, effectiveRateBps, recomputeTechnicianRating } from '../services/ratings';
import { pendingReviewJobs } from '../services/reviews';

export const jobsRouter = Router();

const CreateJob = z
  .object({
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
    /** open = post to the marketplace; request = ask one technician for a quote; instant = book them now at their listed rate. */
    bookingMode: z.enum(BOOKING_MODES).default('open'),
    technicianId: z.uuid().optional(),
    /** Required when posting under an "Other / custom" category. */
    customServiceName: z.string().trim().min(3).max(80).optional(),
  })
  .refine((b) => b.bookingMode === 'open' || b.technicianId, { message: 'technicianId is required for request / instant booking', path: ['technicianId'] })
  .refine((b) => b.bookingMode !== 'open' || !b.technicianId, { message: 'technicianId is only used with request / instant booking', path: ['technicianId'] });

jobsRouter.post('/jobs', authenticate, requireUser('customer'), async (req, res) => {
  const b = parse(CreateJob, req.body);
  const customer = currentUser(req);

  // Section 3: a review is mandatory after every completed job before booking again.
  const unreviewed = await pendingReviewJobs(customer.id);
  if (unreviewed.length) {
    throw new HttpError(409, 'Please review your completed job(s) before booking again', 'review_required', {
      jobs: unreviewed.map((j) => ({ id: j.id, ref: j.ref, title: j.title })),
    });
  }

  const category = await one('SELECT id, name, is_other, is_active, segment FROM service_categories WHERE id = $1', [b.categoryId]);
  if (!category?.is_active) throw badRequest('Unknown or inactive category');
  if (category.is_other && !b.customServiceName) throw badRequest('Describe the service you need (customServiceName)');
  if (category.is_other && b.bookingMode !== 'open') throw badRequest('Custom services can only be posted to the marketplace');

  let tech: any = null;
  if (b.technicianId) {
    tech = await one(
      `SELECT tp.user_id, tp.instant_book_enabled, ts.base_rate_minor, ts.currency,
              technician_available_at(tp.user_id, COALESCE($3::timestamptz, now())) AS available
         FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
         JOIN technician_services ts ON ts.technician_id = tp.user_id AND ts.category_id = $2
        WHERE tp.user_id = $1 AND u.is_active AND tp.is_available AND tp.verification_status = 'verified'`,
      [b.technicianId, b.categoryId, b.scheduledFor ?? null],
    );
    if (!tech) throw conflict('That technician is not available for this service');
    if (b.bookingMode === 'instant') {
      if (!tech.instant_book_enabled) throw conflict('This technician does not offer instant booking — send a booking request instead');
      if (!tech.base_rate_minor || tech.currency !== b.currency) throw conflict('This technician has no listed rate in that currency for instant booking');
      if (!tech.available) throw conflict("This technician isn't working at that time — pick another time or send a request");
    }
  }

  const { job, assigned } = await tx(async (db) => {
    const ownFiles = [...b.photoFileIds, ...(b.boqFileId ? [b.boqFileId] : [])];
    if (ownFiles.length) {
      const owned = await one<{ n: number }>('SELECT count(*)::int AS n FROM files WHERE id = ANY($1) AND owner_id = $2', [ownFiles, customer.id], db);
      if (owned?.n !== new Set(ownFiles).size) throw badRequest('Unknown file id');
    }
    const job = await one(
      `INSERT INTO jobs (ref, customer_id, category_id, title, description, address, lat, lng, scheduled_for, budget_minor, currency,
                         boq_file_id, booking_mode, target_technician_id, custom_service_name, awaiting_category_review)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        newJobRef(), customer.id, b.categoryId, b.title, b.description ?? null, b.address, b.lat, b.lng, b.scheduledFor ?? null,
        b.budgetMinor ?? null, b.currency, b.boqFileId ?? null, b.bookingMode, b.technicianId ?? null,
        b.customServiceName ?? null, Boolean(category.is_other),
      ],
      db,
    );
    for (const fileId of b.photoFileIds) {
      await db.query('INSERT INTO job_files (job_id, file_id) VALUES ($1, $2)', [job.id, fileId]);
    }
    await db.query(`INSERT INTO job_status_history (job_id, to_status, actor_id, note) VALUES ($1, 'open', $2, $3)`, [
      job.id,
      customer.id,
      `${b.bookingMode} booking`,
    ]);
    if (category.is_other) {
      await db.query('INSERT INTO category_suggestions (name, segment, suggested_by, job_id, note) VALUES ($1, $2, $3, $4, $5)', [
        b.customServiceName,
        category.segment,
        customer.id,
        job.id,
        b.description ?? null,
      ]);
    }
    if (b.bookingMode !== 'instant') return { job, assigned: null };

    // Instant book: the technician's listed rate becomes an accepted quote and the job is assigned now.
    const quote = await one(
      `INSERT INTO quotes (job_id, technician_id, amount_minor, currency, message) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [job.id, tech.user_id, tech.base_rate_minor, b.currency, 'Instant booking at listed rate'],
      db,
    );
    await writeQuoteItems(db, { quoteId: quote.id, jobId: job.id, technicianId: tech.user_id, currency: b.currency, revision: 1, performanceAdjustmentBps: await effectiveRateBps(tech.user_id, db) }, [
      { kind: 'labor', description: `${category.name} — listed rate (instant booking)`, quantity: 1, unitPriceMinor: tech.base_rate_minor },
    ]);
    const assigned = await assignQuote(db, job.id, quote.id, { id: null, role: 'system' }, 'instant booking');
    return { job, assigned };
  });

  if (assigned) {
    await afterTransition(assigned);
    res.status(201).json({ job: { ...job, ...assigned }, matchedTechnicians: 1, whatsappLink: waDeepLink(job.ref) ?? null });
    return;
  }

  let notified = 0;
  if (job.awaiting_category_review) {
    // "Other/custom" jobs wait for an admin to approve the service before matching.
  } else if (b.bookingMode === 'request') {
    await scheduler().notify(b.technicianId!, {
      title: 'Booking request',
      body: `${customer.full_name.split(' ')[0]} wants a quote from you: ${job.title}`,
      data: { jobId: job.id, type: 'job.request' },
    });
    notified = 1;
  } else {
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
    notified = matches.length;
  }
  await scheduler().scheduleEscalation({ kind: 'no_quote_widen', jobId: job.id }, minutes(env.ESCALATE_NO_QUOTE_WIDEN_AFTER_MIN));
  res.status(201).json({ job, matchedTechnicians: notified });
});

const ListJobs = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  /** Technicians: jobs open for quoting near them (plus requests addressed to them). */
  feed: z.enum(['nearby']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

jobsRouter.get('/jobs', authenticate, requireUser(), async (req, res) => {
  const q = parse(ListJobs, req.query);
  const user = currentUser(req);

  if (q.feed === 'nearby') {
    if (user.role !== 'technician') throw forbidden('Only technicians have a job feed');
    const rows = await query(
      `SELECT * FROM (
         SELECT j.id, j.ref, j.customer_id, j.title, j.description, j.address, j.lat, j.lng, j.status, j.scheduled_for, j.booking_mode,
                j.budget_minor, j.currency, j.category_id, c.name AS category_name, c.icon AS category_icon, j.created_at,
                j.target_technician_id = $1 AS is_request_to_me, j.request_accepted_at, j.match_radius_km, tp.service_radius_km,
                2 * 6371 * asin(sqrt(power(sin(radians(tp.base_lat - j.lat) / 2), 2) +
                  cos(radians(j.lat)) * cos(radians(tp.base_lat)) * power(sin(radians(tp.base_lng - j.lng) / 2), 2))) AS distance_km,
                EXISTS (SELECT 1 FROM quotes qq WHERE qq.job_id = j.id AND qq.technician_id = $1) AS already_quoted
           FROM jobs j
           JOIN service_categories c ON c.id = j.category_id
           JOIN technician_profiles tp ON tp.user_id = $1
           JOIN technician_services ts ON ts.technician_id = $1 AND ts.category_id = j.category_id
          WHERE j.status IN ('open', 'quoted') AND tp.verification_status = 'verified' AND tp.base_lat IS NOT NULL
            AND NOT j.awaiting_category_review
            AND (j.target_technician_id IS NULL OR j.target_technician_id = $1)
            AND NOT EXISTS (SELECT 1 FROM job_dismissals d WHERE d.job_id = j.id AND d.technician_id = $1)
       ) f
       WHERE f.is_request_to_me OR f.distance_km <= GREATEST(f.match_radius_km, f.service_radius_km)
       ORDER BY f.is_request_to_me DESC, f.created_at DESC LIMIT $2`,
      [user.id, q.limit],
    );
    // Section 7: agreement-compliance rating and completion badge, visible before accepting.
    const trust = new Map<string, Awaited<ReturnType<typeof customerTrust>>>();
    for (const r of rows) if (!trust.has(r.customer_id)) trust.set(r.customer_id, await customerTrust(r.customer_id));
    res.json({ jobs: rows.map(({ customer_id, ...r }) => ({ ...r, customer: trust.get(customer_id) })) });
    return;
  }

  const column: Partial<Record<UserRole, string>> = { customer: 'customer_id', technician: 'technician_id' };
  const col = column[user.role];
  if (!col && user.role !== 'admin') throw forbidden();
  const rows = await query(
    `SELECT j.*, c.name AS category_name, c.icon AS category_icon,
            (j.status IN ('completed', 'paid') AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.job_id = j.id)) AS needs_review
       FROM jobs j JOIN service_categories c ON c.id = j.category_id
      WHERE ($1::text IS NULL OR j.${col ?? 'customer_id'} = $1::uuid) AND ($2::job_status IS NULL OR j.status = $2)
      ORDER BY j.created_at DESC LIMIT $3`,
    [col ? user.id : null, q.status ?? null, q.limit],
  );
  res.json({ jobs: rows });
});

/** Loads a job if the user may see it: its parties, admins, or technicians who could quote on it. */
export async function loadJobFor(jobId: string, userId: string, role: UserRole) {
  const job = await one('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw notFound('Job');
  const isParty = job.customer_id === userId || job.technician_id === userId;
  const canBrowse =
    role === 'technician' &&
    (job.status === 'open' || job.status === 'quoted') &&
    !job.awaiting_category_review &&
    (job.target_technician_id === null || job.target_technician_id === userId);
  const hasQuoted = role === 'technician' && !!(await one('SELECT 1 FROM quotes WHERE job_id = $1 AND technician_id = $2 AND status <> $3', [jobId, userId, 'rejected']));
  if (!isParty && !canBrowse && !hasQuoted && role !== 'admin') throw notFound('Job');
  return job;
}

jobsRouter.get('/jobs/:id', authenticate, requireUser(), async (req, res) => {
  const user = currentUser(req);
  const job = await loadJobFor(parse(z.uuid(), req.params.id), user.id, user.role);
  const seesAllQuotes = job.customer_id === user.id || user.role === 'admin';
  const [quotes, history, review, customer, customerRating] = await Promise.all([
    query(
      `SELECT q.id, q.technician_id, q.amount_minor, q.labor_minor, q.materials_minor, q.currency, q.message, q.eta_minutes,
              q.status, q.revision, q.labor_only, q.created_at, q.updated_at,
              q.parts_base_minor, q.markup_minor,
              u.full_name AS technician_name, tp.rating_avg, tp.rating_count,
              COALESCE(ts.labor_only_policy, 'decline') AS labor_only_policy,
              (SELECT coalesce(json_agg(i ORDER BY i.position), '[]'::json) FROM (
                 SELECT id, kind, description, quantity::float8 AS quantity, unit_price_minor, base_minor, markup_bps, markup_minor,
                        total_minor, applies_to, receipt_file_id, position
                   FROM quote_items WHERE quote_id = q.id) i) AS items,
              (SELECT coalesce(json_agg(e ORDER BY e.created_at), '[]'::json) FROM (
                 SELECT id, quote_item_id, line_description, requested_markup_bps, cap_bps, status, admin_note, created_at
                   FROM cap_exception_requests WHERE quote_id = q.id AND quote_revision = q.revision AND status <> 'withdrawn') e) AS cap_exceptions,
              (SELECT row_to_json(c) FROM (
                 SELECT id, kind, proposed_total_minor, proposed_labor_minor, message, status, created_at, responded_at
                   FROM quote_counters WHERE quote_id = q.id ORDER BY created_at DESC LIMIT 1) c) AS latest_counter
         FROM quotes q JOIN users u ON u.id = q.technician_id JOIN technician_profiles tp ON tp.user_id = q.technician_id
         JOIN jobs jj ON jj.id = q.job_id
         LEFT JOIN technician_services ts ON ts.technician_id = q.technician_id AND ts.category_id = jj.category_id
        WHERE q.job_id = $1 AND ($2 OR q.technician_id = $3) ORDER BY q.amount_minor`,
      [job.id, seesAllQuotes, user.id],
    ),
    query('SELECT from_status, to_status, note, created_at FROM job_status_history WHERE job_id = $1 ORDER BY created_at', [job.id]),
    one('SELECT overall, scores, comment, created_at FROM reviews WHERE job_id = $1', [job.id]),
    // Technicians see how well the customer has kept to past agreements, before they accept.
    one(`SELECT split_part(full_name, ' ', 1) AS first_name, customer_type FROM users WHERE id = $1`, [job.customer_id]).then(async (c) => ({
      ...c,
      ...(await customerTrust(job.customer_id)),
    })),
    one('SELECT overall, scores, comment, created_at FROM customer_ratings WHERE job_id = $1', [job.id]),
  ]);
  const isParty = job.customer_id === user.id || job.technician_id === user.id;
  res.json({
    job,
    quotes,
    history,
    review: review ?? null,
    customer: user.role === 'customer' ? undefined : customer,
    customerRating: job.technician_id === user.id || user.role === 'admin' ? (customerRating ?? null) : undefined,
    whatsappLink: isParty && job.technician_id ? (waDeepLink(job.ref) ?? null) : null,
  });
});

const StatusBody = z.object({
  status: z.enum(['en_route', 'in_progress', 'completed', 'cancelled', 'disputed']),
  note: z.string().max(1000).optional(),
});

jobsRouter.post('/jobs/:id/status', authenticate, requireUser('customer', 'technician', 'admin'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(StatusBody, req.body);
  const user = currentUser(req);
  if (b.status === 'completed') {
    // Section 5: parts above the receipt threshold need proof of purchase before invoicing.
    const inv = await invoiceFor(jobId);
    if (inv.missingReceipts.length) {
      throw new HttpError(409, 'Attach receipts for the listed parts before completing the job', 'receipts_required', { lines: inv.missingReceipts });
    }
  }
  const job = await transitionJob(jobId, b.status, { id: user.id, role: user.role }, { note: b.note });
  // The relay stays open through completion so the parties can sort out payment; it closes once paid.
  if (job.status === 'cancelled') {
    await query('UPDATE conversations SET is_open = false WHERE job_id = $1', [jobId]);
  }
  res.json({ job: job as JobRecord });
});

const ReviewBody = z.object({
  scores: z.object(Object.fromEntries(REVIEW_CATEGORIES.map((c) => [c, z.number().int().min(1).max(5)])) as Record<
    (typeof REVIEW_CATEGORIES)[number],
    z.ZodNumber
  >),
  comment: z.string().trim().min(REVIEW_MIN_COMMENT_LENGTH, `Write at least ${REVIEW_MIN_COMMENT_LENGTH} characters`).max(2000),
});

/**
 * Mandatory after every completed job: a score for all seven categories plus a
 * written review. Only verified, completed, platform-paid bookings can be reviewed.
 */
jobsRouter.post('/jobs/:id/review', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(ReviewBody, req.body);
  const customer = currentUser(req);
  const overall = overallRating(b.scores);
  const review = await tx(async (db) => {
    const job = await one(
      `SELECT j.*, tp.verification_status,
              EXISTS (SELECT 1 FROM payments p WHERE p.job_id = j.id AND p.status IN ('succeeded', 'partially_refunded')) AS platform_paid
         FROM jobs j LEFT JOIN technician_profiles tp ON tp.user_id = j.technician_id
        WHERE j.id = $1 AND j.customer_id = $2`,
      [jobId, customer.id],
      db,
    );
    if (!job) throw notFound('Job');
    if (job.status !== 'paid' || !job.platform_paid || !job.technician_id) throw conflict('You can review a job once it is completed and paid through the platform');
    if (job.verification_status !== 'verified') throw conflict('Reviews are only accepted for verified technicians');
    const review = await one(
      `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, rating, overall, scores, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [jobId, customer.id, job.technician_id, Math.round(overall), overall, b.scores, b.comment],
      db,
    );
    await recomputeTechnicianRating(job.technician_id, db);
    return review;
  });
  res.status(201).json({ review });
});
