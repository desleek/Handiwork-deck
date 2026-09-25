import { lineTotal, type QuoteItemInput, quoteTotals } from '@handiwork/shared';
import type pg from 'pg';
import { one } from '../../db/pool';
import { conflict, notFound } from '../../lib/errors';
import { ensureConversation } from '../messaging/conversations';
import { type Actor, type JobRecord, transitionJob } from './lifecycle';

/** Replaces a quote's line items and refreshes its cached totals. */
export async function writeQuoteItems(db: pg.PoolClient, quoteId: string, items: QuoteItemInput[]) {
  await db.query(`DELETE FROM quote_items WHERE quote_id = $1`, [quoteId]);
  const rows = items.map((i, position) => ({ ...i, totalMinor: lineTotal(i), position }));
  for (const r of rows) {
    await db.query(
      `INSERT INTO quote_items (quote_id, kind, description, quantity, unit_price_minor, total_minor, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [quoteId, r.kind, r.description, r.quantity, r.unitPriceMinor, r.totalMinor, r.position],
    );
  }
  return refreshQuoteTotals(db, quoteId);
}

export async function refreshQuoteTotals(db: pg.PoolClient, quoteId: string) {
  const items = (await db.query<{ kind: any; total_minor: number }>('SELECT kind, total_minor FROM quote_items WHERE quote_id = $1', [quoteId])).rows;
  const totals = quoteTotals(items.map((i) => ({ kind: i.kind, totalMinor: Number(i.total_minor) })));
  if (totals.total <= 0) throw conflict('Quote total must be positive');
  await db.query('UPDATE quotes SET amount_minor = $2, labor_minor = $3, materials_minor = $4 WHERE id = $1', [
    quoteId,
    totals.total,
    totals.labor,
    totals.materials,
  ]);
  return totals;
}

/**
 * Hires the technician behind `quoteId`: accepts that quote, rejects the others,
 * records the agreed price on the job and opens the (now unmasked) conversation.
 * Runs in the caller's transaction; the caller runs afterTransition().
 */
export async function assignQuote(db: pg.PoolClient, jobId: string, quoteId: string, actor: Actor, note: string): Promise<JobRecord> {
  const quote = await one(`SELECT * FROM quotes WHERE id = $1 AND job_id = $2 FOR UPDATE`, [quoteId, jobId], db);
  if (!quote) throw notFound('Quote');
  const job = await transitionJob(jobId, 'assigned', actor, {
    db,
    note,
    extra: async (d) => {
      await d.query('UPDATE jobs SET technician_id = $2, budget_minor = $3, labor_only = $4 WHERE id = $1', [
        jobId,
        quote.technician_id,
        quote.amount_minor,
        quote.labor_only,
      ]);
    },
  });
  await db.query(
    `UPDATE quotes SET status = CASE WHEN id = $2 THEN 'accepted'::quote_status ELSE 'rejected'::quote_status END
      WHERE job_id = $1 AND (id = $2 OR status IN ('pending', 'countered'))`,
    [jobId, quoteId],
  );
  await db.query(`UPDATE quote_counters SET status = 'superseded' WHERE status = 'pending' AND quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND id <> $2)`, [jobId, quoteId]);
  await ensureConversation(db, jobId, job.customer_id, quote.technician_id);
  // Chats with technicians who weren't hired are closed.
  await db.query('UPDATE conversations SET is_open = (technician_id = $2) WHERE job_id = $1', [jobId, quote.technician_id]);
  return job;
}
