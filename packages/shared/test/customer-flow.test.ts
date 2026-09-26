import { describe, expect, it } from 'vitest';
import {
  allocateReduction,
  canTransition,
  commissionFor,
  DEFAULT_COMMISSION,
  DEFAULT_MARKUP_CAP_BPS,
  linesOverCap,
  nextTierGuidance,
  priceLine,
  requiredCustomerRatingCategories,
  DEFAULT_TAXONOMY,
  evaluateCounter,
  maskContactInfo,
  overallRating,
  performanceMultiplier,
  quoteTotals,
  reviewTags,
} from '../src';

describe('taxonomy', () => {
  it('has unique slugs and exactly one "other" entry per supercategory', () => {
    const slugs = DEFAULT_TAXONOMY.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const seg of ['household_office', 'construction_plant']) {
      expect(DEFAULT_TAXONOMY.filter((c) => c.segment === seg && c.isOther)).toHaveLength(1);
    }
  });
});

describe('booking transitions', () => {
  it('allows instant book (open -> assigned) and counter acceptance (quoted -> assigned) only for system', () => {
    expect(canTransition('open', 'assigned', 'system')).toBe(true);
    expect(canTransition('open', 'assigned', 'customer')).toBe(false);
    expect(canTransition('quoted', 'assigned', 'system')).toBe(true);
    expect(canTransition('quoted', 'assigned', 'technician')).toBe(false);
    expect(canTransition('assigned', 'open', 'system')).toBe(true);
    expect(canTransition('assigned', 'open', 'technician')).toBe(false);
  });
});

describe('reviews', () => {
  const scores = { quality: 5, punctuality: 4, communication: 5, value: 3, professionalism: 5 };
  it('averages category scores', () => {
    expect(overallRating(scores)).toBe(4.4);
    expect(() => overallRating({ ...scores, value: 6 })).toThrow();
  });
  it('tags notable scores', () => {
    expect(reviewTags(scores)).toEqual(['Quality of work 5★', 'Punctuality 4★', 'Communication 5★', 'Professionalism 5★']);
    expect(reviewTags({ ...scores, value: 2 })).toContain('Value for money 2★');
  });
});

describe('performance multiplier', () => {
  it('keeps new technicians neutral', () => {
    expect(performanceMultiplier({ ratingAvg: 5, ratingCount: 2, completedJobs: 2, technicianCancellations: 0, disputes: 0 })).toMatchObject({
      multiplier: 1,
      tier: 'new',
    });
  });
  it('rewards top performers and penalises unreliable ones, within bounds', () => {
    const top = performanceMultiplier({ ratingAvg: 4.9, ratingCount: 40, completedJobs: 50, technicianCancellations: 1, disputes: 0 });
    expect(top).toMatchObject({ multiplier: 1.2, tier: 'elite' });
    expect(top.reasons).toHaveLength(2);
    const poor = performanceMultiplier({ ratingAvg: 3.1, ratingCount: 10, completedJobs: 10, technicianCancellations: 5, disputes: 3 });
    expect(poor.multiplier).toBe(0.75);
    expect(poor.tier).toBe('under_review');
  });
});

describe('contact masking', () => {
  it('hides phone numbers, emails and chat links but keeps prices', () => {
    expect(maskContactInfo('call me on 0803 123 4567').text).toBe('call me on [contact hidden]');
    expect(maskContactInfo('+234-803-123-4567 or me@mail.com').text).toBe('[contact hidden] or [contact hidden]');
    expect(maskContactInfo('wa.me/2348031234567 please').text).toBe('[contact hidden] please');
    expect(maskContactInfo('dm @tunde_fixes').text).toBe('dm [contact hidden]');
    const price = maskContactInfo('I can do it for 15,000 in 2 hours');
    expect(price).toEqual({ text: 'I can do it for 15,000 in 2 hours', masked: false });
  });
});

describe('quote counters', () => {
  // labor 20k, parts base 50k + 20% markup 10k
  const totals = quoteTotals([
    priceLine({ kind: 'labor', description: 'Labor', quantity: 1, unitPriceMinor: 20_000 }),
    priceLine({ kind: 'material', description: 'Cistern', quantity: 1, unitPriceMinor: 50_000, markupBps: 2000 }),
  ]);
  it('computes labor / parts base / markup totals', () => {
    expect(totals).toEqual({ labor: 20_000, partsBase: 50_000, markup: 10_000, materials: 60_000, total: 80_000 });
  });
  it('labor-only drops parts unless the technician declined labor-only for the category', () => {
    expect(evaluateCounter(totals, { kind: 'labor_only' }, 'accept')).toEqual({ ok: true, proposedTotal: 20_000 });
    expect(evaluateCounter(totals, { kind: 'labor_only' }, 'decline').ok).toBe(false);
  });
  it('price challenge must undercut the total but not the parts base cost', () => {
    expect(evaluateCounter(totals, { kind: 'price_challenge', proposedTotalMinor: 70_000 }, 'accept')).toEqual({ ok: true, proposedTotal: 70_000 });
    expect(evaluateCounter(totals, { kind: 'price_challenge', proposedTotalMinor: 90_000 }, 'accept').ok).toBe(false);
    expect(evaluateCounter(totals, { kind: 'price_challenge', proposedTotalMinor: 45_000 }, 'accept').ok).toBe(false);
  });
  it('labor negotiation only changes the labor portion', () => {
    expect(evaluateCounter(totals, { kind: 'labor_negotiation', proposedLaborMinor: 15_000 }, 'accept')).toEqual({
      ok: true,
      proposedTotal: 75_000,
      proposedLabor: 15_000,
    });
  });
  it('allocates reductions to labor first, then markup, never parts base', () => {
    expect(allocateReduction(totals, 25_000)).toEqual([
      { appliesTo: 'labor', amountMinor: -20_000 },
      { appliesTo: 'markup', amountMinor: -5_000 },
    ]);
    expect(() => allocateReduction(totals, 31_000)).toThrow();
  });
});

describe('pricing model', () => {
  it('discloses markup separately on part lines', () => {
    expect(priceLine({ kind: 'material', description: 'Pipe', quantity: 3, unitPriceMinor: 10_000, markupBps: 1500 })).toEqual({
      kind: 'material',
      baseMinor: 30_000,
      markupBps: 1500,
      markupMinor: 4_500,
      totalMinor: 34_500,
    });
  });
  it('charges commission on labor and markup only, never on base part cost', () => {
    const t = { labor: 100_000, markup: 20_000, total: 220_000 }; // parts base 100k
    expect(commissionFor(t, DEFAULT_COMMISSION)).toEqual({ laborFee: 18_000, markupFee: 4_000, platformFee: 22_000, technicianPayout: 198_000 });
  });
  it('flags part lines above the markup cap', () => {
    expect(linesOverCap([{ kind: 'labor' }, { kind: 'material', markupBps: 2000 }, { kind: 'material', markupBps: 2500 }], DEFAULT_MARKUP_CAP_BPS)).toEqual([2]);
  });
});

describe('next-tier guidance', () => {
  it('tells new technicians how many jobs remain', () => {
    const g = nextTierGuidance({ ratingAvg: 0, ratingCount: 0, completedJobs: 1, technicianCancellations: 0, disputes: 0 });
    expect(g.current.tier).toBe('new');
    expect(g.actions[0]!.action).toMatch(/Complete 2 more jobs/);
  });
  it('shows which improvement reaches the next tier', () => {
    const g = nextTierGuidance({ ratingAvg: 4.2, ratingCount: 20, completedJobs: 20, technicianCancellations: 3, disputes: 0 });
    expect(g.current).toMatchObject({ multiplier: 1, tier: 'standard' });
    expect(g.nextTier).toEqual({ tier: 'trusted', multiplier: 1.05 });
    const rating = g.actions.find((a) => a.action.includes('4.5'))!;
    expect(rating).toMatchObject({ resultingMultiplier: 1.1, reachesNextTier: true });
    const completion = g.actions.find((a) => a.action.includes('95%'))!;
    expect(completion.action).toMatch(/Complete 37 more jobs/);
    expect(completion.resultingMultiplier).toBe(1.05);
  });
});

describe('customer ratings', () => {
  it('only asks about materials on labor-only jobs', () => {
    expect(requiredCustomerRatingCategories(false)).toEqual(['payment', 'scope', 'conduct']);
    expect(requiredCustomerRatingCategories(true)).toContain('materials');
  });
});
