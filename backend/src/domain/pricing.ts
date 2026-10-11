/**
 * Itemized quote / invoice engine (Sections 5, 5a, 7a, 6d).
 *
 * Rules enforced here (and therefore at the API level, independent of any UI):
 *  - Labor and parts are always separate line items, never a lump sum.
 *  - Markup only applies to parts and is hard-capped (default 20%), unless an approved
 *    Demand Notice exception or a permanent per-technician override raises the cap for that line.
 *  - Markup is disclosed per line: base cost, markup %, markup amount.
 *  - Parts above the receipt threshold require proof of purchase.
 *  - Commission: % of labor + % of disclosed markup; zero on base part cost.
 *  - The performance multiplier adjusts labor only and is frozen into the quote at submission.
 */

export type ItemKind = 'labor' | 'part';

export interface QuoteItemInput {
  kind: ItemKind;
  description: string;
  quantity: number;
  /** Labor: the technician's base rate (pre-multiplier). Part: base unit cost. Minor units. */
  unitCostMinor: number;
  /** Parts only. */
  markupBps?: number;
  receiptUrl?: string | null;
  sellerId?: string | null;
  /** Markup cap that applies to this specific line (approved Demand Notice). */
  approvedExceptionCapBps?: number | null;
}

export interface PricingContext {
  markupCapBps: number;
  /** Permanent per-technician override, if granted. Replaces the platform cap. */
  technicianCapOverrideBps?: number | null;
  receiptThresholdMinor: number;
  laborCommissionBps: number;
  markupCommissionBps: number;
  /** Signed basis points, e.g. 1000 = +10%, -500 = -5%. */
  multiplierBps: number;
}

export interface PricedLine {
  position: number;
  kind: ItemKind;
  description: string;
  quantity: number;
  /** Labor: base rate before multiplier. */
  baseLaborMinor: number | null;
  /** Labor: rate after multiplier. Part: base unit cost. */
  unitCostMinor: number;
  markupBps: number;
  markupMinor: number;
  lineTotalMinor: number;
  receiptRequired: boolean;
  receiptUrl: string | null;
  sellerId: string | null;
  effectiveCapBps: number | null;
}

export type PricingIssueCode =
  | 'NO_LABOR_LINE'
  | 'MARKUP_ON_LABOR'
  | 'MARKUP_OVER_CAP'
  | 'RECEIPT_REQUIRED'
  | 'INVALID_QUANTITY'
  | 'INVALID_AMOUNT';

export interface PricingIssue {
  code: PricingIssueCode;
  position: number;
  message: string;
  /** For MARKUP_OVER_CAP: the cap that was exceeded — the technician may file a Demand Notice. */
  capBps?: number;
}

export interface QuoteTotals {
  laborTotalMinor: number;
  partsBaseTotalMinor: number;
  markupTotalMinor: number;
  customerTotalMinor: number;
  laborCommissionMinor: number;
  markupCommissionMinor: number;
  platformCommissionMinor: number;
  technicianNetMinor: number;
}

export interface PricedQuote {
  lines: PricedLine[];
  totals: QuoteTotals;
  issues: PricingIssue[];
  /** True when the only blocking issues are markups above cap — quote can go to "pending exception". */
  exceptionEligible: boolean;
}

/** Banker-free rounding to the nearest minor unit; half away from zero. */
export function roundMinor(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function applyBps(amountMinor: number, bps: number): number {
  return roundMinor((amountMinor * bps) / 10_000);
}

/** Labor rate after the performance multiplier. */
export function applyMultiplier(baseLaborMinor: number, multiplierBps: number): number {
  return roundMinor(baseLaborMinor + (baseLaborMinor * multiplierBps) / 10_000);
}

export function priceQuote(items: QuoteItemInput[], ctx: PricingContext): PricedQuote {
  const issues: PricingIssue[] = [];
  const platformCap = ctx.technicianCapOverrideBps ?? ctx.markupCapBps;

  const lines: PricedLine[] = items.map((item, i) => {
    const position = i + 1;
    if (!(item.quantity > 0) || !Number.isFinite(item.quantity)) {
      issues.push({ code: 'INVALID_QUANTITY', position, message: 'Quantity must be greater than zero' });
    }
    if (!Number.isInteger(item.unitCostMinor) || item.unitCostMinor < 0) {
      issues.push({ code: 'INVALID_AMOUNT', position, message: 'Amount must be a non-negative whole number of minor units' });
    }

    if (item.kind === 'labor') {
      if ((item.markupBps ?? 0) !== 0) {
        issues.push({ code: 'MARKUP_ON_LABOR', position, message: 'Markup can only be applied to parts' });
      }
      const rate = applyMultiplier(item.unitCostMinor, ctx.multiplierBps);
      return {
        position,
        kind: 'labor',
        description: item.description,
        quantity: item.quantity,
        baseLaborMinor: item.unitCostMinor,
        unitCostMinor: rate,
        markupBps: 0,
        markupMinor: 0,
        lineTotalMinor: roundMinor(rate * item.quantity),
        receiptRequired: false,
        receiptUrl: null,
        sellerId: null,
        effectiveCapBps: null,
      };
    }

    const markupBps = item.markupBps ?? 0;
    const cap = Math.max(platformCap, item.approvedExceptionCapBps ?? 0);
    if (markupBps > cap) {
      issues.push({
        code: 'MARKUP_OVER_CAP',
        position,
        capBps: cap,
        message: `Markup ${markupBps / 100}% exceeds the ${cap / 100}% cap. Request a cap exception to proceed.`,
      });
    }
    const baseLine = roundMinor(item.unitCostMinor * item.quantity);
    const markupMinor = applyBps(baseLine, markupBps);
    const receiptRequired = item.unitCostMinor * item.quantity > ctx.receiptThresholdMinor;
    if (receiptRequired && !item.receiptUrl) {
      issues.push({
        code: 'RECEIPT_REQUIRED',
        position,
        message: 'Proof of purchase is required for parts above the receipt threshold',
      });
    }
    return {
      position,
      kind: 'part',
      description: item.description,
      quantity: item.quantity,
      baseLaborMinor: null,
      unitCostMinor: item.unitCostMinor,
      markupBps,
      markupMinor,
      lineTotalMinor: baseLine + markupMinor,
      receiptRequired,
      receiptUrl: item.receiptUrl ?? null,
      sellerId: item.sellerId ?? null,
      effectiveCapBps: cap,
    };
  });

  if (!lines.some((l) => l.kind === 'labor')) {
    issues.push({ code: 'NO_LABOR_LINE', position: 0, message: 'A quote must include at least one labor line' });
  }

  const totals = computeTotals(lines, ctx);
  const blocking = issues.filter((i) => i.code !== 'MARKUP_OVER_CAP');
  return {
    lines,
    totals,
    issues,
    exceptionEligible: blocking.length === 0 && issues.some((i) => i.code === 'MARKUP_OVER_CAP'),
  };
}

export function computeTotals(
  lines: Pick<PricedLine, 'kind' | 'lineTotalMinor' | 'markupMinor'>[],
  ctx: Pick<PricingContext, 'laborCommissionBps' | 'markupCommissionBps'>,
): QuoteTotals {
  let labor = 0;
  let partsBase = 0;
  let markup = 0;
  for (const l of lines) {
    if (l.kind === 'labor') labor += l.lineTotalMinor;
    else {
      partsBase += l.lineTotalMinor - l.markupMinor;
      markup += l.markupMinor;
    }
  }
  const laborCommission = applyBps(labor, ctx.laborCommissionBps);
  const markupCommission = applyBps(markup, ctx.markupCommissionBps);
  const customerTotal = labor + partsBase + markup;
  const platformCommission = laborCommission + markupCommission;
  return {
    laborTotalMinor: labor,
    partsBaseTotalMinor: partsBase,
    markupTotalMinor: markup,
    customerTotalMinor: customerTotal,
    laborCommissionMinor: laborCommission,
    markupCommissionMinor: markupCommission,
    platformCommissionMinor: platformCommission,
    technicianNetMinor: customerTotal - platformCommission,
  };
}

/**
 * Split of a captured job payment into ledger components (Section 11).
 * Base part cost goes to the technician in full (it reimburses their purchase).
 */
export function splitPayment(totals: QuoteTotals) {
  return [
    { recipient: 'technician', component: 'labor_net', amountMinor: totals.laborTotalMinor - totals.laborCommissionMinor },
    { recipient: 'technician', component: 'parts_base', amountMinor: totals.partsBaseTotalMinor },
    { recipient: 'technician', component: 'markup_net', amountMinor: totals.markupTotalMinor - totals.markupCommissionMinor },
    { recipient: 'platform', component: 'labor_commission', amountMinor: totals.laborCommissionMinor },
    { recipient: 'platform', component: 'markup_commission', amountMinor: totals.markupCommissionMinor },
  ].filter((s) => s.amountMinor !== 0) as {
    recipient: 'technician' | 'platform';
    component: string;
    amountMinor: number;
  }[];
}

/** Labor-only counter (Section 6b): strip parts, keep labor exactly as quoted. */
export function laborOnlyItems(items: QuoteItemInput[]): QuoteItemInput[] {
  return items.filter((i) => i.kind === 'labor');
}

/**
 * Price challenge outcome (Section 6c): replace the challenged part's base cost with the
 * customer's verified evidence price. Markup % is preserved, so markup shrinks with the base.
 */
export function applyChallengedPrice(items: QuoteItemInput[], position: number, evidenceUnitCostMinor: number) {
  return items.map((item, i) =>
    i + 1 === position && item.kind === 'part' ? { ...item, unitCostMinor: evidenceUnitCostMinor } : item,
  );
}

/**
 * Labor negotiation (Section 6d): scale the job's labor lines so they sum to the agreed amount.
 * Only this job's quote changes — the technician's public standard rate is untouched.
 */
export function applyNegotiatedLabor(lines: PricedLine[], agreedLaborMinor: number): PricedLine[] {
  const current = lines.filter((l) => l.kind === 'labor').reduce((s, l) => s + l.lineTotalMinor, 0);
  if (current === 0) return lines;
  let remaining = agreedLaborMinor;
  const laborLines = lines.filter((l) => l.kind === 'labor');
  return lines.map((l) => {
    if (l.kind !== 'labor') return l;
    const isLast = l === laborLines[laborLines.length - 1];
    const total = isLast ? remaining : roundMinor((l.lineTotalMinor * agreedLaborMinor) / current);
    remaining -= total;
    return { ...l, lineTotalMinor: total, unitCostMinor: roundMinor(total / l.quantity) };
  });
}
