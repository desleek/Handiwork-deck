import { type CommissionBreakdown, commissionFor, type QuoteTotals, quoteTotals } from '@handiwork/shared';
import { type Queryable, one, pool, query } from '../../db/pool';
import { conflict } from '../../lib/errors';
import { getSetting, receiptThreshold } from '../settings';

export interface InvoiceLine {
  id: string;
  kind: 'labor' | 'material' | 'adjustment';
  description: string;
  quantity: number;
  unitPriceMinor: number;
  baseMinor: number;
  markupBps: number;
  markupMinor: number;
  totalMinor: number;
  appliesTo: 'labor' | 'markup' | null;
  receiptFileId: string | null;
  receiptUrl: string | null;
  receiptRequired: boolean;
}

export interface Invoice {
  jobId: string;
  quoteId: string;
  currency: string;
  labor: InvoiceLine[];
  parts: InvoiceLine[];
  adjustments: InvoiceLine[];
  totals: QuoteTotals;
  commission: CommissionBreakdown & { laborBps: number; markupBps: number };
  receiptThresholdMinor: number;
  missingReceipts: { id: string; description: string; baseMinor: number }[];
}

/**
 * The job's invoice, built from the accepted quote: Labor and Parts/Materials
 * as separate sections, each part with base cost / markup % / markup amount,
 * and commission on labor and markup only (at the rates snapshotted on the job).
 */
export async function invoiceFor(jobId: string, db: Queryable = pool): Promise<Invoice> {
  const job = await one('SELECT id, currency, labor_commission_bps, markup_commission_bps FROM jobs WHERE id = $1', [jobId], db);
  const quote = await one(`SELECT id FROM quotes WHERE job_id = $1 AND status = 'accepted'`, [jobId], db);
  if (!job || !quote) throw conflict('This job has no accepted quote');
  const threshold = await receiptThreshold(job.currency, db);
  const rows = await query(
    `SELECT i.*, f.url AS receipt_url FROM quote_items i LEFT JOIN files f ON f.id = i.receipt_file_id
      WHERE i.quote_id = $1 ORDER BY i.position`,
    [quote.id],
    db,
  );
  const lines: InvoiceLine[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    description: r.description,
    quantity: Number(r.quantity),
    unitPriceMinor: Number(r.unit_price_minor),
    baseMinor: Number(r.base_minor),
    markupBps: r.markup_bps,
    markupMinor: Number(r.markup_minor),
    totalMinor: Number(r.total_minor),
    appliesTo: r.applies_to,
    receiptFileId: r.receipt_file_id,
    receiptUrl: r.receipt_url,
    receiptRequired: r.kind === 'material' && Number(r.base_minor) >= threshold,
  }));
  const totals = quoteTotals(lines.map((l) => ({ kind: l.kind, baseMinor: l.baseMinor, markupMinor: l.markupMinor, totalMinor: l.totalMinor, appliesTo: l.appliesTo ?? undefined })));
  const fallback = await getSetting('commission', db);
  const rates = { laborBps: job.labor_commission_bps ?? fallback.laborBps, markupBps: job.markup_commission_bps ?? fallback.markupBps };
  return {
    jobId,
    quoteId: quote.id,
    currency: job.currency,
    labor: lines.filter((l) => l.kind === 'labor'),
    parts: lines.filter((l) => l.kind === 'material'),
    adjustments: lines.filter((l) => l.kind === 'adjustment'),
    totals,
    commission: { ...commissionFor(totals, rates), ...rates },
    receiptThresholdMinor: threshold,
    missingReceipts: lines.filter((l) => l.receiptRequired && !l.receiptFileId).map((l) => ({ id: l.id, description: l.description, baseMinor: l.baseMinor })),
  };
}
