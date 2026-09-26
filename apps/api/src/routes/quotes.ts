import { allocateReduction, COUNTER_KINDS, evaluateCounter, type LaborOnlyPolicy } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { audit } from '../services/audit';
import { afterTransition, type JobRecord, transitionJob } from '../services/jobs/lifecycle';
import { addAdjustment, assignQuote, type QuoteLineInput, refreshQuoteTotals, writeQuoteItems } from '../services/jobs/quotes';
import { waDeepLink } from '../services/messaging/whatsapp';

/**
 * Itemized quotes and negotiation (Sections 3, 4, 5, 5a).
 *  - Lines are Labor or Parts/Materials; each part line discloses base cost, markup % and markup amount.
 *  - Markup above the cap needs a Demand Notice; the quote waits in `pending_exception` for an admin.
 *  - Customers approve, or counter (labor-only / price challenge / labor negotiation).
 */
export const quotesRouter = Router();

const Description = z.string().trim().min(2).max(200);
const ItemBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('labor'),
    description: Description,
    quantity: z.number().positive().max(100_000).default(1),
    unitPriceMinor: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('material'),
    description: Description,
    quantity: z.number().positive().max(100_000).default(1),
    /** Base cost per unit — what the part costs the technician. */
    unitPriceMinor: z.number().int().min(0),
    /** Disclosed markup on the base cost (basis points). Above the cap requires `capException`. */
    markupBps: z.number().int().min(0).max(100_000).default(0),
    receiptFileId: z.uuid().optional(),
    /** Section 5a Demand Notice: reason, supplier invoice / price evidence. */
    capException: z.object({ reason: z.string().trim().min(10).max(2000), evidenceFileIds: z.array(z.uuid()).min(1).max(10) }).optional(),
  }),
]);

const QuoteBody = z
  .object({
    items: z.array(ItemBody).min(1).max(50),
    message: z.string().max(2000).optional(),
    etaMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
  })
  // Section 5: never a lump sum — labor must be itemized as its own line.
  .refine((b) => b.items.some((i) => i.kind === 'labor'), { message: 'A quote needs at least one labor line', path: ['items'] });

async function notify(userId: string, title: string, body: string, jobId: string, type: string) {
  await scheduler().notify(userId, { title, body, data: { jobId, type } });
}

async function notifyAdmins(title: string, body: string, jobId: string) {
  const admins = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND is_active`);
  await Promise.all(admins.map((a) => notify(a.id, title, body, jobId, 'cap_exception')));
}

quotesRouter.post('/jobs/:id/quotes', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(QuoteBody, req.body);
  const tech = currentUser(req);
  const { quote, job, promoted, filed } = await tx(async (db) => {
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
      `INSERT INTO quotes (job_id, technician_id, amount_minor, currency, message, eta_minutes) VALUES ($1, $2, 1, $3, $4, $5) RETURNING id`,
      [jobId, tech.id, job.currency, b.message ?? null, b.etaMinutes ?? null],
      db,
    );
    const filed = await writeQuoteItems(db, { quoteId: quote.id, jobId, technicianId: tech.id, currency: job.currency, revision: 1 }, b.items as QuoteLineInput[]);
    if (filed) await db.query(`UPDATE quotes SET status = 'pending_exception' WHERE id = $1`, [quote.id]);
    const full = await one('SELECT * FROM quotes WHERE id = $1', [quote.id], db);
    await audit(jobId, tech.id, 'quote.submitted', { quoteId: quote.id, amountMinor: Number(full.amount_minor), capExceptions: filed }, db);
    const promoted = job.status === 'open' ? await transitionJob(jobId, 'quoted', { id: null, role: 'system' }, { db, note: 'first quote received' }) : null;
    return { quote: full, job, promoted, filed };
  });
  if (promoted) await afterTransition(promoted);
  if (filed) {
    await notify(job.customer_id, 'Quote under review', `${tech.full_name}'s quote on "${job.title}" includes a markup exception our team is reviewing.`, jobId, 'quote.pending_exception');
    await notifyAdmins('Demand Notice to review', `Markup cap exception on #${job.ref}`, jobId);
  } else {
    await notify(job.customer_id, 'New quote received', `${tech.full_name} quoted on "${job.title}"`, jobId, 'quote.new');
  }
  res.status(201).json({ quote });
});

async function lockQuote(db: any, jobId: string, quoteId: string) {
  const q = await one(
    `SELECT q.*, j.customer_id, j.ref AS job_ref, j.status AS job_status, j.title AS job_title, j.category_id,
            COALESCE(ts.labor_only_policy, 'decline') AS labor_only_policy
       FROM quotes q JOIN jobs j ON j.id = q.job_id
       LEFT JOIN technician_services ts ON ts.technician_id = q.technician_id AND ts.category_id = j.category_id
      WHERE q.id = $1 AND q.job_id = $2 FOR UPDATE OF q`,
    [quoteId, jobId],
    db,
  );
  if (!q) throw notFound('Quote');
  if (q.job_status !== 'quoted' && q.job_status !== 'open') throw conflict('This job is no longer open for negotiation');
  return q;
}

const totalsOf = (q: any) => ({
  labor: Number(q.labor_minor),
  partsBase: Number(q.parts_base_minor),
  markup: Number(q.markup_minor),
  materials: Number(q.materials_minor),
  total: Number(q.amount_minor),
});

/** Technician revises their quote. Pending counters and Demand Notices on the old lines are superseded. */
quotesRouter.put('/jobs/:id/quotes/:quoteId', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const b = parse(QuoteBody, req.body);
  const tech = currentUser(req);
  const { quote, filed, q } = await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.technician_id !== tech.id) throw forbidden('Not your quote');
    if (!['pending', 'pending_exception', 'countered'].includes(q.status)) throw conflict(`Quote is ${q.status}`);
    await db.query(`UPDATE quote_counters SET status = 'superseded', responded_at = now() WHERE quote_id = $1 AND status = 'pending'`, [quoteId]);
    const revision = q.revision + 1;
    const filed = await writeQuoteItems(db, { quoteId, jobId, technicianId: tech.id, currency: q.currency, revision }, b.items as QuoteLineInput[]);
    const quote = await one(
      `UPDATE quotes SET revision = $4, status = $5, labor_only = false,
         message = COALESCE($2, message), eta_minutes = COALESCE($3, eta_minutes)
       WHERE id = $1 RETURNING *`,
      [quoteId, b.message ?? null, b.etaMinutes ?? null, revision, filed ? 'pending_exception' : 'pending'],
      db,
    );
    await audit(jobId, tech.id, 'quote.revised', { quoteId, revision, amountMinor: Number(quote.amount_minor), capExceptions: filed }, db);
    return { quote, filed, q };
  });
  await notify(q.customer_id, filed ? 'Quote under review' : 'Quote updated', `${tech.full_name} revised their quote for "${q.job_title}"`, jobId, 'quote.revised');
  if (filed) await notifyAdmins('Demand Notice to review', `Markup cap exception on #${q.job_ref}`, jobId);
  res.json({ quote });
});

quotesRouter.post('/jobs/:id/quotes/:quoteId/withdraw', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const tech = currentUser(req);
  await tx(async (db) => {
    const row = await one(
      `UPDATE quotes SET status = 'withdrawn' WHERE id = $1 AND job_id = $2 AND technician_id = $3 AND status IN ('pending', 'pending_exception', 'countered') RETURNING id`,
      [quoteId, jobId, tech.id],
      db,
    );
    if (!row) throw conflict('Quote cannot be withdrawn');
    await db.query(`UPDATE quote_counters SET status = 'superseded', responded_at = now() WHERE quote_id = $1 AND status = 'pending'`, [quoteId]);
    await db.query(`UPDATE cap_exception_requests SET status = 'withdrawn' WHERE quote_id = $1 AND status = 'pending'`, [quoteId]);
    await audit(jobId, tech.id, 'quote.withdrawn', { quoteId }, db);
  });
  res.json({ ok: true });
});

/** Section 5: technician attaches a receipt / proof of purchase to a part line. */
quotesRouter.post('/jobs/:id/quotes/:quoteId/items/:itemId/receipt', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const itemId = parse(z.uuid(), req.params.itemId);
  const { fileId } = parse(z.object({ fileId: z.uuid() }), req.body);
  const tech = currentUser(req);
  const file = await one(`SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND kind = 'receipt'`, [fileId, tech.id]);
  if (!file) throw notFound('Receipt file');
  const item = await one(
    `UPDATE quote_items i SET receipt_file_id = $4 FROM quotes q
      WHERE i.id = $3 AND i.quote_id = q.id AND q.id = $2 AND q.job_id = $1 AND q.technician_id = $5 AND i.kind = 'material'
      RETURNING i.id, i.description`,
    [jobId, quoteId, itemId, fileId, tech.id],
  );
  if (!item) throw notFound('Part line');
  await audit(jobId, tech.id, 'receipt.attached', { quoteId, itemId, line: item.description, fileId });
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
    if (q.status === 'pending_exception') throw conflict('This quote is under review for a markup exception');
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

/** Customer counters: labor-only, price challenge (needs a reason) or labor negotiation. */
quotesRouter.post('/jobs/:id/quotes/:quoteId/counter', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const b = parse(CounterBody, req.body);
  const customer = currentUser(req);
  if (b.kind === 'price_challenge' && !b.message) throw badRequest('Explain your price challenge (message)');
  const { counter, q } = await tx(async (db) => {
    const q = await lockQuote(db, jobId, quoteId);
    if (q.customer_id !== customer.id) throw forbidden('Not your job');
    if (q.status !== 'pending') {
      throw conflict(
        q.status === 'countered' ? 'A counter-offer is already pending on this quote' : q.status === 'pending_exception' ? 'This quote is under review for a markup exception' : `Quote is ${q.status}`,
      );
    }
    const result = evaluateCounter(totalsOf(q), b, q.labor_only_policy as LaborOnlyPolicy);
    if (!result.ok) throw conflict(result.reason);
    const counter = await one(
      `INSERT INTO quote_counters (quote_id, quote_revision, kind, proposed_total_minor, proposed_labor_minor, message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [quoteId, q.revision, b.kind, result.proposedTotal, result.proposedLabor ?? null, b.message ?? null, customer.id],
      db,
    );
    await db.query(`UPDATE quotes SET status = 'countered' WHERE id = $1`, [quoteId]);
    await audit(jobId, customer.id, 'counter.sent', { quoteId, counterId: counter.id, kind: b.kind, proposedTotalMinor: result.proposedTotal, message: b.message ?? null }, db);
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
    await audit(jobId, currentUser(req).id, 'counter.withdrawn', { quoteId, counterId }, db);
  });
  res.json({ ok: true });
});

/**
 * Technician responds to a counter. Accepting applies it to the quote — drops
 * part lines for labor-only, or adds adjustment lines (labor first, then
 * markup; never the parts' base cost) — and hires the technician at that price.
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
      await audit(jobId, tech.id, 'counter.declined', { quoteId, counterId, kind: c.kind }, db);
      return { job: null as JobRecord | null, customerId: q.customer_id, title: q.job_title };
    }

    const totals = totalsOf(q);
    if (c.kind === 'labor_only') {
      await db.query(`DELETE FROM quote_items WHERE quote_id = $1 AND (kind = 'material' OR applies_to = 'markup')`, [quoteId]);
      await db.query('UPDATE quotes SET labor_only = true WHERE id = $1', [quoteId]);
    } else if (c.kind === 'labor_negotiation') {
      await addAdjustment(db, quoteId, 'labor', Number(c.proposed_labor_minor) - totals.labor, 'Negotiated labor discount');
    } else {
      for (const a of allocateReduction(totals, totals.total - Number(c.proposed_total_minor))) {
        await addAdjustment(db, quoteId, a.appliesTo, a.amountMinor, a.appliesTo === 'labor' ? 'Agreed price adjustment (labor)' : 'Agreed price adjustment (markup)');
      }
    }
    const after = await refreshQuoteTotals(db, quoteId);
    if (after.total !== Number(c.proposed_total_minor)) throw conflict('Counter no longer matches the quote');
    await db.query(`UPDATE quote_counters SET status = 'accepted', responded_at = now() WHERE id = $1`, [counterId]);
    await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1`, [quoteId]);
    await audit(jobId, tech.id, 'counter.accepted', { quoteId, counterId, kind: c.kind, totalMinor: after.total }, db);
    const job = await assignQuote(db, jobId, quoteId, { id: null, role: 'system' }, `technician accepted ${c.kind} counter ${counterId}`);
    return { job, customerId: q.customer_id, title: q.job_title };
  });

  if (outcome.job) {
    await afterTransition(outcome.job);
    await notify(outcome.customerId, 'Counter-offer accepted', `${tech.full_name} accepted your offer — they're booked for "${outcome.title}"`, jobId, 'quote.counter_accepted');
    res.json({ job: outcome.job, whatsappLink: waDeepLink(outcome.job.ref) ?? null });
  } else {
    await notify(outcome.customerId, 'Counter-offer declined', `${tech.full_name} declined your counter on "${outcome.title}". Their quote stands.`, jobId, 'quote.counter_declined');
    res.json({ ok: true });
  }
});
