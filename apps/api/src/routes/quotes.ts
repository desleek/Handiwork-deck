import { COUNTER_KINDS, evaluateCounter, QUOTE_ITEM_KINDS, type QuoteItemInput, quoteTotals } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { afterTransition, type JobRecord, transitionJob } from '../services/jobs/lifecycle';
import { assignQuote, refreshQuoteTotals, writeQuoteItems } from '../services/jobs/quotes';
import { waDeepLink } from '../services/messaging/whatsapp';

/**
 * Itemized quotes and negotiation. A customer can approve a quote as-is or
 * counter it (labor-only, price challenge, or labor negotiation). The technician
 * accepts the counter (which hires them at the countered price), declines it,
 * or revises the quote.
 */
export const quotesRouter = Router();

const ItemBody = z.object({
  kind: z.enum(QUOTE_ITEM_KINDS.filter((k) => k !== 'adjustment') as ['labor', 'material', 'transport', 'other']),
  description: z.string().trim().min(2).max(200),
  quantity: z.number().positive().max(100_000).default(1),
  unitPriceMinor: z.number().int().min(0),
});

const QuoteBody = z.object({
  items: z.array(ItemBody).min(1).max(50),
  message: z.string().max(2000).optional(),
  etaMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
});

async function notify(userId: string, title: string, body: string, jobId: string, type: string) {
  await scheduler().notify(userId, { title, body, data: { jobId, type } });
}

quotesRouter.post('/jobs/:id/quotes', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(QuoteBody, req.body);
  const tech = currentUser(req);
  const { quote, job, promoted } = await tx(async (db) => {
    const job = await one('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId], db);
    if (!job) throw notFound('Job');
    if (job.status !== 'open' && job.status !== 'quoted') throw conflict('Job is no longer accepting quotes');
    if (job.awaiting_category_review) throw conflict('Job is awaiting review');
    if (job.target_technician_id && job.target_technician_id !== tech.id) throw forbidden('This job was requested from another technician');
    const eligible = await one(
      `SELECT 1 FROM technician_profiles tp JOIN technician_services ts ON ts.technician_id = tp.user_id AND ts.category_id = $2
        WHERE tp.user_id = $1 AND tp.verification_status = 'verified'`,
      [tech.id, job.category_id],
      db,
    );
    if (!eligible) throw forbidden('You must be verified and offer this service to quote');
    const quote = await one(
      `INSERT INTO quotes (job_id, technician_id, amount_minor, currency, message, eta_minutes)
       VALUES ($1, $2, 1, $3, $4, $5) RETURNING id`,
      [jobId, tech.id, job.currency, b.message ?? null, b.etaMinutes ?? null],
      db,
    );
    await writeQuoteItems(db, quote.id, b.items as QuoteItemInput[]);
    const promoted = job.status === 'open' ? await transitionJob(jobId, 'quoted', { id: null, role: 'system' }, { db, note: 'first quote received' }) : null;
    return { quote: await one('SELECT * FROM quotes WHERE id = $1', [quote.id], db), job, promoted };
  });
  if (promoted) await afterTransition(promoted);
  await notify(job.customer_id, 'New quote received', `${tech.full_name} quoted on "${job.title}"`, jobId, 'quote.new');
  res.status(201).json({ quote });
});

async function lockQuote(db: any, jobId: string, quoteId: string) {
  const q = await one(
    `SELECT q.*, j.customer_id, j.status AS job_status, j.title AS job_title, tp.labor_stance
       FROM quotes q JOIN jobs j ON j.id = q.job_id JOIN technician_profiles tp ON tp.user_id = q.technician_id
      WHERE q.id = $1 AND q.job_id = $2 FOR UPDATE OF q`,
    [quoteId, jobId],
    db,
  );
  if (!q) throw notFound('Quote');
  if (q.job_status !== 'quoted' && q.job_status !== 'open') throw conflict('This job is no longer open for negotiation');
  return q;
}

/** Technician revises their quote (e.g. after a declined counter). Any pending counter is superseded. */
quotesRouter.put('/jobs/:id/quotes/:quoteId', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const b = parse(QuoteBody, req.body);
  const tech = currentUser(req);
  const quote = await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.technician_id !== tech.id) throw forbidden('Not your quote');
    if (!['pending', 'countered'].includes(q.status)) throw conflict(`Quote is ${q.status}`);
    await db.query(`UPDATE quote_counters SET status = 'superseded', responded_at = now() WHERE quote_id = $1 AND status = 'pending'`, [quoteId]);
    await writeQuoteItems(db, quoteId, b.items as QuoteItemInput[]);
    return one(
      `UPDATE quotes SET revision = revision + 1, status = 'pending', labor_only = false,
         message = COALESCE($2, message), eta_minutes = COALESCE($3, eta_minutes)
       WHERE id = $1 RETURNING *`,
      [quoteId, b.message ?? null, b.etaMinutes ?? null],
      db,
    );
  });
  const job = await one('SELECT customer_id, title FROM jobs WHERE id = $1', [jobId]);
  await notify(job.customer_id, 'Quote updated', `${tech.full_name} revised their quote for "${job.title}"`, jobId, 'quote.revised');
  res.json({ quote });
});

quotesRouter.post('/jobs/:id/quotes/:quoteId/withdraw', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const row = await one(
    `UPDATE quotes SET status = 'withdrawn' WHERE id = $1 AND job_id = $2 AND technician_id = $3 AND status IN ('pending', 'countered') RETURNING id`,
    [quoteId, jobId, currentUser(req).id],
  );
  if (!row) throw conflict('Quote cannot be withdrawn');
  await query(`UPDATE quote_counters SET status = 'superseded', responded_at = now() WHERE quote_id = $1 AND status = 'pending'`, [quoteId]);
  res.json({ ok: true });
});

/** Customer approves the quote as quoted. */
quotesRouter.post('/jobs/:id/quotes/:quoteId/accept', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const customer = currentUser(req);
  const job = await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.customer_id !== customer.id) throw forbidden('Not your job');
    if (q.status === 'countered') throw conflict('You have a counter-offer pending on this quote — withdraw it first');
    if (q.status !== 'pending') throw conflict(`Quote is ${q.status}`);
    return assignQuote(db, jobId, quoteId, { id: customer.id, role: 'customer' }, `approved quote ${quoteId} (rev ${q.revision})`);
  });
  await afterTransition(job);
  res.json({ job, whatsappLink: waDeepLink(job.ref) ?? null });
});

const CounterBody = z.object({
  kind: z.enum(COUNTER_KINDS),
  proposedTotalMinor: z.number().int().positive().optional(),
  proposedLaborMinor: z.number().int().positive().optional(),
  message: z.string().trim().max(1000).optional(),
});

/** Customer counters a quote: labor-only, price challenge (needs a reason) or labor negotiation. */
quotesRouter.post('/jobs/:id/quotes/:quoteId/counter', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const b = parse(CounterBody, req.body);
  const customer = currentUser(req);
  if (b.kind === 'price_challenge' && !b.message) throw badRequest('Explain your price challenge (message)');
  const { counter, q } = await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.customer_id !== customer.id) throw forbidden('Not your job');
    if (q.status !== 'pending') throw conflict(q.status === 'countered' ? 'A counter-offer is already pending on this quote' : `Quote is ${q.status}`);
    const totals = { labor: Number(q.labor_minor), materials: Number(q.materials_minor), other: 0, total: Number(q.amount_minor) };
    totals.other = totals.total - totals.labor - totals.materials;
    const result = evaluateCounter(totals, b, q.labor_stance);
    if (!result.ok) throw conflict(result.reason);
    const counter = await one(
      `INSERT INTO quote_counters (quote_id, quote_revision, kind, proposed_total_minor, proposed_labor_minor, message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [quoteId, q.revision, b.kind, result.proposedTotal, result.proposedLabor ?? null, b.message ?? null, customer.id],
      db,
    );
    await db.query(`UPDATE quotes SET status = 'countered' WHERE id = $1`, [quoteId]);
    return { counter, q };
  });
  const label = { labor_only: 'a labor-only counter', price_challenge: 'a price challenge', labor_negotiation: 'a labor-cost counter' }[b.kind];
  await notify(q.technician_id, 'Counter-offer received', `The customer sent ${label} on "${q.job_title}"`, jobId, 'quote.countered');
  res.status(201).json({ counter });
});

quotesRouter.post('/jobs/:id/quotes/:quoteId/counters/:counterId/withdraw', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const counterId = parse(z.uuid(), req.params.counterId);
  await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.customer_id !== currentUser(req).id) throw forbidden('Not your job');
    const c = await one(
      `UPDATE quote_counters SET status = 'withdrawn', responded_at = now() WHERE id = $1 AND quote_id = $2 AND status = 'pending' RETURNING id`,
      [counterId, quoteId],
      db,
    );
    if (!c) throw conflict('No pending counter to withdraw');
    await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1`, [quoteId]);
  });
  res.json({ ok: true });
});

/**
 * Technician responds to a counter. Accepting applies the counter to the quote
 * (drops materials for labor-only, or adds a negotiated adjustment line) and
 * hires the technician at that price — the customer already offered it.
 */
quotesRouter.post('/jobs/:id/quotes/:quoteId/counters/:counterId/respond', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const counterId = parse(z.uuid(), req.params.counterId);
  const { decision } = parse(z.object({ decision: z.enum(['accept', 'decline']) }), req.body);
  const tech = currentUser(req);

  const outcome = await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.technician_id !== tech.id) throw forbidden('Not your quote');
    const c = await one(`SELECT * FROM quote_counters WHERE id = $1 AND quote_id = $2 AND status = 'pending' FOR UPDATE`, [counterId, quoteId], db);
    if (!c) throw conflict('No pending counter-offer');

    if (decision === 'decline') {
      await db.query(`UPDATE quote_counters SET status = 'declined', responded_at = now() WHERE id = $1`, [counterId]);
      await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1`, [quoteId]);
      return { job: null as JobRecord | null, customerId: q.customer_id, title: q.job_title };
    }

    if (c.kind === 'labor_only') {
      await db.query(`DELETE FROM quote_items WHERE quote_id = $1 AND kind = 'material'`, [quoteId]);
      await db.query('UPDATE quotes SET labor_only = true WHERE id = $1', [quoteId]);
    } else {
      const items = (await db.query<{ kind: any; total_minor: number }>('SELECT kind, total_minor FROM quote_items WHERE quote_id = $1', [quoteId])).rows;
      const current = quoteTotals(items.map((i) => ({ kind: i.kind, totalMinor: Number(i.total_minor) }))).total;
      const delta = Number(c.proposed_total_minor) - current;
      if (delta !== 0) {
        await db.query(
          `INSERT INTO quote_items (quote_id, kind, description, quantity, unit_price_minor, total_minor, position)
           VALUES ($1, 'adjustment', $2, 1, $3, $3, 1000)`,
          [quoteId, c.kind === 'labor_negotiation' ? 'Negotiated labor discount' : 'Agreed price adjustment', delta],
        );
      }
    }
    const totals = await refreshQuoteTotals(db, quoteId);
    if (totals.total !== Number(c.proposed_total_minor)) throw conflict('Counter no longer matches the quote');
    await db.query(`UPDATE quote_counters SET status = 'accepted', responded_at = now() WHERE id = $1`, [counterId]);
    await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1`, [quoteId]);
    const job = await assignQuote(db, jobId, quoteId, { id: null, role: 'system' }, `technician accepted ${c.kind} counter ${counterId}`);
    return { job, customerId: q.customer_id, title: q.job_title };
  });

  if (outcome.job) {
    await afterTransition(outcome.job);
    await notify(outcome.customerId, 'Counter-offer accepted', `${tech.full_name} accepted your offer — they're booked for "${outcome.title}"`, jobId, 'quote.counter_accepted');
    res.json({ job: outcome.job, whatsappLink: waDeepLink(outcome.job.ref) ?? null });
  } else {
    await notify(outcome.customerId, 'Counter-offer declined', `${tech.full_name} declined your counter on "${outcome.title}". Their original quote stands.`, jobId, 'quote.counter_declined');
    res.json({ ok: true });
  }
});
