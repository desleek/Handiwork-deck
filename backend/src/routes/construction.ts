import express, { Router } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../db/pool.ts';
import { detectSource, parseBoqFile } from '../domain/boqParse.ts';
import { bandFor, canFundMilestone, checkConsultancyFee, noShowDecision } from '../domain/construction.ts';
import { badRequest, conflict, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import {
  assertBoqValid,
  consultationFor,
  heldPayment,
  priceForJob,
  releaseConsultancy,
  releaseMilestone,
  saveBoqVersion,
} from '../services/construction.ts';
import { assertCustomer, assertParticipant, assertTechnician, getJob, logJobEvent, setActionRequired, transition, type JobRow } from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { refundPayment, startPayment } from '../services/payments/escrow.ts';
import { getSettings } from '../services/settings.ts';

/** Section 17 — construction & plant erection, mounted at /jobs/:id/construction. */
export const construction = Router({ mergeParams: true });
construction.use(authenticate, requireUser());

const uuid = z.string().uuid();
const jobIdOf = (req: any) => parse(uuid, req.params.id);

function assertConstruction(job: JobRow) {
  if (job.kind !== 'construction') throw conflict('NOT_CONSTRUCTION', 'This job is not a construction project');
}

async function categoryBand(categoryId: string) {
  const s = await getSettings();
  const c = await one<{ slug: string }>('SELECT slug FROM service_categories WHERE id = $1', [categoryId]);
  return { band: bandFor(c?.slug ?? '', s.consultancyFeeBands, s.consultancyDefaultBand), s };
}

/** Everything the app needs for a construction project: consultation, current BOQ, milestones, history. */
construction.get('/', async (req, res) => {
  const job = await getJob(jobIdOf(req));
  assertParticipant(job, req.user!.id, req.user!.role);
  assertConstruction(job);
  const viewer = req.user!.role === 'admin' ? 'admin' : job.customer_id === req.user!.id ? 'customer' : 'technician';
  const { band } = await categoryBand(job.category_id);
  const consultation = await consultationFor(pool, job.id);
  const boqs = await query<any>(
    `SELECT id, version, source, parse_status, parse_warnings, status, grand_total_minor, labor_total_minor, materials_total_minor,
            markup_total_minor, applied_multiplier_bps, notes, customer_note, submitted_at, decided_at, created_at
       FROM boqs WHERE job_id = $1 ORDER BY version DESC`,
    [job.id],
  );
  // Customers never see drafts — an unreviewed parse must not reach them (Section 17, Step 2).
  const visible = viewer === 'customer' ? boqs.filter((b) => b.status !== 'draft') : boqs;
  const current = visible.find((b) => b.status !== 'superseded') ?? null;
  const items = current ? await query('SELECT * FROM boq_items WHERE boq_id = $1 ORDER BY position', [current.id]) : [];
  const milestones = current
    ? await query(`SELECT * FROM milestones WHERE boq_id = $1 AND status <> 'cancelled' ORDER BY position`, [current.id])
    : [];
  res.json({
    viewer,
    consultation,
    consultancyBand: band,
    boq: current
      ? {
          ...current,
          // Platform commission is the technician's cost; customers see what's included, never a hidden lump sum.
          items,
          milestones: milestones.map((m: any) =>
            viewer === 'customer'
              ? { id: m.id, position: m.position, title: m.title, status: m.status, labor_minor: m.labor_minor, parts_base_minor: m.parts_base_minor, markup_minor: m.markup_minor, total_minor: m.total_minor, funded_at: m.funded_at, completed_at: m.completed_at, released_at: m.released_at }
              : m,
          ),
        }
      : null,
    history: visible.map(({ id, version, status, grand_total_minor, submitted_at }) => ({ id, version, status, grand_total_minor, submitted_at })),
  });
});

// ------------------------------------------------------------------------------- Step 1: consultation

construction.post('/consultation/quote', requireUser('technician'), async (req, res) => {
  const b = parse(z.object({ feeMinor: z.number().int().positive(), proposedVisitAt: z.coerce.date(), note: z.string().max(1000).optional() }), req.body);
  if (b.proposedVisitAt.getTime() < Date.now()) throw badRequest('VISIT_IN_PAST', 'Choose a visit time in the future');
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    assertConstruction(j);
    const { band } = await categoryBand(j.category_id);
    const check = checkConsultancyFee(b.feeMinor, band);
    if (!check.ok) throw badRequest('FEE_OUT_OF_BAND', check.message, band);
    const existing = await consultationFor(db, j.id);
    if (existing && existing.status !== 'quoted') throw conflict('ALREADY_PAID', 'The consultation is already paid');
    if (existing) {
      await query(`UPDATE site_consultations SET fee_minor = $2, proposed_visit_at = $3, visit_at = $3, note = $4 WHERE id = $1`, [existing.id, b.feeMinor, b.proposedVisitAt, b.note ?? null], db);
    } else {
      await query(
        `INSERT INTO site_consultations (job_id, technician_id, fee_minor, proposed_visit_at, visit_at, note) VALUES ($1,$2,$3,$4,$4,$5)`,
        [j.id, j.technician_id, b.feeMinor, b.proposedVisitAt, b.note ?? null],
        db,
      );
    }
    if (j.status === 'requested') await transition(db, j, 'accepted', req.user!.id, { actionFrom: 'customer', actionReason: 'Pay the site consultation fee', event: { feeMinor: b.feeMinor } });
    else await setActionRequired(db, j.id, 'customer', 'Pay the site consultation fee');
    await logJobEvent(db, j.id, req.user!.id, 'consultancy.quoted', { feeMinor: b.feeMinor, visitAt: b.proposedVisitAt });
    return j;
  });
  await notify({ userId: job.customer_id, type: 'construction.consultation_quoted', title: 'Site visit fee', body: `Your technician quoted a site inspection for job #${job.short_code}. Pay to confirm the visit.`, data: { jobId: job.id } });
  res.status(201).json({ ok: true });
});

construction.post('/consultation/pay', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['card', 'bank_transfer', 'ussd', 'wallet']) }), req.body);
  const job = await getJob(jobIdOf(req));
  assertCustomer(job, req.user!.id);
  assertConstruction(job);
  const c = await one<any>('SELECT * FROM site_consultations WHERE job_id = $1', [job.id]);
  if (!c || c.status !== 'quoted' || job.status !== 'accepted') throw conflict('NOT_PAYABLE', 'There is no consultation fee to pay');
  const s = await getSettings();
  res.status(201).json(
    await startPayment({ payer: req.user!, purpose: 'consultancy', amountMinor: c.fee_minor, currency: s.currency, channel: b.channel, description: `Site consultation #${job.short_code}`, jobId: job.id }),
  );
});

construction.post('/consultation/visited', requireUser('technician'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    const c = await consultationFor(db, j.id);
    if (!c || c.status !== 'paid') throw conflict('NOT_PAID', 'The consultation has not been paid');
    await query(`UPDATE site_consultations SET status = 'visited', visited_at = now() WHERE id = $1`, [c.id], db);
    await setActionRequired(db, j.id, 'technician', 'Prepare and submit the Bill of Quantities');
    await logJobEvent(db, j.id, req.user!.id, 'consultancy.visited', {});
    return j;
  });
  await notify({ userId: job.customer_id, type: 'construction.visited', title: 'Site visit done', body: `Your technician has inspected the site for #${job.short_code} and is preparing the Bill of Quantities.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

/** Customer reports the technician didn't show up (refundable by default; disputed if the technician says they came). */
construction.post('/consultation/no-show', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ note: z.string().max(1000).optional() }), req.body ?? {});
  const s = await getSettings();
  const outcome = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    const c = await consultationFor(db, j.id);
    if (!c) throw notFound('Consultation');
    const decision = noShowDecision({ status: c.status, visitAt: c.visit_at, visitedAt: c.visited_at, now: new Date(), graceHours: s.consultancyNoShowGraceHours, refundOnNoShow: s.consultancyRefundOnNoShow });
    if (decision === 'invalid') throw conflict('NOT_APPLICABLE', 'There is no paid visit to report');
    if (decision === 'too_early') throw conflict('TOO_EARLY', `You can report a no-show ${s.consultancyNoShowGraceHours} hours after the agreed visit time`);
    if (decision === 'not_refundable') throw conflict('NOT_REFUNDABLE', 'Consultancy fees are not refundable. Contact support if there is a problem.');
    await query(`UPDATE site_consultations SET no_show_reported_at = now() WHERE id = $1`, [c.id], db);
    if (decision === 'refund') {
      const p = await heldPayment(db, { purpose: 'consultancy', jobId: j.id });
      if (p) await refundPayment(db, p.id, p.amount_minor, `Refund: technician no-show, job #${j.short_code}`);
      await query(`UPDATE site_consultations SET status = 'refunded', refunded_minor = $2 WHERE id = $1`, [c.id, p?.amount_minor ?? 0], db);
      await transition(db, j, 'cancelled', req.user!.id, { actionFrom: 'none', actionReason: '', event: { reason: 'technician_no_show' } });
      return { j, decision };
    }
    // Technician already marked the visit done: admin decides.
    await query(`UPDATE site_consultations SET status = 'disputed' WHERE id = $1`, [c.id], db);
    await query('INSERT INTO disputes (job_id, raised_by, reason) VALUES ($1,$2,$3)', [j.id, req.user!.id, `Consultation no-show disputed. ${b.note ?? ''}`.trim()], db);
    await transition(db, j, 'disputed', req.user!.id, { actionFrom: 'admin', actionReason: 'Resolve consultation no-show dispute' });
    return { j, decision };
  });
  await notify({ userId: outcome.j.technician_id, type: 'construction.no_show', title: outcome.decision === 'refund' ? 'Site visit refunded' : 'Site visit disputed', body: outcome.decision === 'refund' ? `The customer reported a no-show for #${outcome.j.short_code}; the fee was refunded.` : `The customer says the visit for #${outcome.j.short_code} didn't happen. Support will review.`, data: { jobId: outcome.j.id } });
  res.json({ outcome: outcome.decision });
});

// ------------------------------------------------------------------------------- Step 2: BOQ

const BoqItem = z.object({
  kind: z.enum(['labor', 'part']),
  description: z.string().trim().min(2).max(300),
  unit: z.string().trim().max(20),
  quantity: z.number().positive().max(10_000_000),
  unitRateMinor: z.number().int().nonnegative(),
  markupBps: z.number().int().min(0).max(100_000).optional(),
  milestone: z.number().int().min(1),
});
const BoqBody = z.object({
  items: z.array(BoqItem).min(1).max(500),
  milestones: z.array(z.object({ title: z.string().trim().min(2).max(100) })).min(1),
  notes: z.string().max(4000).optional(),
});

/** Live preview while building — the same rules the submission enforces. */
construction.post('/boq/preview', requireUser('technician'), async (req, res) => {
  const b = parse(BoqBody, req.body);
  const job = await getJob(jobIdOf(req));
  assertTechnician(job, req.user!.id);
  const { priced } = await priceForJob(pool, job, b, await getSettings());
  res.json(priced);
});

/**
 * Upload an existing BOQ (Excel/CSV/Word/PDF) as raw bytes. It's parsed into a draft the technician
 * must review and correct before submitting. Word/PDF drafts are always marked for review.
 */
construction.post(
  '/boq/parse',
  requireUser('technician'),
  express.raw({ type: () => true, limit: '20mb' }),
  async (req, res) => {
    const filename = String(req.header('x-filename') ?? '');
    const source = detectSource(filename, req.header('content-type'));
    if (!source) throw badRequest('UNSUPPORTED_FILE', 'Upload an Excel (.xlsx), CSV, Word (.docx) or PDF file');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('EMPTY_FILE', 'The file is empty');
    const job = await getJob(jobIdOf(req));
    assertTechnician(job, req.user!.id);
    assertConstruction(job);

    let parsed: ReturnType<typeof parseBoqFile> | null = null;
    let error: string | null = null;
    try {
      parsed = parseBoqFile(body, source);
    } catch (e: any) {
      error = e?.message ?? 'Could not read the file';
    }
    const dbSource = source === 'csv' ? 'excel' : source;
    const draft = await tx(async (db) => {
      const v = await one<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM boqs WHERE job_id = $1', [job.id], db);
      const row = await one<{ id: string }>(
        `INSERT INTO boqs (job_id, version, source, technician_id, status, parse_status, parse_warnings)
         VALUES ($1,$2,$3,$4,'draft',$5,$6) RETURNING id`,
        [job.id, v!.v, dbSource, job.technician_id, error ? 'failed' : parsed!.needsReview ? 'needs_review' : 'parsed', JSON.stringify(error ? [error] : parsed!.warnings)],
        db,
      );
      if (parsed) {
        let pos = 0;
        for (const l of parsed.lines) {
          await query(
            `INSERT INTO boq_items (boq_id, kind, description, unit, quantity, unit_rate_minor, markup_bps, line_total_minor, position, source_row, flagged, milestone_position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
            [row!.id, l.kind, l.description, l.unit, l.quantity, l.unitRateMinor, l.markupBps, Math.round(l.quantity * l.unitRateMinor), ++pos, l.sourceRow, l.flag],
            db,
          );
        }
      }
      await logJobEvent(db, job.id, req.user!.id, 'boq.parsed', { draftId: row!.id, source, lines: parsed?.lines.length ?? 0, error });
      return row!;
    });
    if (error) throw badRequest('PARSE_FAILED', `${error}. You can enter the BOQ manually instead.`, { draftId: draft.id });
    res.status(201).json({
      draftId: draft.id,
      ...parsed,
      reviewRequired: true, // the builder always shows the parsed lines for confirmation before submitting
      // Suggest milestones from the file's own sections (e.g. Substructure / Superstructure).
      suggestedMilestones: [...new Set(parsed!.lines.map((l) => l.section).filter(Boolean))],
    });
  },
);

/** Submit a BOQ version with its milestones (from the builder or a reviewed upload draft). */
construction.post('/boq', requireUser('technician'), async (req, res) => {
  const b = parse(BoqBody.extend({ draftId: uuid.optional(), reviewedParsedLines: z.boolean().optional() }), req.body);
  if (b.draftId && !b.reviewedParsedLines) {
    throw badRequest('REVIEW_REQUIRED', 'Confirm you have checked every line parsed from the uploaded file');
  }
  const s = await getSettings();
  const out = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    assertConstruction(j);
    const c = await consultationFor(db, j.id);
    if (!c || c.status !== 'visited') throw conflict('VISIT_FIRST', 'Mark the site visit as done before submitting a BOQ');
    if (!['funded', 'negotiating'].includes(j.status)) throw conflict('CANNOT_SUBMIT', `Cannot submit a BOQ while the job is ${j.status}`);
    const { priced, frozen } = await priceForJob(db, j, b, s);
    assertBoqValid(priced);
    const draft = b.draftId ? await one<any>('SELECT source, source_file_url FROM boqs WHERE id = $1 AND job_id = $2', [b.draftId, j.id], db) : null;
    const boqId = await saveBoqVersion(db, { job: j, draftId: b.draftId, source: draft?.source ?? 'builder', sourceFileUrl: draft?.source_file_url, sub: b, priced, frozen });
    // The consultancy fee is earned once a BOQ is delivered.
    await releaseConsultancy(db, c.id, s, req.user!.id);
    await transition(db, j, 'quoted', req.user!.id, { actionFrom: 'customer', actionReason: 'Review the Bill of Quantities', event: { boqId, totalMinor: priced.totals.customerTotalMinor } });
    return { j, boqId, priced };
  });
  await notify({ userId: out.j.customer_id, type: 'construction.boq', title: 'Bill of Quantities ready', body: `Review the itemized BOQ and milestones for #${out.j.short_code}.`, data: { jobId: out.j.id } });
  res.status(201).json({ boqId: out.boqId, totals: out.priced.totals, milestones: out.priced.milestones });
});

// ------------------------------------------------------------------------------- Step 3: customer response

construction.post('/boq/respond', requireUser('customer'), async (req, res) => {
  const b = parse(
    z.object({
      action: z.enum(['approve', 'negotiate', 'reject']),
      note: z.string().max(4000).optional(),
      comments: z.array(z.object({ itemId: uuid, comment: z.string().trim().min(2).max(1000), proposedRateMinor: z.number().int().nonnegative().optional() })).default([]),
    }),
    req.body,
  );
  if (b.action === 'negotiate' && b.comments.length === 0 && !b.note) throw badRequest('COMMENTS_REQUIRED', 'Comment on at least one line, or add a note');
  const s = await getSettings();
  const out = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    const boq = await one<any>(`SELECT * FROM boqs WHERE job_id = $1 AND status = 'submitted' ORDER BY version DESC LIMIT 1 FOR UPDATE`, [j.id], db);
    if (!boq || j.status !== 'quoted') throw conflict('NOTHING_TO_REVIEW', 'There is no BOQ awaiting your response');
    if (b.action === 'approve') {
      await query(`UPDATE boqs SET status = 'approved', decided_at = now(), customer_note = $2 WHERE id = $1`, [boq.id, b.note ?? null], db);
      await query(`UPDATE milestones SET status = 'pending' WHERE boq_id = $1 AND status = 'proposed'`, [boq.id], db);
      const first = await one<any>(`SELECT position, title FROM milestones WHERE boq_id = $1 ORDER BY position LIMIT 1`, [boq.id], db);
      await transition(db, j, 'approved', req.user!.id, { actionFrom: 'customer', actionReason: `Fund milestone 1: ${first.title}`, event: { boqId: boq.id, totalMinor: boq.grand_total_minor } });
    } else if (b.action === 'negotiate') {
      for (const c of b.comments) {
        const r = await query(`UPDATE boq_items SET customer_comment = $3, proposed_rate_minor = $4 WHERE id = $1 AND boq_id = $2 RETURNING id`, [c.itemId, boq.id, c.comment, c.proposedRateMinor ?? null], db);
        if (!r.length) throw badRequest('BAD_LINE', 'A comment refers to a line that is not on this BOQ');
      }
      await query(`UPDATE boqs SET status = 'negotiating', customer_note = $2 WHERE id = $1`, [boq.id, b.note ?? null], db);
      await transition(db, j, 'negotiating', req.user!.id, { actionFrom: 'technician', actionReason: 'Revise the BOQ based on the customer\'s comments', event: { boqId: boq.id, comments: b.comments.length } });
    } else {
      // Rejected outright: job closes, consultancy fee is not refunded (Step 1 policy).
      await query(`UPDATE boqs SET status = 'rejected', decided_at = now(), customer_note = $2 WHERE id = $1`, [boq.id, b.note ?? null], db);
      await query(`UPDATE milestones SET status = 'cancelled' WHERE boq_id = $1`, [boq.id], db);
      const c = await consultationFor(db, j.id);
      if (c) await releaseConsultancy(db, c.id, s, req.user!.id);
      await query(`UPDATE jobs SET cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [j.id, b.note ?? 'BOQ rejected', req.user!.id], db);
      await transition(db, j, 'cancelled', req.user!.id, { actionFrom: 'none', actionReason: '', event: { reason: 'boq_rejected' } });
    }
    return j;
  });
  const msg = { approve: 'approved the BOQ', negotiate: 'asked for changes to the BOQ', reject: 'declined the BOQ' }[b.action];
  await notify({ userId: out.technician_id, type: `construction.boq_${b.action}`, title: 'BOQ response', body: `The customer ${msg} for #${out.short_code}.`, data: { jobId: out.id } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------------------- Step 4: milestones

async function milestoneOf(db: any, jobId: string, mid: string) {
  const m = await one<any>('SELECT * FROM milestones WHERE id = $1 AND job_id = $2 FOR UPDATE', [mid, jobId], db);
  if (!m) throw notFound('Milestone');
  return m;
}

construction.post('/milestones/:mid/fund', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['card', 'bank_transfer', 'ussd', 'wallet']) }), req.body);
  const job = await getJob(jobIdOf(req));
  assertCustomer(job, req.user!.id);
  const mid = parse(uuid, req.params.mid);
  const all = await query<{ id: string; position: number; status: string; total_minor: number; title: string }>(
    `SELECT id, position, status, total_minor, title FROM milestones
      WHERE boq_id = (SELECT boq_id FROM milestones WHERE id = $1) AND status <> 'cancelled' ORDER BY position`,
    [mid],
  );
  const m = all.find((x) => x.id === mid);
  if (!m) throw notFound('Milestone');
  if (!canFundMilestone(m.position, all)) throw conflict('FUND_IN_ORDER', 'Fund milestones in order, one at a time');
  const s = await getSettings();
  res.status(201).json(
    await startPayment({ payer: req.user!, purpose: 'milestone', amountMinor: m.total_minor, currency: s.currency, channel: b.channel, description: `Milestone ${m.position}: ${m.title} (#${job.short_code})`, jobId: job.id, milestoneId: m.id }),
  );
});

construction.post('/milestones/:mid/complete', requireUser('technician'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    const m = await milestoneOf(db, j.id, parse(uuid, req.params.mid));
    if (m.status !== 'funded') throw conflict('NOT_FUNDED', 'Only funded milestones can be marked complete');
    await query(`UPDATE milestones SET status = 'awaiting_confirmation', completed_at = now() WHERE id = $1`, [m.id], db);
    await setActionRequired(db, j.id, 'customer', `Confirm milestone ${m.position}: ${m.title}`);
    await logJobEvent(db, j.id, req.user!.id, 'milestone.completed', { milestoneId: m.id });
    return j;
  });
  await notify({ userId: job.customer_id, type: 'construction.milestone_complete', title: 'Milestone ready for sign-off', body: `Check the work on #${job.short_code} and confirm to release payment.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

construction.post('/milestones/:mid/confirm', requireUser('customer'), async (req, res) => {
  const out = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    const m = await milestoneOf(db, j.id, parse(uuid, req.params.mid));
    if (m.status !== 'awaiting_confirmation') throw conflict('NOT_READY', 'The technician has not marked this milestone complete');
    return releaseMilestone(db, m.id, req.user!.id);
  });
  await notify({ userId: out.job.technician_id, type: 'construction.milestone_released', title: 'Milestone paid', body: `Payment for "${out.milestone.title}" is in your wallet.`, data: { jobId: out.job.id } });
  res.json({ ok: true, projectCompleted: out.completed, reviewRequired: out.completed });
});

construction.post('/milestones/:mid/dispute', async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(2000) }), req.body);
  await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertParticipant(j, req.user!.id, req.user!.role);
    const m = await milestoneOf(db, j.id, parse(uuid, req.params.mid));
    if (!['funded', 'awaiting_confirmation'].includes(m.status)) throw conflict('NOT_DISPUTABLE', 'Only funded milestones can be disputed');
    await query(`UPDATE milestones SET status = 'disputed' WHERE id = $1`, [m.id], db);
    await query('INSERT INTO disputes (job_id, milestone_id, raised_by, reason) VALUES ($1,$2,$3,$4)', [j.id, m.id, req.user!.id, b.reason], db);
    await transition(db, j, 'disputed', req.user!.id, { actionFrom: 'admin', actionReason: `Resolve dispute on milestone ${m.position}` });
  });
  res.status(201).json({ ok: true });
});
