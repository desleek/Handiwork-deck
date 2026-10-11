import { Router } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../db/pool.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import {
  assertCustomer,
  assertParticipant,
  assertStandard,
  assertTechnician,
  getJob,
  logJobEvent,
  newShortCode,
  transition,
} from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { captureJobPayment, refundPayment, startPayment } from '../services/payments/escrow.ts';
import { liveQuote, presentQuote, quoteItems } from '../services/quotes.ts';
import { pendingReviewJobIds, refreshCompletionBadge } from '../services/ratings.ts';
import { assertAllowed } from '../services/restrictions.ts';
import { getSettings } from '../services/settings.ts';

export const jobs = Router();
jobs.use(authenticate, requireUser());

const id = z.string().uuid();

/**
 * Create a booking (Section 3): "instant" books the technician at their standard rate;
 * "request" asks them to accept first. Blocked while any completed job is unreviewed (Section 7)
 * or while the customer is under a Section 18 restriction.
 */
jobs.post('/', requireUser('customer'), async (req, res) => {
  const b = parse(
    z.object({
      technicianId: id,
      categoryId: id,
      bookingType: z.enum(['instant', 'request']),
      description: z.string().trim().min(10).max(4000),
      address: z.string().trim().min(5).max(500),
      lat: z.number().optional(),
      lng: z.number().optional(),
      scheduledFor: z.coerce.date().optional(),
      fastTrack: z.boolean().default(false),
    }),
    req.body,
  );
  const customerId = req.user!.id;
  const pending = await pendingReviewJobIds(customerId);
  if (pending.length) {
    throw forbidden('REVIEW_REQUIRED', 'Please rate your last completed job before booking again', { jobIds: pending });
  }
  await assertAllowed(customerId, 'create_booking');

  const s = await getSettings();
  const offer = await one<any>(
    `SELECT tc.*, c.supercategory, t.verification_status, u.status AS user_status
       FROM technician_categories tc
       JOIN service_categories c ON c.id = tc.category_id AND c.is_active
       JOIN technician_profiles t ON t.user_id = tc.technician_id
       JOIN users u ON u.id = tc.technician_id
      WHERE tc.technician_id = $1 AND tc.category_id = $2`,
    [b.technicianId, b.categoryId],
  );
  if (!offer || offer.verification_status !== 'verified' || !['active', 'restricted'].includes(offer.user_status)) {
    throw notFound('Technician offering this service');
  }
  if (offer.supercategory === 'construction' && !s.features.construction) {
    throw conflict('CONSTRUCTION_NOT_LIVE', 'Construction services are coming soon');
  }
  // Construction always starts with a paid site consultation (Section 17, Step 1) — never instant.
  const isConstruction = offer.supercategory === 'construction';
  if (isConstruction) b.bookingType = 'request';

  const job = await tx(async (db) => {
    const j = await one(
      `INSERT INTO jobs (short_code, kind, booking_type, customer_id, technician_id, category_id, description, address, lat, lng,
          scheduled_for, is_fast_track, currency, action_required_from, action_required_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'technician',$14) RETURNING *`,
      [
        newShortCode(),
        offer.supercategory === 'construction' ? 'construction' : 'standard',
        b.bookingType,
        customerId,
        b.technicianId,
        b.categoryId,
        b.description,
        b.address,
        b.lat ?? null,
        b.lng ?? null,
        b.scheduledFor ?? null,
        b.fastTrack,
        s.currency,
        isConstruction ? 'Quote a site consultation fee' : b.bookingType === 'instant' ? 'Submit a quote' : 'Accept or decline the booking',
      ],
      db,
    );
    // Instant booking skips the accept step: the technician goes straight to quoting.
    if (b.bookingType === 'instant') {
      await query(`UPDATE jobs SET status = 'accepted' WHERE id = $1`, [j.id], db);
      j.status = 'accepted';
    }
    await logJobEvent(db, j.id, customerId, 'job.created', { bookingType: b.bookingType, fastTrack: b.fastTrack });
    await query(
      `INSERT INTO category_interest (user_id, category_id) VALUES ($1, $2) ON CONFLICT (user_id, category_id) DO UPDATE SET last_seen_at = now()`,
      [customerId, b.categoryId],
      db,
    );
    return j;
  });

  await notify({
    userId: b.technicianId,
    type: 'job.new',
    title: isConstruction ? `Site visit request #${job.short_code}` : b.bookingType === 'instant' ? `New instant booking #${job.short_code}` : `New job request #${job.short_code}`,
    body: b.description.slice(0, 120),
    data: { jobId: job.id },
    urgent: b.fastTrack,
    channels: ['push', 'whatsapp'],
    whatsappTemplate: { name: 'new_job_request', params: [job.short_code, b.description.slice(0, 200)] },
  });
  res.status(201).json(job);
});

jobs.get('/', async (req, res) => {
  const q = parse(z.object({ status: z.string().optional(), scope: z.enum(['active', 'history', 'all']).default('all') }), req.query);
  const u = req.user!;
  const col = u.role === 'technician' ? 'technician_id' : 'customer_id';
  const scopeSql =
    q.scope === 'active'
      ? `AND j.status NOT IN ('completed', 'cancelled', 'declined', 'incomplete')`
      : q.scope === 'history'
        ? `AND j.status IN ('completed', 'cancelled', 'declined', 'incomplete')`
        : '';
  const rows = await query(
    `SELECT j.id, j.short_code, j.status, j.kind, j.booking_type, j.is_fast_track, j.description, j.scheduled_for,
            j.action_required_from, j.action_required_reason, j.created_at,
            c.name AS category_name, c.icon AS category_icon,
            ${u.role === 'technician' ? `cu.full_name AS counterpart_name` : `tu.full_name AS counterpart_name, tu.avatar_url AS counterpart_avatar`},
            (SELECT customer_total_minor FROM quotes q WHERE q.job_id = j.id AND q.status IN ('submitted','pending_exception','approved') ORDER BY version DESC LIMIT 1) AS quote_total_minor
       FROM jobs j
       JOIN service_categories c ON c.id = j.category_id
       JOIN users cu ON cu.id = j.customer_id
       JOIN users tu ON tu.id = j.technician_id
      WHERE j.${col} = $1 ${scopeSql} AND ($2::text IS NULL OR j.status::text = $2)
      ORDER BY j.updated_at DESC LIMIT 100`,
    [u.id, q.status ?? null],
  );
  res.json(rows);
});

/** Job detail: status, who must act, live quote (itemized), sub-flows, and released contacts. */
jobs.get('/:id', async (req, res) => {
  const job = await getJob(parse(id, req.params.id));
  assertParticipant(job, req.user!.id, req.user!.role);
  const viewer = req.user!.role === 'admin' ? 'admin' : job.customer_id === req.user!.id ? 'customer' : 'technician';

  const [category, customer, tech, quoteRow, laborOnly, challenges, negotiation, exceptions, events, ratingGiven] = await Promise.all([
    one('SELECT id, name, icon, supercategory FROM service_categories WHERE id = $1', [job.category_id]),
    one<any>('SELECT id, full_name, avatar_url, phone_e164, completion_badge FROM users WHERE id = $1', [job.customer_id]),
    one<any>(
      `SELECT u.id, u.full_name, u.avatar_url, u.phone_e164, t.rating_avg, t.rating_count, t.is_online, t.last_lat, t.last_lng, t.last_location_at
         FROM users u JOIN technician_profiles t ON t.user_id = u.id WHERE u.id = $1`,
      [job.technician_id],
    ),
    one<any>(`SELECT * FROM quotes WHERE job_id = $1 AND status IN ('submitted','pending_exception','approved') ORDER BY version DESC LIMIT 1`, [job.id]),
    query('SELECT * FROM labor_only_requests WHERE job_id = $1 ORDER BY created_at DESC', [job.id]),
    query(
      `SELECT pc.*, ps.name AS seller_name, ps.verification_status AS seller_status FROM price_challenges pc
         LEFT JOIN parts_sellers ps ON ps.id = pc.seller_id WHERE pc.job_id = $1 ORDER BY submitted_at DESC`,
      [job.id],
    ),
    one('SELECT * FROM labor_negotiations WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1', [job.id]),
    query('SELECT id, quote_item_id, requested_markup_bps, status, decision_note, created_at, decided_at FROM markup_exceptions WHERE job_id = $1', [job.id]),
    viewer === 'customer' ? Promise.resolve([]) : query('SELECT type, payload, actor_id, created_at FROM job_events WHERE job_id = $1 ORDER BY created_at', [job.id]),
    one('SELECT 1 AS done FROM technician_ratings WHERE job_id = $1', [job.id]),
  ]);

  const released = !!job.contacts_released_at;
  // Technicians see the customer's agreement-compliance record before accepting (Section 7).
  const customerRecord =
    viewer !== 'customer'
      ? await one(
          `SELECT count(*)::int AS ratings, round(avg(overall), 2) AS overall,
                  round(avg(on_site_as_scheduled), 1) AS on_site, round(avg(granted_access), 1) AS access,
                  round(avg(paid_through_platform), 1) AS paid_on_platform, round(avg(respectful_conduct), 1) AS respectful
             FROM customer_ratings WHERE customer_id = $1`,
          [job.customer_id],
        )
      : null;

  res.json({
    ...job,
    category,
    viewer,
    customer: {
      id: customer.id,
      name: customer.full_name,
      avatarUrl: customer.avatar_url,
      completionBadge: customer.completion_badge,
      phone: released ? customer.phone_e164 : null,
      record: customerRecord,
    },
    technician: {
      id: tech.id,
      name: tech.full_name,
      avatarUrl: tech.avatar_url,
      ratingAvg: tech.rating_avg,
      ratingCount: tech.rating_count,
      phone: released ? tech.phone_e164 : null,
      // En-route live location for the booked customer while the technician is online (Section 9).
      liveLocation:
        ['funded', 'en_route'].includes(job.status) && tech.is_online && tech.last_lat !== null
          ? { lat: tech.last_lat, lng: tech.last_lng, at: tech.last_location_at }
          : null,
    },
    quote: quoteRow ? presentQuote(quoteRow, await quoteItems(pool, quoteRow.id), viewer) : null,
    laborOnlyRequests: laborOnly,
    priceChallenges: challenges,
    laborNegotiation: negotiation ?? null,
    capExceptions: exceptions,
    reviewSubmitted: !!ratingGiven,
    events,
  });
});

jobs.post('/:id/accept', requireUser('technician'), async (req, res) => {
  await assertAllowed(req.user!.id, 'accept_job');
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertTechnician(j, req.user!.id);
    assertStandard(j);
    await transition(db, j, 'accepted', req.user!.id);
    return j;
  });
  await notify({ userId: job.customer_id, type: 'job.accepted', title: 'Booking accepted', body: `Your request #${job.short_code} was accepted. A quote is on the way.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

jobs.post('/:id/decline', requireUser('technician'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertTechnician(j, req.user!.id);
    if (!['requested', 'accepted'].includes(j.status)) throw conflict('TOO_LATE', 'This job can no longer be declined');
    await query('UPDATE jobs SET cancel_reason = $2, cancelled_by = $3 WHERE id = $1', [j.id, b.reason ?? null, req.user!.id], db);
    if (j.status === 'accepted') await transition(db, j, 'cancelled', req.user!.id, { event: { reason: b.reason } });
    else await transition(db, j, 'declined', req.user!.id, { event: { reason: b.reason } });
    return j;
  });
  await notify({ userId: job.customer_id, type: 'job.declined', title: 'Booking declined', body: `The technician can't take job #${job.short_code}. Try another pro nearby.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

/** Approve the live quote as-is (Section 6a). Price is then locked; payment comes next. */
jobs.post('/:id/approve', requireUser('customer'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertCustomer(j, req.user!.id);
    assertStandard(j);
    const q = await liveQuote(db, j.id);
    if (q.status !== 'submitted') throw conflict('QUOTE_NOT_READY', q.status === 'pending_exception' ? 'This quote is still under review' : 'No quote to approve');
    const open = await one(
      `SELECT 1 FROM price_challenges WHERE job_id = $1 AND status IN ('open','escalated','pending_evidence_review')
       UNION ALL SELECT 1 FROM labor_negotiations WHERE job_id = $1 AND status IN ('pending','countered')
       UNION ALL SELECT 1 FROM labor_only_requests WHERE job_id = $1 AND status = 'pending' LIMIT 1`,
      [j.id],
      db,
    );
    if (open) throw conflict('OPEN_COUNTER', 'Resolve or withdraw your open counter before approving');
    await query(`UPDATE quotes SET status = 'approved', approved_at = now() WHERE id = $1`, [q.id], db);
    await transition(db, j, 'approved', req.user!.id, { event: { quoteId: q.id, totalMinor: q.customer_total_minor } });
    return j;
  });
  await notify({ userId: job.technician_id, type: 'quote.approved', title: 'Quote approved', body: `Quote for job #${job.short_code} approved. Waiting for payment.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

/** Pay for an approved quote: card, virtual account (transfer), USSD, or wallet (Section 11). */
jobs.post('/:id/pay', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['card', 'bank_transfer', 'ussd', 'wallet']) }), req.body);
  const job = await getJob(parse(id, req.params.id));
  assertCustomer(job, req.user!.id);
  assertStandard(job);
  if (job.status !== 'approved') throw conflict('NOT_PAYABLE', 'Approve a quote before paying');
  const q = await liveQuote(pool, job.id);
  const existing = await one<any>(`SELECT id, checkout, channel FROM payments WHERE job_id = $1 AND purpose = 'job' AND status = 'initiated' AND quote_id = $2 AND channel = $3`, [job.id, q.id, b.channel]);
  if (existing) return res.json({ paymentId: existing.id, status: 'initiated', checkout: existing.checkout }); // idempotent retry
  const payment = await startPayment({
    payer: req.user!,
    purpose: 'job',
    amountMinor: q.customer_total_minor,
    currency: job.currency,
    channel: b.channel,
    description: `Job #${job.short_code}`,
    jobId: job.id,
    quoteId: q.id,
  });
  res.status(201).json(payment);
});

jobs.post('/:id/en-route', requireUser('technician'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertTechnician(j, req.user!.id);
    assertStandard(j);
    await transition(db, j, 'en_route', req.user!.id);
    return j;
  });
  await notify({ userId: job.customer_id, type: 'job.en_route', title: 'Technician on the way', body: `Track your technician live for job #${job.short_code}.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

jobs.post('/:id/start', requireUser('technician'), async (req, res) => {
  await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertTechnician(j, req.user!.id);
    assertStandard(j);
    await transition(db, j, 'in_progress', req.user!.id);
  });
  res.json({ ok: true });
});

jobs.post('/:id/complete', requireUser('technician'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertTechnician(j, req.user!.id);
    assertStandard(j);
    await transition(db, j, 'awaiting_confirmation', req.user!.id);
    return j;
  });
  await notify({ userId: job.customer_id, type: 'job.completed_by_tech', title: 'Job marked complete', body: `Please confirm job #${job.short_code} is done so the technician can be paid.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

/** Customer confirms completion → itemized capture and split payout. Review prompt follows. */
jobs.post('/:id/confirm', requireUser('customer'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertCustomer(j, req.user!.id);
    assertStandard(j);
    if (j.status !== 'awaiting_confirmation') throw conflict('NOT_READY', 'The technician has not marked this job complete');
    await captureJobPayment(db, j.id, req.user!.id);
    await transition(db, j, 'completed', req.user!.id);
    await refreshCompletionBadge(db, j.customer_id);
    return j;
  });
  await notify({ userId: job.technician_id, type: 'job.paid', title: 'Payment released', body: `Earnings for job #${job.short_code} are in your wallet.`, data: { jobId: job.id } });
  res.json({ ok: true, reviewRequired: true });
});

/** Customer reports the work isn't done. Sends the job back to in_progress, or into dispute. */
jobs.post('/:id/reject-completion', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(2000), dispute: z.boolean().default(false), quoteItemId: id.optional() }), req.body);
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertCustomer(j, req.user!.id);
    assertStandard(j);
    if (b.dispute) {
      await query('INSERT INTO disputes (job_id, quote_item_id, raised_by, reason) VALUES ($1,$2,$3,$4)', [j.id, b.quoteItemId ?? null, req.user!.id, b.reason], db);
      await transition(db, j, 'disputed', req.user!.id, { event: { reason: b.reason } });
    } else {
      await transition(db, j, 'in_progress', req.user!.id, { event: { reason: b.reason } });
    }
    return j;
  });
  await notify({ userId: job.technician_id, type: 'job.completion_rejected', title: b.dispute ? 'Dispute opened' : 'Customer says work is not finished', body: b.reason.slice(0, 140), data: { jobId: job.id } });
  res.json({ ok: true });
});

/** Cancel. Before work starts any held payment is refunded in full. */
jobs.post('/:id/cancel', async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const job = await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertParticipant(j, req.user!.id, req.user!.role);
    if (['in_progress', 'awaiting_confirmation'].includes(j.status)) {
      throw conflict('WORK_STARTED', 'Work has started — open a dispute instead of cancelling');
    }
    const held = await one<any>(`SELECT id, amount_minor FROM payments WHERE job_id = $1 AND purpose = 'job' AND status = 'held'`, [j.id], db);
    if (held) await refundPayment(db, held.id, held.amount_minor, `Refund: job #${j.short_code} cancelled`);
    if (j.kind === 'construction') {
      // Consultancy fee: refunded if the visit hasn't happened, earned by the technician once it has (Section 17).
      const { consultationFor, heldPayment, releaseConsultancy } = await import('../services/construction.ts');
      const c = await consultationFor(db, j.id);
      if (c?.status === 'paid') {
        const p = await heldPayment(db, { purpose: 'consultancy', jobId: j.id });
        if (p) await refundPayment(db, p.id, p.amount_minor, `Refund: site visit cancelled, job #${j.short_code}`);
        await query(`UPDATE site_consultations SET status = 'cancelled', refunded_minor = $2 WHERE id = $1`, [c.id, p?.amount_minor ?? 0], db);
      } else if (c?.status === 'visited') {
        await releaseConsultancy(db, c.id, await getSettings(), req.user!.id);
      }
      const funded = await one(`SELECT 1 FROM milestones WHERE job_id = $1 AND status IN ('funded', 'awaiting_confirmation', 'disputed')`, [j.id], db);
      if (funded) throw conflict('MILESTONE_FUNDED', 'A milestone is funded — open a dispute instead of cancelling');
      await query(`UPDATE milestones SET status = 'cancelled' WHERE job_id = $1 AND status IN ('proposed', 'pending')`, [j.id], db);
    }
    await query('UPDATE jobs SET cancel_reason = $2, cancelled_by = $3 WHERE id = $1', [j.id, b.reason, req.user!.id], db);
    await transition(db, j, 'cancelled', req.user!.id, { event: { reason: b.reason, refunded: !!held } });
    return j;
  });
  const other = req.user!.id === job.customer_id ? job.technician_id : job.customer_id;
  await notify({ userId: other, type: 'job.cancelled', title: `Job #${job.short_code} cancelled`, body: b.reason, data: { jobId: job.id } });
  res.json({ ok: true });
});

jobs.post('/:id/disputes', async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(2000), quoteItemId: id.optional() }), req.body);
  await tx(async (db) => {
    const j = await getJob(parse(id, req.params.id), db, true);
    assertParticipant(j, req.user!.id, req.user!.role);
    if (!['funded', 'en_route', 'in_progress', 'awaiting_confirmation'].includes(j.status)) {
      throw conflict('NOT_DISPUTABLE', 'Disputes can be opened on funded jobs only');
    }
    if (b.quoteItemId) {
      const ok = await one('SELECT 1 FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE qi.id = $1 AND q.job_id = $2', [b.quoteItemId, j.id], db);
      if (!ok) throw badRequest('BAD_LINE', 'Line item is not on this job');
    }
    await query('INSERT INTO disputes (job_id, quote_item_id, raised_by, reason) VALUES ($1,$2,$3,$4)', [j.id, b.quoteItemId ?? null, req.user!.id, b.reason], db);
    await transition(db, j, 'disputed', req.user!.id, { event: { reason: b.reason } });
  });
  res.status(201).json({ ok: true });
});
