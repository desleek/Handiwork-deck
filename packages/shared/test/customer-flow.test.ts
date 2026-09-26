import { describe, expect, it } from 'vitest';
import {
  adjustLabor,
  allocateReduction,
  canTransition,
  challengeSchedule,
  estimateEtaMinutes,
  commissionFor,
  DEFAULT_COMMISSION,
  DEFAULT_MARKUP_CAP_BPS,
  DEFAULT_TAXONOMY,
  evaluateCounter,
  FAST_TRACK_CHALLENGE_TIMELINE,
  hasCompletionBadge,
  isAnomalousSwing,
  linesOverCap,
  maskContactInfo,
  multiplierFor,
  nextTierGuidance,
  overallRating,
  priceLine,
  quoteTotals,
  rateTierFor,
  reviewTags,
  STANDARD_CHALLENGE_TIMELINE,
  weightedRecentAverage,
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


describe('reviews', () => {
  const scores = { competence: 5, punctuality: 4, professionalism: 5, courtesy: 5, timeline: 3, transparency: 4, quality: 5 };
  it('averages the seven category scores', () => {
    expect(overallRating(scores)).toBe(4.43);
    expect(() => overallRating({ ...scores, quality: 6 })).toThrow();
  });
  it('tags notable scores', () => {
    expect(reviewTags(scores)).toContain('Punctuality 4★');
    expect(reviewTags(scores)).not.toContain('Delivery timeline 3★');
    expect(reviewTags({ ...scores, timeline: 2 })).toContain('Delivery timeline 2★');
  });
  it('weights recent ratings more heavily', () => {
    const now = new Date('2026-09-01');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    // An old 1★ and a fresh 5★: with a 90-day half-life the fresh one dominates.
    expect(weightedRecentAverage([{ value: 1, at: daysAgo(180) }, { value: 5, at: daysAgo(0) }], 90, now)).toBe(4.2);
    expect(weightedRecentAverage([], 90, now)).toBeNull();
  });
});

describe('labor rate adjustment (Section 7a)', () => {
  it('maps the rolling rating to a star tier and labor percentage', () => {
    expect(rateTierFor(4.6)).toMatchObject({ stars: 5, adjustmentBps: 1000 });
    expect(rateTierFor(4.2)).toMatchObject({ stars: 4, adjustmentBps: 500 });
    expect(rateTierFor(3.0)).toMatchObject({ stars: 3, adjustmentBps: 0 });
    expect(rateTierFor(1.6)).toMatchObject({ stars: 2, adjustmentBps: -500 });
    expect(rateTierFor(1.0)).toMatchObject({ stars: 1, adjustmentBps: -1000 });
    expect(rateTierFor(null)).toBeNull();
  });
  it('applies to labor only', () => {
    expect(adjustLabor(100_000, 500)).toBe(105_000);
    expect(adjustLabor(100_000, -1000)).toBe(90_000);
    expect(multiplierFor(4.6, 1000, 5)).toMatchObject({ multiplier: 1.1, tierStars: 5 });
  });
  it('tells technicians the rating needed for the next tier', () => {
    expect(nextTierGuidance(4.2)).toMatchObject({ current: { stars: 4, adjustmentBps: 500 }, ratingNeeded: 4.5 });
    expect(nextTierGuidance(4.9).next).toBeNull();
    expect(nextTierGuidance(null).ratingNeeded).toBe(3.5);
  });
  it('flags a tier drop caused by a single review', () => {
    expect(isAnomalousSwing({ previousStars: 5, newStars: 4, ratingWithoutLatest: 4.7 })).toBe(true);
    expect(isAnomalousSwing({ previousStars: 5, newStars: 4, ratingWithoutLatest: 4.3 })).toBe(false);
    expect(isAnomalousSwing({ previousStars: 4, newStars: 5, ratingWithoutLatest: 4.0 })).toBe(false);
  });
});

describe('price challenge timeline (Section 6c)', () => {
  it('standard: reminders every 4h from hour 6 to 30, admin at 48, final at 72', () => {
    const s = challengeSchedule(STANDARD_CHALLENGE_TIMELINE);
    expect(s.filter((x) => x.step === 'reminder').map((x) => x.atHours)).toEqual([6, 10, 14, 18, 22, 26, 30]);
    expect(s.slice(-2)).toEqual([{ step: 'escalate', atHours: 48 }, { step: 'final', atHours: 72 }]);
  });
  it('fast track compresses into 24h: hourly reminders to hour 8, admin at 8, final at 24', () => {
    const s = challengeSchedule(FAST_TRACK_CHALLENGE_TIMELINE);
    expect(s.filter((x) => x.step === 'reminder').map((x) => x.atHours)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(s.find((x) => x.step === 'escalate')!.atHours).toBe(8);
    expect(s.at(-1)).toEqual({ step: 'final', atHours: 24 });
  });
});

describe('completion badge', () => {
  it('requires consistent platform-paid completions', () => {
    const rule = { minPaidJobs: 3, minCompletionRate: 0.9 };
    expect(hasCompletionBadge({ paidJobs: 5, engagedJobs: 5, refundedOrDisputed: 0 }, rule)).toBe(true);
    expect(hasCompletionBadge({ paidJobs: 2, engagedJobs: 2, refundedOrDisputed: 0 }, rule)).toBe(false);
    expect(hasCompletionBadge({ paidJobs: 5, engagedJobs: 8, refundedOrDisputed: 0 }, rule)).toBe(false);
  });
});

describe('en-route ETA (Section 9)', () => {
  it('uses reported speed when moving, a default urban speed when stopped', () => {
    const from = { lat: 6.6, lng: 3.35 };
    const to = { lat: 6.65, lng: 3.35 }; // ~5.6 km north
    const stopped = estimateEtaMinutes(from, to, { speedMps: 0, defaultSpeedKmh: 25, roadFactor: 1.3 });
    expect(stopped.distanceKm).toBe(7.2);
    expect(stopped.etaMinutes).toBe(18);
    const driving = estimateEtaMinutes(from, to, { speedMps: 12, defaultSpeedKmh: 25, roadFactor: 1.3 });
    expect(driving.etaMinutes).toBe(11);
  });
});
