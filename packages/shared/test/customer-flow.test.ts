import { describe, expect, it } from 'vitest';
import {
  canTransition,
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
  const totals = quoteTotals([
    { kind: 'labor', totalMinor: 20_000 },
    { kind: 'material', totalMinor: 50_000 },
    { kind: 'transport', totalMinor: 5_000 },
  ]);
  it('computes totals by kind', () => {
    expect(totals).toEqual({ labor: 20_000, materials: 50_000, other: 5_000, total: 75_000 });
  });
  it('labor-only drops materials unless the technician refuses labor-only work', () => {
    expect(evaluateCounter(totals, { kind: 'labor_only' }, 'case_by_case')).toEqual({ ok: true, proposedTotal: 25_000 });
    expect(evaluateCounter(totals, { kind: 'labor_only' }, 'no_labor_only').ok).toBe(false);
  });
  it('price challenge must undercut the total', () => {
    expect(evaluateCounter(totals, { kind: 'price_challenge', proposedTotalMinor: 60_000 }, 'case_by_case')).toEqual({ ok: true, proposedTotal: 60_000 });
    expect(evaluateCounter(totals, { kind: 'price_challenge', proposedTotalMinor: 80_000 }, 'case_by_case').ok).toBe(false);
  });
  it('labor negotiation only changes the labor portion', () => {
    expect(evaluateCounter(totals, { kind: 'labor_negotiation', proposedLaborMinor: 15_000 }, 'case_by_case')).toEqual({
      ok: true,
      proposedTotal: 70_000,
      proposedLabor: 15_000,
    });
  });
});
