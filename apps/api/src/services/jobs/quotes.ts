import { type AdjustmentTarget, priceLine, type QuoteItemInput, quoteTotals } from '@handiwork/shared';
import type pg from 'pg';
import { one } from '../../db/pool';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors';
import { audit } from '../audit';
import { ensureConversation } from '../messaging/conversations';
import { getSetting, markupCapFor } from '../settings';
import { type Actor, type JobRecord, transitionJob } from './lifecycle';

/** A quote line as submitted: parts may carry a receipt and a Demand Notice for above-cap markup. */
export type QuoteLineInput = QuoteItemInput & {
  receiptFileId?: string;
  capException?: { reason: string; evidenceFileIds: string[] };
};

interface WriteContext {
  quoteId: string;
  jobId: string;
  technicianId: string;
  currency: string;
  revision: number;
}

/**
 * Replaces a quote's line items. Enforces the markup cap: any part line above
 * the technician's cap must carry a Demand Notice (reason + evidence), which is
 * filed for admin review and puts the quote in `pending_exception`.
 * Returns the number of Demand Notices filed.
 */
export async function writeQuoteItems(db: pg.PoolClient, ctx: WriteContext, items: QuoteLineInput[]): Promise<number> {
  const cap = await markupCapFor(ctx.technicianId, db);
  const overCap = items.filter((i) => i.kind === 'material' && i.markupBps > cap);
  const missing = overCap.filter((i) => !i.capException);
  if (missing.length) {
    throw new HttpError(422, `Markup above the ${cap / 100}% cap needs a cap exception request (Demand Notice)`, 'markup_cap_exceeded', {
      capBps: cap,
      lines: missing.map((i) => i.description),
    });
  }

  // Files referenced by the quote must belong to the technician.
  const fileIds = items.flatMap((i) => [...(i.receiptFileId ? [i.receiptFileId] : []), ...(i.capException?.evidenceFileIds ?? [])]);
  if (fileIds.length) {
    const owned = await one<{ n: number }>('SELECT count(*)::int AS n FROM files WHERE id = ANY($1) AND owner_id = $2', [fileIds, ctx.technicianId], db);
    if (owned?.n !== new Set(fileIds).size) throw badRequest('Unknown receipt or evidence file');
  }

  // Replacing the lines invalidates any earlier Demand Notices on this quote.
  await db.query(`UPDATE cap_exception_requests SET status = 'withdrawn' WHERE quote_id = $1 AND status = 'pending'`, [ctx.quoteId]);
  await db.query(`DELETE FROM quote_items WHERE quote_id = $1`, [ctx.quoteId]);

  let filed = 0;
  for (const [position, item] of items.entries()) {
    const p = priceLine(item);
    const row = await one<{ id: string }>(
      `INSERT INTO quote_items (quote_id, kind, description, quantity, unit_price_minor, base_minor, markup_bps, markup_minor, total_minor, receipt_file_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [ctx.quoteId, p.kind, item.description, item.quantity, item.unitPriceMinor, p.baseMinor, p.markupBps, p.markupMinor, p.totalMinor, item.receiptFileId ?? null, position],
      db,
    );
    if (item.kind === 'material' && item.markupBps > cap && item.capException) {
      const req = await one<{ id: string }>(
        `INSERT INTO cap_exception_requests (job_id, quote_id, quote_item_id, quote_revision, technician_id, line_description, base_minor, currency,
                                             requested_markup_bps, cap_bps, reason, evidence_file_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [ctx.jobId, ctx.quoteId, row!.id, ctx.revision, ctx.technicianId, item.description, p.baseMinor, ctx.currency, item.markupBps, cap, item.capException.reason, item.capException.evidenceFileIds],
        db,
      );
      await audit(ctx.jobId, ctx.technicianId, 'cap_exception.requested', {
        requestId: req!.id,
        quoteId: ctx.quoteId,
        line: item.description,
        baseMinor: p.baseMinor,
        requestedMarkupBps: item.markupBps,
        capBps: cap,
        reason: item.capException.reason,
        evidenceFileIds: item.capException.evidenceFileIds,
      }, db);
      filed++;
    }
  }
  await refreshQuoteTotals(db, ctx.quoteId);
  return filed;
}

export async function addAdjustment(db: pg.PoolClient, quoteId: string, appliesTo: AdjustmentTarget, amountMinor: number, description: string) {
  await db.query(
    `INSERT INTO quote_items (quote_id, kind, description, quantity, unit_price_minor, base_minor, total_minor, applies_to, position)
     VALUES ($1, 'adjustment', $2, 1, $3, $3, $3, $4, 1000 + (SELECT count(*) FROM quote_items WHERE quote_id = $1))`,
    [quoteId, description, amountMinor, appliesTo],
  );
}

export async function refreshQuoteTotals(db: pg.PoolClient, quoteId: string) {
  const rows = (
    await db.query<{ kind: any; base_minor: number; markup_minor: number; total_minor: number; applies_to: AdjustmentTarget | null }>(
      'SELECT kind, base_minor, markup_minor, total_minor, applies_to FROM quote_items WHERE quote_id = $1',
      [quoteId],
    )
  ).rows;
  const totals = quoteTotals(
    rows.map((r) => ({ kind: r.kind, baseMinor: Number(r.base_minor), markupMinor: Number(r.markup_minor), totalMinor: Number(r.total_minor), appliesTo: r.applies_to ?? undefined })),
  );
  if (totals.total <= 0) throw conflict('Quote total must be positive');
  await db.query(
    'UPDATE quotes SET amount_minor = $2, labor_minor = $3, materials_minor = $4, parts_base_minor = $5, markup_minor = $6 WHERE id = $1',
    [quoteId, totals.total, totals.labor, totals.materials, totals.partsBase, totals.markup],
  );
  return totals;
}

/**
 * Hires the technician behind `quoteId`: accepts that quote, rejects the others,
 * records the agreed price and snapshots the commission rates on the job, and
 * opens the (now unmasked) conversation. Runs in the caller's transaction; the
 * caller runs afterTransition().
 */
export async function assignQuote(db: pg.PoolClient, jobId: string, quoteId: string, actor: Actor, note: string): Promise<JobRecord> {
  const quote = await one(`SELECT * FROM quotes WHERE id = $1 AND job_id = $2 FOR UPDATE`, [quoteId, jobId], db);
  if (!quote) throw notFound('Quote');
  if (quote.status === 'pending_exception') throw conflict('This quote has a markup cap exception under review');
  const rates = await getSetting('commission', db);
  const job = await transitionJob(jobId, 'assigned', actor, {
    db,
    note,
    extra: async (d) => {
      await d.query(
        `UPDATE jobs SET technician_id = $2, budget_minor = $3, labor_only = $4, labor_commission_bps = $5, markup_commission_bps = $6 WHERE id = $1`,
        [jobId, quote.technician_id, quote.amount_minor, quote.labor_only, rates.laborBps, rates.markupBps],
      );
    },
  });
  await db.query(
    `UPDATE quotes SET status = CASE WHEN id = $2 THEN 'accepted'::quote_status ELSE 'rejected'::quote_status END
      WHERE job_id = $1 AND (id = $2 OR status IN ('pending', 'pending_exception', 'countered'))`,
    [jobId, quoteId],
  );
  await db.query(`UPDATE quote_counters SET status = 'superseded' WHERE status = 'pending' AND quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND id <> $2)`, [jobId, quoteId]);
  await db.query(`UPDATE cap_exception_requests SET status = 'withdrawn' WHERE job_id = $1 AND quote_id <> $2 AND status = 'pending'`, [jobId, quoteId]);
  await ensureConversation(db, jobId, job.customer_id, quote.technician_id);
  // Chats with technicians who weren't hired are closed.
  await db.query('UPDATE conversations SET is_open = (technician_id = $2) WHERE job_id = $1', [jobId, quote.technician_id]);
  await audit(jobId, actor.id, 'quote.accepted', { quoteId, amountMinor: Number(quote.amount_minor), revision: quote.revision, note, commission: rates }, db);
  return job;
}
