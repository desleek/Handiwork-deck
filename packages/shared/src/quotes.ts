import type { MinorUnits } from './money';

export const QUOTE_ITEM_KINDS = ['labor', 'material', 'transport', 'other', 'adjustment'] as const;
export type QuoteItemKind = (typeof QUOTE_ITEM_KINDS)[number];

export interface QuoteItemInput {
  kind: Exclude<QuoteItemKind, 'adjustment'>;
  description: string;
  quantity: number;
  unitPriceMinor: MinorUnits;
}

export interface QuoteTotals {
  labor: MinorUnits;
  materials: MinorUnits;
  other: MinorUnits; // transport + other + adjustments
  total: MinorUnits;
}

export function lineTotal(item: { quantity: number; unitPriceMinor: MinorUnits }): MinorUnits {
  return Math.round(item.quantity * item.unitPriceMinor);
}

export function quoteTotals(items: { kind: QuoteItemKind; totalMinor: MinorUnits }[]): QuoteTotals {
  const t = { labor: 0, materials: 0, other: 0, total: 0 };
  for (const i of items) {
    if (i.kind === 'labor') t.labor += i.totalMinor;
    else if (i.kind === 'material') t.materials += i.totalMinor;
    else t.other += i.totalMinor;
    t.total += i.totalMinor;
  }
  return t;
}

/**
 * Customer responses to an itemized quote (besides approving it):
 *  - labor_only: "I'll supply the materials" — drop all material lines
 *  - price_challenge: propose a lower total, with a reason
 *  - labor_negotiation: propose a lower labor amount; materials/other unchanged
 */
export const COUNTER_KINDS = ['labor_only', 'price_challenge', 'labor_negotiation'] as const;
export type CounterKind = (typeof COUNTER_KINDS)[number];

/** Technician's position on labor-only jobs (customer supplies materials). */
export const LABOR_STANCES = ['accepts_labor_only', 'case_by_case', 'no_labor_only'] as const;
export type LaborStance = (typeof LABOR_STANCES)[number];

export const LABOR_STANCE_LABEL: Record<LaborStance, string> = {
  accepts_labor_only: 'Happy to do labor-only (you supply materials)',
  case_by_case: 'Labor-only considered case by case',
  no_labor_only: 'Supplies own materials — no labor-only jobs',
};

export type CounterResult = { ok: true; proposedTotal: MinorUnits; proposedLabor?: MinorUnits } | { ok: false; reason: string };

/** Validates a counter-offer against the quote and works out the proposed total. */
export function evaluateCounter(
  totals: QuoteTotals,
  counter: { kind: CounterKind; proposedTotalMinor?: MinorUnits; proposedLaborMinor?: MinorUnits },
  stance: LaborStance,
): CounterResult {
  switch (counter.kind) {
    case 'labor_only':
      if (stance === 'no_labor_only') return { ok: false, reason: 'This technician does not take labor-only jobs' };
      if (totals.materials === 0) return { ok: false, reason: 'This quote has no materials to remove' };
      return { ok: true, proposedTotal: totals.total - totals.materials };
    case 'price_challenge': {
      const p = counter.proposedTotalMinor;
      if (p === undefined || !Number.isInteger(p) || p <= 0) return { ok: false, reason: 'Propose a total price' };
      if (p >= totals.total) return { ok: false, reason: 'A price challenge must be lower than the quoted total' };
      return { ok: true, proposedTotal: p };
    }
    case 'labor_negotiation': {
      const l = counter.proposedLaborMinor;
      if (totals.labor === 0) return { ok: false, reason: 'This quote has no labor lines' };
      if (l === undefined || !Number.isInteger(l) || l <= 0) return { ok: false, reason: 'Propose a labor amount' };
      if (l >= totals.labor) return { ok: false, reason: 'Proposed labor must be lower than the quoted labor' };
      return { ok: true, proposedTotal: totals.total - totals.labor + l, proposedLabor: l };
    }
  }
}
