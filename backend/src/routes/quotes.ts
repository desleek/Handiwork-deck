import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../db/pool.ts';
import { evaluateLaborOnlyRejection, windowStart } from '../domain/laborOnly.ts';
import { applyNegotiatedLabor, computeTotals, laborOnlyItems } from '../domain/pricing.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { schedulePriceChallenge } from '../queue/queues.ts';
import { assertCustomer, assertTechnician, getJob, logJobEvent, setActionRequired, transition } from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { resolveChallengeInCustomerFavour } from '../services/priceChallenges.ts';
import {
  approvedExceptionCaps,
  assertPriceable,
  currentContext,
  frozenOf,
  insertQuote,
  itemsToInputs,
  liveQuote,
  presentQuote,
  price,
  quoteItems,
} from '../services/quotes.ts';
import { refreshTechnicianRating } from '../services/ratings.ts';
import { getSettings } from '../services/settings.ts';

export const quotes = Router({ mergeParams: true });
quotes.use(authenticate, requireUser());
// Quotes, labor-only, price challenges and labor negotiation are standard-job flows only.
quotes.use(async (req: Request, _res: Response, next: NextFunction) => {
  const j = await one<{ kind: string }>('SELECT kind FROM jobs WHERE id = $1', [req.params.id]).catch(() => undefined);
  if (j?.kind === 'construction') return next(conflict('USE_CONSTRUCTION_FLOW', 'Construction projects use the BOQ flow'));
  next();
});

const uuid = z.string().uuid();
const jobIdOf = (req: any) => parse(uuid, req.params.id);

const ItemSchema = z.object({
  kind: z.enum(['labor', 'part']),
  description: z.string().trim().min(2).max(300),
  quantity: z.number().positive().max(100_000),
  unitCostMinor: z.number().int().nonnegative(),
  markupBps: z.number().int().min(0).max(100_000).optional(),
  receiptUrl: z.string().url().optional(),
  sellerId: uuid.optional(),
});

/**
 * Submit an itemized quote (Section 5). Labor lines carry the technician's standard rate; the
 * performance multiplier is applied server-side and frozen into the quote.
 * Markup above the cap is rejected (422) unless a Demand Notice is attached for every such line,
 * in which case the quote goes to "pending exception" for admin review (Section 5a).
 */
quotes.post('/quotes', requireUser('technician'), async (req, res) => {
  const b = parse(
    z.object({
      items: z.array(ItemSchema).min(1).max(100),
      notes: z.string().max(2000).optional(),
      capExceptions: z
        .array(
          z.object({
            position: z.number().int().min(1),
            requestedMarkupBps: z.number().int().positive(),
            reason: z.string().trim().min(10).max(2000),
            evidenceUrls: z.array(z.string().url()).min(1).max(10),
          }),
        )
        .default([]),
    }),
    req.body,
  );
  const s = await getSettings();
  const result = await tx(async (db) => {
    const job = await getJob(jobIdOf(req), db, true);
    assertTechnician(job, req.user!.id);
    if (!['accepted', 'quoted', 'negotiating'].includes(job.status)) throw conflict('CANNOT_QUOTE', `Cannot quote a ${job.status} job`);

    const { frozen, receiptThresholdMinor } = await currentContext(db, job.technician_id, s);
    const priced = price(b.items, frozen, receiptThresholdMinor);
    assertPriceable(priced, true);

    const overCap = priced.issues.filter((i) => i.code === 'MARKUP_OVER_CAP');
    for (const issue of overCap) {
      const ex = b.capExceptions.find((e) => e.position === issue.position);
      const line = priced.lines[issue.position - 1];
      if (!ex || ex.requestedMarkupBps < line.markupBps) {
        throw conflict('MARKUP_OVER_CAP', `Line ${issue.position} is above the ${issue.capBps! / 100}% markup cap. Lower it or request a cap exception.`, overCap);
      }
    }
    const pendingException = overCap.length > 0;
    const { quote, items } = await insertQuote(db, {
      jobId: job.id,
      technicianId: job.technician_id,
      status: pendingException ? 'pending_exception' : 'submitted',
      frozen,
      lines: priced.lines,
      totals: priced.totals,
      notes: b.notes,
    });

    for (const issue of overCap) {
      const ex = b.capExceptions.find((e) => e.position === issue.position)!;
      await query(
        `INSERT INTO markup_exceptions (job_id, quote_id, quote_item_id, technician_id, requested_markup_bps, reason, evidence_urls)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [job.id, quote.id, items[issue.position - 1].id, job.technician_id, ex.requestedMarkupBps, ex.reason, ex.evidenceUrls],
        db,
      );
    }
    await logJobEvent(db, job.id, req.user!.id, 'quote.submitted', {
      quoteId: quote.id,
      version: quote.version,
      totals: priced.totals,
      capExceptionsRequested: overCap.length,
    });
    if (pendingException) {
      await setActionRequired(db, job.id, 'admin', 'Markup cap exception under review');
    } else if (job.status === 'accepted') {
      await transition(db, job, 'quoted', req.user!.id);
    } else {
      await setActionRequired(db, job.id, 'customer', 'Review the revised quote');
    }
    return { job, quote, items, pendingException };
  });

  await notify({
    userId: result.job.customer_id,
    type: result.pendingException ? 'quote.under_review' : 'quote.received',
    title: result.pendingException ? 'Quote under review' : 'New quote',
    body: result.pendingException
      ? `The quote for job #${result.job.short_code} includes a parts markup above the usual cap and is being reviewed by Handiwork-Deck.`
      : `Your itemized quote for job #${result.job.short_code} is ready.`,
    data: { jobId: result.job.id },
  });
  res.status(201).json(presentQuote(result.quote, result.items, 'technician'));
});

/** Live quote preview for the technician while composing (no side effects). */
quotes.post('/quotes/preview', requireUser('technician'), async (req, res) => {
  const b = parse(z.object({ items: z.array(ItemSchema).min(1).max(100) }), req.body);
  const s = await getSettings();
  const job = await getJob(jobIdOf(req));
  assertTechnician(job, req.user!.id);
  const { frozen, receiptThresholdMinor } = await currentContext(pool, job.technician_id, s);
  res.json(price(b.items, frozen, receiptThresholdMinor));
});

// ---------------------------------------------------------------------------
// 6b — labor-only counter
// ---------------------------------------------------------------------------
quotes.post('/labor-only', requireUser('customer'), async (req, res) => {
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    if (j.status !== 'quoted') throw conflict('NOT_QUOTED', 'A labor-only counter needs a submitted quote');
    const q = await liveQuote(db, j.id);
    if (q.labor_only) throw conflict('ALREADY_LABOR_ONLY', 'This quote is already labor-only');
    const stance = await one<{ labor_only_stance: string }>(
      'SELECT labor_only_stance FROM technician_categories WHERE technician_id = $1 AND category_id = $2',
      [j.technician_id, j.category_id],
      db,
    );
    await query(
      `INSERT INTO labor_only_requests (job_id, quote_id, technician_id, category_id, stance_at_request) VALUES ($1,$2,$3,$4,$5)`,
      [j.id, q.id, j.technician_id, j.category_id, stance!.labor_only_stance],
      db,
    );
    await transition(db, j, 'negotiating', req.user!.id, { actionFrom: 'technician', actionReason: 'Respond to labor-only request', event: { kind: 'labor_only' } });
    return j;
  });
  await notify({ userId: job.technician_id, type: 'labor_only.requested', title: 'Labor-only request', body: `The customer on job #${job.short_code} will supply parts and asks for a labor-only price.`, data: { jobId: job.id } });
  res.status(201).json({ ok: true });
});

quotes.post('/labor-only/respond', requireUser('technician'), async (req, res) => {
  const b = parse(z.object({ accept: z.boolean() }), req.body);
  const s = await getSettings();
  const outcome = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    const r = await one<any>(`SELECT * FROM labor_only_requests WHERE job_id = $1 AND status = 'pending' FOR UPDATE`, [j.id], db);
    if (!r) throw notFound('Pending labor-only request');

    if (b.accept) {
      const q = await liveQuote(db, j.id);
      const caps = await approvedExceptionCaps(db, j.id);
      const inputs = laborOnlyItems(itemsToInputs(await quoteItems(db, q.id), caps));
      const priced = price(inputs, frozenOf(q), s.receiptThresholdMinor);
      assertPriceable(priced, false);
      await insertQuote(db, { jobId: j.id, technicianId: j.technician_id, status: 'submitted', frozen: frozenOf(q), lines: priced.lines, totals: priced.totals, notes: q.notes, laborOnly: true });
      await query(`UPDATE labor_only_requests SET status = 'accepted', responded_at = now() WHERE id = $1`, [r.id], db);
      await transition(db, j, 'quoted', req.user!.id, { event: { kind: 'labor_only_accepted' } });
      return { j, accepted: true, penalty: false };
    }

    // Rejection: free if declared "decline from inception" for this category; otherwise counted.
    const prior = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM labor_only_requests
        WHERE technician_id = $1 AND category_id = $2 AND counts_as_rejection AND responded_at >= $3`,
      [j.technician_id, j.category_id, windowStart(new Date(), s.laborOnlyRejectionWindowDays)],
      db,
    );
    const ev = evaluateLaborOnlyRejection(r.stance_at_request, prior!.n, s.laborOnlyRejectionCap);
    await query(
      `UPDATE labor_only_requests SET status = 'rejected', responded_at = now(), counts_as_rejection = $2, penalty_applied = $3 WHERE id = $1`,
      [r.id, ev.countsAsRejection, ev.penaltyApplies],
      db,
    );
    if (ev.penaltyApplies) {
      await refreshTechnicianRating(db, j.technician_id);
      await query(
        `INSERT INTO admin_audit_log (action, target_type, target_id, after) VALUES ('flag.labor_only_rejections', 'technician', $1, $2)`,
        [j.technician_id, JSON.stringify({ categoryId: j.category_id, rejectionsInWindow: ev.rejectionsInWindow })],
        db,
      );
    }
    await transition(db, j, 'quoted', req.user!.id, { event: { kind: 'labor_only_rejected', counted: ev.countsAsRejection } });
    return { j, accepted: false, penalty: ev.penaltyApplies };
  });
  await notify({
    userId: outcome.j.customer_id,
    type: 'labor_only.response',
    title: outcome.accepted ? 'Labor-only quote ready' : 'Labor-only request declined',
    body: outcome.accepted ? `A labor-only quote for job #${outcome.j.short_code} is ready.` : `The technician kept the original quote for job #${outcome.j.short_code}.`,
    data: { jobId: outcome.j.id },
  });
  res.json({ accepted: outcome.accepted });
});

// ---------------------------------------------------------------------------
// 6c — price challenge (parts, pre-job)
// ---------------------------------------------------------------------------
quotes.post('/price-challenges', requireUser('customer'), async (req, res) => {
  const b = parse(
    z
      .object({
        quoteItemId: uuid,
        sellerId: uuid.optional(),
        unlistedSellerName: z.string().trim().min(2).max(200).optional(),
        evidenceUrl: z.string().url(),
        claimedUnitCostMinor: z.number().int().nonnegative(),
        fastTrack: z.boolean().optional(),
      })
      .refine((v) => !!v.sellerId !== !!v.unlistedSellerName, 'Provide either a registered seller or the name of an unlisted seller'),
    req.body,
  );
  const s = await getSettings();
  const created = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    if (!['quoted', 'negotiating'].includes(j.status)) throw conflict('NOT_QUOTED', 'Price challenges apply to submitted quotes before the job starts');
    const q = await liveQuote(db, j.id);
    const item = await one<any>(`SELECT * FROM quote_items WHERE id = $1 AND quote_id = $2`, [b.quoteItemId, q.id], db);
    if (!item || item.kind !== 'part') throw badRequest('NOT_A_PART', 'Only parts prices can be challenged');
    if (b.claimedUnitCostMinor >= item.unit_cost_minor) throw badRequest('NOT_LOWER', 'Your evidence price must be lower than the quoted base cost');

    let status: 'open' | 'pending_evidence_review' = 'open';
    if (b.sellerId) {
      const seller = await one<{ verification_status: string }>('SELECT verification_status FROM parts_sellers WHERE id = $1 AND merged_into IS NULL', [b.sellerId], db);
      // Evidence from flagged/removed or unknown sellers is rejected at upload (Section 6c).
      if (!seller || !['provisional', 'verified'].includes(seller.verification_status)) {
        throw badRequest('SELLER_NOT_VERIFIED', 'Evidence must come from a registered spare-parts seller');
      }
    } else {
      // Unlisted seller → case-by-case admin review instead of automatic rejection (Section 10).
      status = 'pending_evidence_review';
    }
    const fastTrack = b.fastTrack ?? j.is_fast_track;
    const c = await one<any>(
      `INSERT INTO price_challenges (job_id, quote_id, quote_item_id, customer_id, technician_id, seller_id, unlisted_seller_name,
          evidence_url, claimed_unit_cost_minor, is_fast_track, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [j.id, q.id, item.id, j.customer_id, j.technician_id, b.sellerId ?? null, b.unlistedSellerName ?? null, b.evidenceUrl, b.claimedUnitCostMinor, fastTrack, status],
      db,
    );
    if (j.status !== 'negotiating') {
      await transition(db, j, 'negotiating', req.user!.id, {
        actionFrom: status === 'open' ? 'technician' : 'admin',
        actionReason: status === 'open' ? 'Respond to price challenge' : 'Review price evidence',
        event: { kind: 'price_challenge', challengeId: c.id, fastTrack },
      });
    } else {
      await setActionRequired(db, j.id, status === 'open' ? 'technician' : 'admin', status === 'open' ? 'Respond to price challenge' : 'Review price evidence');
    }
    return { c, j };
  });
  if (created.c.status === 'open') {
    await schedulePriceChallenge(created.c.id, created.c.submitted_at, created.c.is_fast_track ? s.priceChallengeFastTrack : s.priceChallengeStandard, created.c.is_fast_track);
  }
  res.status(201).json(created.c);
});

quotes.post('/price-challenges/:challengeId/respond', requireUser('technician'), async (req, res) => {
  const b = parse(
    z.object({ response: z.enum(['match', 'explain', 'hold']), note: z.string().trim().max(2000).optional() }).refine(
      (v) => v.response === 'match' || (v.note && v.note.length >= 10),
      'Explain your price (at least 10 characters) when not matching',
    ),
    req.body,
  );
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    const c = await one<any>(`SELECT * FROM price_challenges WHERE id = $1 AND job_id = $2 FOR UPDATE`, [parse(uuid, req.params.challengeId), j.id], db);
    if (!c) throw notFound('Price challenge');
    if (!['open', 'escalated'].includes(c.status)) throw conflict('CLOSED', 'This challenge is already resolved');
    await query(`UPDATE price_challenges SET technician_response = $2, response_note = $3, responded_at = now() WHERE id = $1`, [c.id, b.response, b.note ?? null], db);
    if (b.response === 'match') {
      await resolveChallengeInCustomerFavour(db, c, req.user!.id, 'matched');
    } else {
      await query(`UPDATE price_challenges SET status = $2, resolved_at = now() WHERE id = $1`, [c.id, b.response === 'explain' ? 'explained' : 'held_firm'], db);
      await transition(db, j, 'quoted', req.user!.id, { event: { kind: `price_challenge_${b.response}`, challengeId: c.id } });
    }
    return j;
  });
  await notify({
    userId: job.customer_id,
    type: 'price_challenge.response',
    title: 'Price challenge answered',
    body: b.response === 'match' ? `The technician matched your price on job #${job.short_code}.` : `The technician responded to your challenge on job #${job.short_code}: ${(b.note ?? '').slice(0, 100)}`,
    data: { jobId: job.id },
  });
  res.json({ ok: true });
});

quotes.post('/price-challenges/:challengeId/withdraw', requireUser('customer'), async (req, res) => {
  await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    const r = await query(
      `UPDATE price_challenges SET status = 'withdrawn', resolved_at = now()
        WHERE id = $1 AND job_id = $2 AND status IN ('open', 'escalated', 'pending_evidence_review') RETURNING id`,
      [parse(uuid, req.params.challengeId), j.id],
      db,
    );
    if (!r.length) throw notFound('Open price challenge');
    if (j.status === 'negotiating') await transition(db, j, 'quoted', req.user!.id, { event: { kind: 'price_challenge_withdrawn' } });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 6d — labor cost negotiation (job-scoped; never changes the public rate)
// ---------------------------------------------------------------------------
quotes.post('/labor-negotiation', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ proposedLaborMinor: z.number().int().positive() }), req.body);
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    if (j.status !== 'quoted') throw conflict('NOT_QUOTED', 'Negotiate after a quote is submitted');
    const q = await liveQuote(db, j.id);
    if (b.proposedLaborMinor >= q.labor_total_minor) throw badRequest('NOT_LOWER', 'Propose a labor amount below the current standard rate');
    await query(
      `INSERT INTO labor_negotiations (job_id, quote_id, standard_labor_minor, proposed_labor_minor) VALUES ($1,$2,$3,$4)`,
      [j.id, q.id, q.labor_total_minor, b.proposedLaborMinor],
      db,
    );
    await transition(db, j, 'negotiating', req.user!.id, { actionFrom: 'technician', actionReason: 'Respond to labor offer', event: { kind: 'labor_negotiation', proposed: b.proposedLaborMinor } });
    return j;
  });
  await notify({ userId: job.technician_id, type: 'labor_negotiation.offer', title: 'Labor price offer', body: `The customer on job #${job.short_code} proposed a different labor price.`, data: { jobId: job.id } });
  res.status(201).json({ ok: true });
});

async function applyAgreedLabor(db: any, jobId: string, technicianId: string, amount: number) {
  const s = await getSettings();
  const q = await liveQuote(db, jobId);
  const caps = await approvedExceptionCaps(db, jobId);
  const priced = price(itemsToInputs(await quoteItems(db, q.id), caps), frozenOf(q), s.receiptThresholdMinor);
  const lines = applyNegotiatedLabor(priced.lines, amount);
  await insertQuote(db, { jobId, technicianId, status: 'submitted', frozen: frozenOf(q), lines, totals: computeTotals(lines, frozenOf(q)), notes: q.notes, laborOnly: q.labor_only });
}

quotes.post('/labor-negotiation/respond', requireUser('technician'), async (req, res) => {
  const b = parse(
    z.object({ action: z.enum(['accept', 'counter', 'decline']), counterLaborMinor: z.number().int().positive().optional() }).refine(
      (v) => v.action !== 'counter' || v.counterLaborMinor,
      'counterLaborMinor is required to counter',
    ),
    req.body,
  );
  const job = await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertTechnician(j, req.user!.id);
    const n = await one<any>(`SELECT * FROM labor_negotiations WHERE job_id = $1 AND status = 'pending' FOR UPDATE`, [j.id], db);
    if (!n) throw notFound('Pending labor offer');
    if (b.action === 'accept') {
      await applyAgreedLabor(db, j.id, j.technician_id, n.proposed_labor_minor);
      await query(`UPDATE labor_negotiations SET status = 'accepted', final_labor_minor = proposed_labor_minor, updated_at = now() WHERE id = $1`, [n.id], db);
      await transition(db, j, 'quoted', req.user!.id, { event: { kind: 'labor_negotiation_accepted', amount: n.proposed_labor_minor } });
    } else if (b.action === 'decline') {
      await query(`UPDATE labor_negotiations SET status = 'declined', final_labor_minor = standard_labor_minor, updated_at = now() WHERE id = $1`, [n.id], db);
      await transition(db, j, 'quoted', req.user!.id, { event: { kind: 'labor_negotiation_declined' } });
    } else {
      if (b.counterLaborMinor! <= n.proposed_labor_minor || b.counterLaborMinor! >= n.standard_labor_minor) {
        throw badRequest('INVALID_COUNTER', 'A counter must sit between the customer offer and your standard rate');
      }
      await query(`UPDATE labor_negotiations SET status = 'countered', counter_labor_minor = $2, updated_at = now() WHERE id = $1`, [n.id, b.counterLaborMinor], db);
      await setActionRequired(db, j.id, 'customer', 'Respond to the labor counter-offer');
      await logJobEvent(db, j.id, req.user!.id, 'labor_negotiation.countered', { amount: b.counterLaborMinor });
    }
    return j;
  });
  await notify({ userId: job.customer_id, type: 'labor_negotiation.response', title: 'Labor offer answered', body: `The technician responded to your labor offer on job #${job.short_code}.`, data: { jobId: job.id } });
  res.json({ ok: true });
});

quotes.post('/labor-negotiation/counter-response', requireUser('customer'), async (req, res) => {
  const b = parse(z.object({ accept: z.boolean() }), req.body);
  await tx(async (db) => {
    const j = await getJob(jobIdOf(req), db, true);
    assertCustomer(j, req.user!.id);
    const n = await one<any>(`SELECT * FROM labor_negotiations WHERE job_id = $1 AND status = 'countered' FOR UPDATE`, [j.id], db);
    if (!n) throw notFound('Counter-offer');
    if (b.accept) await applyAgreedLabor(db, j.id, j.technician_id, n.counter_labor_minor);
    await query(
      `UPDATE labor_negotiations SET status = $2, final_labor_minor = $3, updated_at = now() WHERE id = $1`,
      [n.id, b.accept ? 'counter_accepted' : 'counter_rejected', b.accept ? n.counter_labor_minor : n.standard_labor_minor],
      db,
    );
    await transition(db, j, 'quoted', req.user!.id, { event: { kind: b.accept ? 'labor_counter_accepted' : 'labor_counter_rejected' } });
  });
  res.json({ ok: true });
});

/** Technician view of their quotes' pending exceptions. */
quotes.get('/cap-exceptions', async (req, res) => {
  const job = await getJob(jobIdOf(req));
  if (job.technician_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden('NOT_ALLOWED', 'Not allowed');
  res.json(await query('SELECT * FROM markup_exceptions WHERE job_id = $1 ORDER BY created_at DESC', [job.id]));
});
