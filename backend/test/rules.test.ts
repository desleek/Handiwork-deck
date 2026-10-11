import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S } from '../src/domain/settings.ts';
import {
  rollingAverage,
  multiplierContext,
  recalcMultiplier,
  overallScore,
  TECHNICIAN_RATING_FIELDS,
} from '../src/domain/ratings.ts';
import { evaluateLaborOnlyRejection, canSwitchStance } from '../src/domain/laborOnly.ts';
import { buildSchedule, finalActionStatus } from '../src/domain/escalation.ts';
import { attributeFault, tier1Triggered, tier2Triggered, isRestricted, canAppeal } from '../src/domain/penalties.ts';
import { topupBonus, bonusWindowEnd, withdrawalQuote } from '../src/domain/wallet.ts';
import { checkBoostEligibility, priceProfileBoost, canSendAlertToday, boostIsLive } from '../src/domain/boosts.ts';
import { rankCandidates, interleaveSponsored } from '../src/domain/discovery.ts';
import { redactContactDetails } from '../src/domain/privacy.ts';

const N = 100;
const DAY = 86_400_000;
const now = new Date('2026-10-11T12:00:00Z');

// ---------- Section 7 / 7a ----------
test('overall score averages the seven categories and validates range', () => {
  const s = Object.fromEntries(TECHNICIAN_RATING_FIELDS.map((f) => [f, 4]));
  assert.equal(overallScore({ ...s, quality_of_work: 5 }, TECHNICIAN_RATING_FIELDS), 4.14);
  assert.throws(() => overallScore({ ...s, courtesy: 6 }, TECHNICIAN_RATING_FIELDS));
});

test('rolling average weights recent reviews more', () => {
  const avg = rollingAverage(
    [
      { overall: 5, createdAt: now },
      { overall: 1, createdAt: new Date(now.getTime() - 365 * DAY) },
    ],
    now,
    90,
  )!;
  assert.ok(avg > 4.7, `got ${avg}`);
  assert.equal(rollingAverage([], now, 90), null);
});

test('multiplier tiers match the spec table and expose next-tier thresholds', () => {
  const t = S.multiplierTiers;
  assert.equal(multiplierContext(4.8, t).current.laborAdjustmentBps, 1000);
  assert.equal(multiplierContext(4.0, t).current.laborAdjustmentBps, 500);
  assert.equal(multiplierContext(3.0, t).current.laborAdjustmentBps, 0);
  assert.equal(multiplierContext(2.0, t).current.laborAdjustmentBps, -500);
  assert.equal(multiplierContext(1.2, t).current.laborAdjustmentBps, -1000);
  assert.equal(multiplierContext(null, t).current.laborAdjustmentBps, 0);
  const ctx = multiplierContext(4.0, t);
  assert.equal(ctx.next?.ratingNeeded, 4.5);
  assert.equal(ctx.below?.dropsBelow, 3.5);
  assert.equal(multiplierContext(5, t).next, null);
});

test('large swings or swings from few reviews are flagged as anomalies', () => {
  const base = { tiers: S.multiplierTiers, anomalyTierJump: 2, anomalyMinNewReviews: 2 };
  const jump = recalcMultiplier({ ...base, rating: 2.0, previousBps: 500, newReviewsSinceLastCycle: 10 });
  assert.equal(jump.toBps, -500);
  assert.equal(jump.flaggedAnomaly, true);
  const oneBad = recalcMultiplier({ ...base, rating: 3.4, previousBps: 500, newReviewsSinceLastCycle: 1 });
  assert.equal(oneBad.flaggedAnomaly, true);
  const normal = recalcMultiplier({ ...base, rating: 3.4, previousBps: 500, newReviewsSinceLastCycle: 6 });
  assert.equal(normal.flaggedAnomaly, false);
});

// ---------- Section 6b ----------
test('labor-only: decline-from-inception never penalised; otherwise 4th rejection in window exceeds cap of 3', () => {
  assert.deepEqual(evaluateLaborOnlyRejection('decline_from_inception', 10, 3).countsAsRejection, false);
  assert.equal(evaluateLaborOnlyRejection('accept', 2, 3).penaltyApplies, false);
  assert.equal(evaluateLaborOnlyRejection('accept', 3, 3).penaltyApplies, true);
});

test('stance switch has a 30-day cooldown', () => {
  assert.equal(canSwitchStance(new Date(now.getTime() - 29 * DAY), now, 30).allowed, false);
  assert.equal(canSwitchStance(new Date(now.getTime() - 30 * DAY), now, 30).allowed, true);
});

// ---------- Section 6c ----------
test('standard escalation timeline: H0 notify, reminders H6–H30 every 4h, admin H48, final H72', () => {
  const s = buildSchedule(S.priceChallengeStandard);
  assert.deepEqual(
    s.filter((x) => x.type === 'notify_technician').map((x) => x.hour),
    [0, 6, 10, 14, 18, 22, 26, 30],
  );
  assert.equal(s.find((x) => x.type === 'escalate_to_admin')!.hour, 48);
  assert.equal(s.at(-1)!.type, 'final_action');
  assert.equal(s.at(-1)!.hour, 72);
});

test('fast track timeline: hourly reminders to H8, admin at H8, final at H24', () => {
  const s = buildSchedule(S.priceChallengeFastTrack);
  assert.deepEqual(
    s.filter((x) => x.type === 'notify_technician').map((x) => x.hour),
    [0, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(s.find((x) => x.type === 'escalate_to_admin')!.hour, 8);
  assert.equal(s.at(-1)!.hour, 24);
  assert.equal(finalActionStatus(S.priceChallengeFinalAction), 'auto_approved');
});

// ---------- Section 18 ----------
test('fault goes to the last-prompted party after the 14-day timeout; ambiguous to admin', () => {
  const since = new Date(now.getTime() - 15 * DAY);
  assert.deepEqual(attributeFault({ status: 'quoted', actionRequiredFrom: 'customer', actionRequiredSince: since }, now, 14), {
    kind: 'strike',
    party: 'customer',
  });
  assert.deepEqual(attributeFault({ status: 'negotiating', actionRequiredFrom: 'admin', actionRequiredSince: since }, now, 14), {
    kind: 'admin_review',
  });
  assert.equal(
    attributeFault({ status: 'quoted', actionRequiredFrom: 'customer', actionRequiredSince: new Date(now.getTime() - 5 * DAY) }, now, 14).kind,
    'not_stalled',
  );
  assert.equal(attributeFault({ status: 'completed', actionRequiredFrom: 'none', actionRequiredSince: since }, now, 14).kind, 'not_stalled');
});

test('tier 1 at 3 strikes in rolling window; tier 2 after 3 consecutive months of tier 1', () => {
  const strikes = [10, 50, 100].map((d) => new Date(now.getTime() - d * DAY));
  assert.equal(tier1Triggered(strikes, now, 182, 3), true);
  assert.equal(tier1Triggered([...strikes.slice(0, 2), new Date(now.getTime() - 200 * DAY)], now, 182, 3), false);
  assert.equal(tier2Triggered([new Date('2026-07-03'), new Date('2026-08-20'), new Date('2026-09-01')], 3), true);
  assert.equal(tier2Triggered([new Date('2026-06-03'), new Date('2026-08-20'), new Date('2026-09-01')], 3), false);
  assert.equal(tier2Triggered([new Date('2026-12-20'), new Date('2027-01-05'), new Date('2027-02-01')], 3), true);
  assert.equal(canAppeal(new Date(now.getTime() - 179 * DAY), now, 180), true);
  assert.equal(canAppeal(new Date(now.getTime() - 181 * DAY), now, 180), false);
});

test('restrictions block only the listed functions while active', () => {
  const r = [{ restrictedFunctions: ['create_booking'], startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + DAY), liftedAt: null }];
  assert.equal(isRestricted(r, 'create_booking', now), true);
  assert.equal(isRestricted(r, 'chat', now), false);
  assert.equal(isRestricted(r, 'create_booking', new Date(now.getTime() + 2 * DAY)), false);
});

// ---------- Section 15 ----------
test('wallet bonus tiers and 3-month window', () => {
  const end = bonusWindowEnd(new Date(now.getTime() - 10 * DAY), 90, null);
  const b = (amt: number) => topupBonus({ amountMinor: amt * N, now, windowEnd: end, tiers: S.walletBonusTiers, enabled: true });
  assert.equal(b(49_999).bonusBps, 0);
  assert.equal(b(50_000).bonusBps, 10);
  assert.equal(b(99_999).bonusBps, 10);
  assert.equal(b(100_000).bonusBps, 20);
  assert.equal(b(500_000).bonusBps, 20);
  assert.equal(b(500_001).bonusBps, 30);
  assert.equal(b(100_000).bonusMinor, 200 * N); // 0.2% of ₦100k = ₦200
  const expired = bonusWindowEnd(new Date(now.getTime() - 91 * DAY), 90, null);
  assert.equal(topupBonus({ amountMinor: 100_000 * N, now, windowEnd: expired, tiers: S.walletBonusTiers, enabled: true }).bonusMinor, 0);
  const extended = bonusWindowEnd(new Date(now.getTime() - 91 * DAY), 90, new Date(now.getTime() + 7 * DAY));
  assert.ok(extended > now);
});

test('withdrawal fee is shown up front; instant fee is clamped', () => {
  const cfg = {
    standardFeeMinor: S.withdrawalStandardFeeMinor,
    instantFeeBps: S.withdrawalInstantFeeBps,
    instantMinMinor: S.withdrawalInstantFeeMinMinor,
    instantMaxMinor: S.withdrawalInstantFeeMaxMinor,
  };
  assert.equal(withdrawalQuote(50_000 * N, 60_000 * N, 'standard', cfg).feeMinor, 0);
  assert.equal(withdrawalQuote(50_000 * N, 60_000 * N, 'instant', cfg).feeMinor, 500 * N);
  assert.equal(withdrawalQuote(5_000 * N, 60_000 * N, 'instant', cfg).feeMinor, 100 * N);
  assert.equal(withdrawalQuote(1_000_000 * N, 2_000_000 * N, 'instant', cfg).feeMinor, 2_000 * N);
  assert.equal(withdrawalQuote(70_000 * N, 60_000 * N, 'standard', cfg).ok, false);
});

// ---------- Section 16 ----------
test('boost eligibility gate is 3★+ and respects suspension', () => {
  const base = { featureEnabled: true, minRating: 3, privilegesSuspended: false, restricted: false, verified: true };
  assert.equal(checkBoostEligibility({ ...base, ratingAvg: 3.0 }), null);
  assert.equal(checkBoostEligibility({ ...base, ratingAvg: 2.99 }), 'RATING_BELOW_THRESHOLD');
  assert.equal(checkBoostEligibility({ ...base, ratingAvg: null }), 'NO_RATING_YET');
  assert.equal(checkBoostEligibility({ ...base, ratingAvg: 4.5, privilegesSuspended: true }), 'PRIVILEGES_SUSPENDED');
});

test('boost pricing honours the ₦5,000/hr cap and flat mode', () => {
  assert.deepEqual(priceProfileBoost({ ratePerHourMinor: 5_000 * N, hours: 4, capMinor: 5_000 * N, mode: 'flat' }), { totalMinor: 20_000 * N });
  assert.deepEqual(priceProfileBoost({ ratePerHourMinor: 3_000 * N, hours: 4, capMinor: 5_000 * N, mode: 'flat' }), { error: 'RATE_NOT_FLAT' });
  assert.deepEqual(priceProfileBoost({ ratePerHourMinor: 3_000 * N, hours: 2, capMinor: 5_000 * N, mode: 'variable' }), { totalMinor: 6_000 * N });
  assert.deepEqual(priceProfileBoost({ ratePerHourMinor: 6_000 * N, hours: 1, capMinor: 5_000 * N, mode: 'variable' }), { error: 'RATE_ABOVE_CAP' });
  assert.equal(canSendAlertToday(2, 2), false);
  // A paid boost runs to its end time regardless of later rating drops
  assert.equal(boostIsLive({ status: 'active', startsAt: new Date(now.getTime() - 3600e3), endsAt: new Date(now.getTime() + 3600e3) }, now), true);
});

// ---------- Discovery ----------
test('boosted technicians rank above organic, by bid then rating; ads capped at 1 per 10', () => {
  const c = (id: string, rating: number, boost: number | null) => ({
    id, ratingAvg: rating, ratingCount: 20, distanceKm: 2, isOnline: true, boostRateMinor: boost,
  });
  const ranked = rankCandidates(
    [c('a', 5, null), c('b', 3.2, 3_000), c('c', 4.9, 5_000), c('d', 3.5, 5_000)],
    'highest_bid_then_rating',
  );
  assert.deepEqual(ranked.map((r) => [r.item.id, r.label]), [['c', 'promoted'], ['d', 'promoted'], ['b', 'promoted'], ['a', null]]);

  const organic = Array.from({ length: 25 }, (_, i) => ({ item: c(`o${i}`, 4, null), label: null }));
  const mixed = interleaveSponsored(organic, ['ad1', 'ad2', 'ad3'], 10);
  assert.equal(mixed.filter((m) => m.type === 'sponsored').length, 2);
  assert.equal(mixed[10].type, 'sponsored');
});

// ---------- Section 8 ----------
test('contact details are redacted before approval', () => {
  for (const s of ['call me on 0803 123 4567', 'my number is +234-803-123-4567', 'email me: a.b@example.com', 'zero eight zero three one two three four']) {
    const r = redactContactDetails(s);
    assert.equal(r.redacted, true, s);
    assert.ok(!/\d{4}/.test(r.text), r.text);
  }
  const ok = redactContactDetails('I can come at 3pm, the job is about 2 hours');
  assert.equal(ok.redacted, false);
});

// ---------- Section 12 (ads) ----------
import { clickThroughRate, nextCampaignStatus, priceCampaign } from '../src/domain/ads.ts';

test('ad slot pricing is per day and bounded', () => {
  assert.deepEqual(priceCampaign('sponsored_search', 7, S.adSlotPricePerDayMinor, S.adMaxCampaignDays), { priceMinor: 70_000 * N });
  assert.deepEqual(priceCampaign('deals_brand', 0, S.adSlotPricePerDayMinor, 90), { error: 'INVALID_DURATION' });
  assert.deepEqual(priceCampaign('deals_brand', 91, S.adSlotPricePerDayMinor, 90), { error: 'INVALID_DURATION' });
});

test('campaigns go live only when approved, paid and in window', () => {
  const base = { status: 'approved', paymentStatus: 'paid' as const, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + DAY) };
  assert.equal(nextCampaignStatus(base, now), 'active');
  assert.equal(nextCampaignStatus({ ...base, paymentStatus: 'unpaid' }, now), 'approved');
  assert.equal(nextCampaignStatus({ ...base, startsAt: new Date(now.getTime() + DAY) }, now), 'approved');
  assert.equal(nextCampaignStatus({ ...base, status: 'active', endsAt: new Date(now.getTime() - 1) }, now), 'ended');
  assert.equal(nextCampaignStatus({ ...base, status: 'pending_review' }, now), 'pending_review');
  assert.equal(nextCampaignStatus({ ...base, status: 'paused' }, now), 'paused');
  assert.equal(clickThroughRate(1000, 25), 2.5);
  assert.equal(clickThroughRate(0, 0), null);
});

// ---------- Admin setting validation ----------
import { SETTING_SCHEMAS } from '../src/domain/settingsSchema.ts';
import { overlaps } from '../src/domain/boosts.ts';

test('default structured settings pass their own validation', () => {
  for (const [key, schema] of Object.entries(SETTING_SCHEMAS)) {
    const r = schema.safeParse((S as any)[key]);
    assert.ok(r.success, `${key}: ${JSON.stringify(r.error?.issues)}`);
  }
});

test('broken tier tables and timelines are rejected', () => {
  const gap = [...S.walletBonusTiers];
  gap[1] = { ...gap[1], minTopupMinor: gap[1].minTopupMinor + 100 };
  assert.equal(SETTING_SCHEMAS.walletBonusTiers.safeParse(gap).success, false);
  assert.equal(SETTING_SCHEMAS.multiplierTiers.safeParse(S.multiplierTiers.filter((t) => t.minRating !== 0)).success, false);
  assert.equal(SETTING_SCHEMAS.priceChallengeFastTrack.safeParse({ ...S.priceChallengeFastTrack, escalateAtHours: 30 }).success, false);
});

test('boost windows overlap check', () => {
  const h = 3_600_000;
  const a = { startsAt: now, endsAt: new Date(now.getTime() + 4 * h) };
  assert.equal(overlaps(a, { startsAt: new Date(now.getTime() + 4 * h), endsAt: new Date(now.getTime() + 5 * h) }), false);
  assert.equal(overlaps(a, { startsAt: new Date(now.getTime() + 3 * h), endsAt: new Date(now.getTime() + 5 * h) }), true);
});
