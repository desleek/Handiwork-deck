/**
 * Construction & plant erection rules (Section 17).
 *
 * Every BOQ line follows the same labor/materials separation and markup-cap rules as a standard
 * quote, so pricing reuses the quote engine. On top of that: consultancy fee bands, the
 * no-show refund rule, and milestone allocation (commission is applied per milestone).
 */
import { applyBps, computeTotals, priceQuote, type PricedLine, type QuoteItemInput, type QuoteTotals } from './pricing.ts';

export interface Band {
  minMinor: number;
  maxMinor: number;
}

export function bandFor(categorySlug: string, bands: Record<string, Band>, fallback: Band): Band {
  return bands[categorySlug] ?? fallback;
}

/** Technician-set consultancy fee must sit inside the admin band for the trade (anti price-gouging). */
export function checkConsultancyFee(feeMinor: number, band: Band): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(feeMinor) || feeMinor < band.minMinor || feeMinor > band.maxMinor) {
    return { ok: false, message: `The consultancy fee must be between ₦${(band.minMinor / 100).toLocaleString('en-NG')} and ₦${(band.maxMinor / 100).toLocaleString('en-NG')}` };
  }
  return { ok: true };
}

export function consultancySplit(feeMinor: number, commissionBps: number) {
  const commissionMinor = applyBps(feeMinor, commissionBps);
  return { commissionMinor, technicianMinor: feeMinor - commissionMinor };
}

/**
 * Non-refundable once the visit happens. Refundable on technician no-show if the admin setting
 * allows it — but only after a grace period past the agreed visit time, and only if the technician
 * hasn't already marked the visit done (if they have, it becomes a dispute for an admin).
 */
export function noShowDecision(p: {
  status: string;
  visitAt: Date | null;
  visitedAt: Date | null;
  now: Date;
  graceHours: number;
  refundOnNoShow: boolean;
}): 'refund' | 'dispute' | 'too_early' | 'not_refundable' | 'invalid' {
  if (p.status !== 'paid' && p.status !== 'visited') return 'invalid';
  if (p.visitedAt) return 'dispute';
  if (!p.visitAt || p.now.getTime() < p.visitAt.getTime() + p.graceHours * 3_600_000) return 'too_early';
  return p.refundOnNoShow ? 'refund' : 'not_refundable';
}

// ---------------------------------------------------------------------------------------- BOQ

export interface BoqItemInput {
  kind: 'labor' | 'part';
  description: string;
  unit: string;
  quantity: number;
  /** Labor: rate before performance multiplier. Material: base unit cost. Minor units. */
  unitRateMinor: number;
  markupBps?: number;
  /** 1-based milestone the line belongs to. */
  milestone: number;
}

export interface BoqContext {
  markupCapBps: number;
  laborCommissionBps: number;
  markupCommissionBps: number;
  multiplierBps: number;
  approvedExceptionCaps?: Map<number, number>;
}

export interface MilestoneInput {
  title: string;
}

export interface MilestoneBreakdown {
  position: number;
  title: string;
  linePositions: number[];
  totals: QuoteTotals;
}

export type BoqIssue = { code: string; position: number; message: string; capBps?: number };

export interface PricedBoq {
  lines: (PricedLine & { unit: string; milestone: number })[];
  totals: QuoteTotals;
  milestones: MilestoneBreakdown[];
  issues: BoqIssue[];
}

export function priceBoq(items: BoqItemInput[], milestones: MilestoneInput[], ctx: BoqContext, maxMilestones: number): PricedBoq {
  const quoteItems: QuoteItemInput[] = items.map((i, idx) => ({
    kind: i.kind,
    description: i.description,
    quantity: i.quantity,
    unitCostMinor: i.unitRateMinor,
    markupBps: i.kind === 'part' ? i.markupBps ?? 0 : 0,
    approvedExceptionCapBps: ctx.approvedExceptionCaps?.get(idx + 1) ?? null,
  }));
  // BOQs are pre-purchase estimates, so the receipt rule doesn't apply at this stage.
  const priced = priceQuote(quoteItems, {
    markupCapBps: ctx.markupCapBps,
    receiptThresholdMinor: Number.MAX_SAFE_INTEGER,
    laborCommissionBps: ctx.laborCommissionBps,
    markupCommissionBps: ctx.markupCommissionBps,
    multiplierBps: ctx.multiplierBps,
  });
  const issues: BoqIssue[] = [...priced.issues];
  const lines = priced.lines.map((l, i) => ({ ...l, unit: items[i].unit, milestone: items[i].milestone }));

  if (milestones.length === 0) issues.push({ code: 'NO_MILESTONES', position: 0, message: 'Agree at least one milestone' });
  if (milestones.length > maxMilestones) issues.push({ code: 'TOO_MANY_MILESTONES', position: 0, message: `Use at most ${maxMilestones} milestones` });
  items.forEach((it, i) => {
    if (!Number.isInteger(it.milestone) || it.milestone < 1 || it.milestone > milestones.length) {
      issues.push({ code: 'UNASSIGNED_LINE', position: i + 1, message: `Line ${i + 1} must belong to one of the milestones` });
    }
    if (!it.unit?.trim()) issues.push({ code: 'MISSING_UNIT', position: i + 1, message: `Line ${i + 1} needs a unit (e.g. m², m³, nr, bag)` });
  });

  const breakdown: MilestoneBreakdown[] = milestones.map((m, mi) => {
    const mine = lines.filter((l) => l.milestone === mi + 1);
    if (mine.length === 0) issues.push({ code: 'EMPTY_MILESTONE', position: 0, message: `Milestone "${m.title}" has no lines` });
    return {
      position: mi + 1,
      title: m.title,
      linePositions: mine.map((l) => l.position),
      // Commission is computed per milestone (Section 17, Step 4) — not once on the whole project.
      totals: computeTotals(mine, ctx),
    };
  });

  // Project totals are the sum of milestone totals so funding, payouts and commission always reconcile.
  const sum = (k: keyof QuoteTotals) => breakdown.reduce((a, m) => a + m.totals[k], 0);
  const totals: QuoteTotals = {
    laborTotalMinor: sum('laborTotalMinor'),
    partsBaseTotalMinor: sum('partsBaseTotalMinor'),
    markupTotalMinor: sum('markupTotalMinor'),
    customerTotalMinor: sum('customerTotalMinor'),
    laborCommissionMinor: sum('laborCommissionMinor'),
    markupCommissionMinor: sum('markupCommissionMinor'),
    platformCommissionMinor: sum('platformCommissionMinor'),
    technicianNetMinor: sum('technicianNetMinor'),
  };
  if (breakdown.length === 0) Object.assign(totals, priced.totals);

  return { lines, totals, milestones: breakdown, issues };
}

/** Milestones are funded one at a time, in order; the next can be funded once the previous is funded. */
export function canFundMilestone(position: number, statuses: { position: number; status: string }[]): boolean {
  const me = statuses.find((m) => m.position === position);
  if (!me || me.status !== 'pending') return false;
  return statuses.filter((m) => m.position < position).every((m) => ['funded', 'awaiting_confirmation', 'released'].includes(m.status));
}

/** Analytics helpers for the construction vertical (Section 17 admin). */
export function conversionRate(consultationsVisited: number, boqsApproved: number): number | null {
  return consultationsVisited > 0 ? Math.round((boqsApproved / consultationsVisited) * 1000) / 10 : null;
}
