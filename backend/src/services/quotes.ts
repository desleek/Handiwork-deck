import { one, query, type Db } from '../db/pool.ts';
import {
  computeTotals,
  priceQuote,
  type PricedLine,
  type PricedQuote,
  type QuoteItemInput,
  type QuoteTotals,
} from '../domain/pricing.ts';
import type { PlatformSettings } from '../domain/settings.ts';
import { HttpError, notFound } from '../lib/http.ts';

export interface QuoteRow {
  id: string;
  job_id: string;
  technician_id: string;
  version: number;
  status: string;
  applied_multiplier_bps: number;
  markup_cap_bps: number;
  labor_commission_bps: number;
  markup_commission_bps: number;
  labor_total_minor: number;
  parts_base_total_minor: number;
  markup_total_minor: number;
  customer_total_minor: number;
  platform_commission_minor: number;
  technician_net_minor: number;
  labor_only: boolean;
  notes: string | null;
}

export interface ItemRow {
  id: string;
  quote_id: string;
  kind: 'labor' | 'part';
  description: string;
  quantity: number;
  unit_cost_minor: number;
  base_labor_minor: number | null;
  markup_bps: number;
  markup_minor: number;
  line_total_minor: number;
  receipt_url: string | null;
  seller_id: string | null;
  position: number;
}

export interface FrozenContext {
  multiplierBps: number;
  markupCapBps: number;
  laborCommissionBps: number;
  markupCommissionBps: number;
}

/** Context for a brand-new quote: current multiplier, cap (incl. permanent override) and commissions. */
export async function currentContext(db: Db, technicianId: string, s: PlatformSettings) {
  const t = await one<{ performance_multiplier_bps: number; markup_cap_override_bps: number | null }>(
    'SELECT performance_multiplier_bps, markup_cap_override_bps FROM technician_profiles WHERE user_id = $1',
    [technicianId],
    db,
  );
  if (!t) throw notFound('Technician');
  return {
    frozen: {
      multiplierBps: s.features.performanceMultiplier ? t.performance_multiplier_bps : 0,
      markupCapBps: t.markup_cap_override_bps ?? s.markupCapBps,
      laborCommissionBps: s.laborCommissionBps,
      markupCommissionBps: s.markupCommissionBps,
    } satisfies FrozenContext,
    receiptThresholdMinor: s.receiptThresholdMinor,
  };
}

export function price(items: QuoteItemInput[], frozen: FrozenContext, receiptThresholdMinor: number): PricedQuote {
  return priceQuote(items, {
    markupCapBps: frozen.markupCapBps,
    receiptThresholdMinor,
    laborCommissionBps: frozen.laborCommissionBps,
    markupCommissionBps: frozen.markupCommissionBps,
    multiplierBps: frozen.multiplierBps,
  });
}

/** Throw 422 for anything other than over-cap markups (which may go to a Demand Notice). */
export function assertPriceable(priced: PricedQuote, allowOverCap: boolean) {
  const blocking = priced.issues.filter((i) => !(allowOverCap && i.code === 'MARKUP_OVER_CAP'));
  if (blocking.length) {
    throw new HttpError(422, 'QUOTE_INVALID', 'The quote breaks pricing rules', blocking);
  }
}

export async function insertQuote(
  db: Db,
  p: {
    jobId: string;
    technicianId: string;
    status: 'submitted' | 'pending_exception';
    frozen: FrozenContext;
    lines: PricedLine[];
    totals: QuoteTotals;
    notes?: string | null;
    laborOnly?: boolean;
  },
): Promise<{ quote: QuoteRow; items: ItemRow[] }> {
  // Supersede any live quote for the job
  await query(
    `UPDATE quotes SET status = 'superseded' WHERE job_id = $1 AND status IN ('submitted', 'pending_exception')`,
    [p.jobId],
    db,
  );
  const v = await one<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM quotes WHERE job_id = $1', [p.jobId], db);
  const t = p.totals;
  const quote = (await one<QuoteRow>(
    `INSERT INTO quotes (job_id, technician_id, version, status, applied_multiplier_bps, markup_cap_bps,
        labor_commission_bps, markup_commission_bps, labor_total_minor, parts_base_total_minor, markup_total_minor,
        customer_total_minor, platform_commission_minor, technician_net_minor, labor_only, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      p.jobId, p.technicianId, v!.v, p.status, p.frozen.multiplierBps, p.frozen.markupCapBps,
      p.frozen.laborCommissionBps, p.frozen.markupCommissionBps, t.laborTotalMinor, t.partsBaseTotalMinor,
      t.markupTotalMinor, t.customerTotalMinor, t.platformCommissionMinor, t.technicianNetMinor,
      !!p.laborOnly, p.notes ?? null,
    ],
    db,
  ))!;
  const items: ItemRow[] = [];
  for (const l of p.lines) {
    items.push(
      (await one<ItemRow>(
        `INSERT INTO quote_items (quote_id, kind, description, quantity, unit_cost_minor, base_labor_minor,
            markup_bps, markup_minor, line_total_minor, receipt_url, seller_id, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [quote.id, l.kind, l.description, l.quantity, l.unitCostMinor, l.baseLaborMinor, l.markupBps, l.markupMinor,
          l.lineTotalMinor, l.receiptUrl, l.sellerId, l.position],
        db,
      ))!,
    );
  }
  return { quote, items };
}

export async function liveQuote(db: Db, jobId: string): Promise<QuoteRow> {
  const q = await one<QuoteRow>(
    `SELECT * FROM quotes WHERE job_id = $1 AND status IN ('submitted', 'pending_exception', 'approved')
     ORDER BY version DESC LIMIT 1`,
    [jobId],
    db,
  );
  if (!q) throw notFound('Quote');
  return q;
}

export async function quoteItems(db: Db, quoteId: string): Promise<ItemRow[]> {
  return query<ItemRow>('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY position', [quoteId], db);
}

/** Approved Demand Notice caps for this job, keyed by item position (scoped to this invoice only). */
export async function approvedExceptionCaps(db: Db, jobId: string): Promise<Map<number, number>> {
  const rows = await query<{ position: number; requested_markup_bps: number }>(
    `SELECT qi.position, me.requested_markup_bps
       FROM markup_exceptions me JOIN quote_items qi ON qi.id = me.quote_item_id
      WHERE me.job_id = $1 AND me.status = 'approved'`,
    [jobId],
    db,
  );
  return new Map(rows.map((r) => [r.position, r.requested_markup_bps]));
}

/** Rebuild pricing inputs from a stored quote (for revisions: challenges, labor-only, negotiation). */
export function itemsToInputs(items: ItemRow[], caps: Map<number, number>): QuoteItemInput[] {
  return items.map((i) => ({
    kind: i.kind,
    description: i.description,
    quantity: Number(i.quantity),
    unitCostMinor: i.kind === 'labor' ? (i.base_labor_minor ?? i.unit_cost_minor) : i.unit_cost_minor,
    markupBps: i.markup_bps,
    receiptUrl: i.receipt_url,
    sellerId: i.seller_id,
    approvedExceptionCapBps: caps.get(i.position) ?? null,
  }));
}

export function frozenOf(q: QuoteRow): FrozenContext {
  return {
    multiplierBps: q.applied_multiplier_bps,
    markupCapBps: q.markup_cap_bps,
    laborCommissionBps: q.labor_commission_bps,
    markupCommissionBps: q.markup_commission_bps,
  };
}

export function totalsOf(q: QuoteRow): QuoteTotals {
  return {
    laborTotalMinor: q.labor_total_minor,
    partsBaseTotalMinor: q.parts_base_total_minor,
    markupTotalMinor: q.markup_total_minor,
    customerTotalMinor: q.customer_total_minor,
    laborCommissionMinor: Math.round((q.labor_total_minor * q.labor_commission_bps) / 10_000),
    markupCommissionMinor: Math.round((q.markup_total_minor * q.markup_commission_bps) / 10_000),
    platformCommissionMinor: q.platform_commission_minor,
    technicianNetMinor: q.technician_net_minor,
  };
}

/** Customer/technician-facing quote view. Every component is its own field — never a lump sum (Section 14). */
export function presentQuote(q: QuoteRow, items: ItemRow[], viewer: 'customer' | 'technician' | 'admin') {
  const totals = totalsOf(q);
  return {
    id: q.id,
    version: q.version,
    status: q.status,
    laborOnly: q.labor_only,
    notes: q.notes,
    performanceMultiplierBps: q.applied_multiplier_bps,
    lines: items.map((i) => ({
      id: i.id,
      position: i.position,
      kind: i.kind,
      description: i.description,
      quantity: Number(i.quantity),
      ...(i.kind === 'labor'
        ? { rateMinor: i.unit_cost_minor, standardRateMinor: i.base_labor_minor }
        : { baseUnitCostMinor: i.unit_cost_minor, markupBps: i.markup_bps, markupMinor: i.markup_minor, receiptUrl: i.receipt_url }),
      lineTotalMinor: i.line_total_minor,
    })),
    totals: {
      laborMinor: totals.laborTotalMinor,
      partsBaseMinor: totals.partsBaseTotalMinor,
      markupMinor: totals.markupTotalMinor,
      totalMinor: totals.customerTotalMinor,
      ...(viewer !== 'customer'
        ? {
            platformFees: {
              laborCommissionMinor: totals.laborCommissionMinor,
              markupCommissionMinor: totals.markupCommissionMinor,
              totalMinor: totals.platformCommissionMinor,
            },
            technicianNetMinor: totals.technicianNetMinor,
          }
        : {
            // Customers see that platform fees come out of the technician's side, not on top.
            platformFeesIncludedMinor: totals.platformCommissionMinor,
          }),
    },
  };
}

export { computeTotals };
