import type { MinorUnits } from './money';

/**
 * Section 5 pricing model. Every quote/invoice is split into Labor and
 * Parts/Materials line items — never a lump sum. Each part line discloses its
 * base cost, markup % and markup amount separately.
 *
 * Stored kinds: 'labor', 'material' (a part/material line), and 'adjustment'
 * (negotiated changes, which apply to either the labor or the markup portion —
 * never to the base cost of parts).
 */
export const QUOTE_ITEM_KINDS = ['labor', 'material', 'adjustment'] as const;
export type QuoteItemKind = (typeof QUOTE_ITEM_KINDS)[number];
export type AdjustmentTarget = 'labor' | 'markup';

export interface LaborItemInput {
  kind: 'labor';
  description: string;
  quantity: number;
  unitPriceMinor: MinorUnits;
}
export interface PartItemInput {
  kind: 'material';
  description: string;
  quantity: number;
  /** Base cost per unit (what the technician pays the supplier). */
  unitPriceMinor: MinorUnits;
  /** Disclosed markup on the base cost, in basis points (2000 = 20%). */
  markupBps: number;
}
export type QuoteItemInput = LaborItemInput | PartItemInput;

export interface PricedLine {
  kind: QuoteItemKind;
  baseMinor: MinorUnits; // labor: qty × rate; part: qty × unit cost; adjustment: signed delta
  markupBps: number;
  markupMinor: MinorUnits;
  totalMinor: MinorUnits;
  appliesTo?: AdjustmentTarget;
}

export function priceLine(item: QuoteItemInput): PricedLine {
  const base = Math.round(item.quantity * item.unitPriceMinor);
  if (item.kind === 'labor') return { kind: 'labor', baseMinor: base, markupBps: 0, markupMinor: 0, totalMinor: base };
  const markup = Math.round((base * item.markupBps) / 10_000);
  return { kind: 'material', baseMinor: base, markupBps: item.markupBps, markupMinor: markup, totalMinor: base + markup };
}

export interface QuoteTotals {
  /** Commissionable labor: labor lines plus labor adjustments. */
  labor: MinorUnits;
  /** Base cost of parts — passed through to the technician, never commissioned. */
  partsBase: MinorUnits;
  /** Disclosed markup on parts plus markup adjustments. */
  markup: MinorUnits;
  /** Parts/Materials section total (base + markup). */
  materials: MinorUnits;
  total: MinorUnits;
}

export function quoteTotals(lines: Pick<PricedLine, 'kind' | 'baseMinor' | 'markupMinor' | 'totalMinor' | 'appliesTo'>[]): QuoteTotals {
  const t = { labor: 0, partsBase: 0, markup: 0, materials: 0, total: 0 };
  for (const l of lines) {
    if (l.kind === 'labor') t.labor += l.totalMinor;
    else if (l.kind === 'material') {
      t.partsBase += l.baseMinor;
      t.markup += l.markupMinor;
    } else if (l.appliesTo === 'markup') t.markup += l.totalMinor;
    else t.labor += l.totalMinor;
    t.total += l.totalMinor;
  }
  t.materials = t.partsBase + t.markup;
  return t;
}

// ---------------------------------------------------------------- markup cap
export const DEFAULT_MARKUP_CAP_BPS = 2000;

/** Part lines whose markup exceeds the cap (these need an approved Demand Notice). */
export function linesOverCap<T extends { kind: string; markupBps?: number }>(items: T[], capBps: number): number[] {
  return items.flatMap((i, idx) => (i.kind === 'material' && (i.markupBps ?? 0) > capBps ? [idx] : []));
}

// ---------------------------------------------------------------- commission
export interface CommissionRates {
  /** Default 18% on labor only. */
  laborBps: number;
  /** Default 20% on the disclosed markup only. Base part cost is never commissioned. */
  markupBps: number;
}
export const DEFAULT_COMMISSION: CommissionRates = { laborBps: 1800, markupBps: 2000 };

export interface CommissionBreakdown {
  laborFee: MinorUnits;
  markupFee: MinorUnits;
  platformFee: MinorUnits;
  technicianPayout: MinorUnits;
}

export function commissionFor(totals: Pick<QuoteTotals, 'labor' | 'markup' | 'total'>, rates: CommissionRates): CommissionBreakdown {
  const laborFee = Math.round((Math.max(totals.labor, 0) * rates.laborBps) / 10_000);
  const markupFee = Math.round((Math.max(totals.markup, 0) * rates.markupBps) / 10_000);
  const platformFee = Math.min(laborFee + markupFee, totals.total);
  return { laborFee, markupFee, platformFee, technicianPayout: totals.total - platformFee };
}

// ---------------------------------------------------------------- receipts
/** Parts at or above this base cost need a receipt/proof of purchase (₦50k / $50 equivalents). */
export const DEFAULT_RECEIPT_THRESHOLD_MINOR: Record<string, MinorUnits> = {
  NGN: 5_000_000,
  USD: 5_000,
  GBP: 4_000,
  EUR: 4_500,
  GHS: 50_000,
  KES: 650_000,
  ZAR: 90_000,
  UGX: 185_000,
  RWF: 65_000,
};

// ---------------------------------------------------------------- labor-only
/**
 * Per-category labor-only declaration made at onboarding: will the technician
 * work when the customer supplies the materials? Permanent unless switched,
 * and switching is subject to a cooldown.
 */
export const LABOR_ONLY_POLICIES = ['accept', 'decline'] as const;
export type LaborOnlyPolicy = (typeof LABOR_ONLY_POLICIES)[number];
export const LABOR_ONLY_POLICY_LABEL: Record<LaborOnlyPolicy, string> = {
  accept: 'Accepts labor-only (you supply materials)',
  decline: 'Supplies own materials — no labor-only',
};
export const DEFAULT_LABOR_ONLY_COOLDOWN_DAYS = 90;

// ---------------------------------------------------------------- counters
/**
 * Customer responses to an itemized quote (besides approving it):
 *  - labor_only: "I'll supply the materials" — drop all part lines
 *  - price_challenge: propose a lower total, with a reason (never below the parts' base cost)
 *  - labor_negotiation: propose a lower labor amount; parts unchanged
 */
export const COUNTER_KINDS = ['labor_only', 'price_challenge', 'labor_negotiation'] as const;
export type CounterKind = (typeof COUNTER_KINDS)[number];

export type CounterResult = { ok: true; proposedTotal: MinorUnits; proposedLabor?: MinorUnits } | { ok: false; reason: string };

export function evaluateCounter(
  totals: QuoteTotals,
  counter: { kind: CounterKind; proposedTotalMinor?: MinorUnits; proposedLaborMinor?: MinorUnits },
  laborOnly: LaborOnlyPolicy,
): CounterResult {
  switch (counter.kind) {
    case 'labor_only':
      if (laborOnly === 'decline') return { ok: false, reason: 'This technician declared no labor-only work for this service' };
      if (totals.materials === 0) return { ok: false, reason: 'This quote has no parts to remove' };
      return { ok: true, proposedTotal: totals.labor };
    case 'price_challenge': {
      const p = counter.proposedTotalMinor;
      if (p === undefined || !Number.isInteger(p) || p <= 0) return { ok: false, reason: 'Propose a total price' };
      if (p >= totals.total) return { ok: false, reason: 'A price challenge must be lower than the quoted total' };
      if (p < totals.partsBase) return { ok: false, reason: 'A price challenge cannot go below the base cost of the parts' };
      return { ok: true, proposedTotal: p };
    }
    case 'labor_negotiation': {
      const l = counter.proposedLaborMinor;
      if (totals.labor <= 0) return { ok: false, reason: 'This quote has no labor lines' };
      if (l === undefined || !Number.isInteger(l) || l <= 0) return { ok: false, reason: 'Propose a labor amount' };
      if (l >= totals.labor) return { ok: false, reason: 'Proposed labor must be lower than the quoted labor' };
      return { ok: true, proposedTotal: totals.total - totals.labor + l, proposedLabor: l };
    }
  }
}

/**
 * Splits a negotiated reduction into adjustment lines: labor first, then markup.
 * Base part cost is never reduced.
 */
export function allocateReduction(totals: QuoteTotals, reduction: MinorUnits): { appliesTo: AdjustmentTarget; amountMinor: MinorUnits }[] {
  const out: { appliesTo: AdjustmentTarget; amountMinor: MinorUnits }[] = [];
  let left = reduction;
  const fromLabor = Math.min(left, Math.max(totals.labor, 0));
  if (fromLabor > 0) out.push({ appliesTo: 'labor', amountMinor: -fromLabor });
  left -= fromLabor;
  const fromMarkup = Math.min(left, Math.max(totals.markup, 0));
  if (fromMarkup > 0) out.push({ appliesTo: 'markup', amountMinor: -fromMarkup });
  left -= fromMarkup;
  if (left > 0) throw new Error('Reduction exceeds labor and markup');
  return out;
}
