/**
 * Every tunable business rule in the spec, with its default.
 * Stored rows in `platform_settings` override these per key; admins edit them from the panel.
 * Money values are in minor units (kobo). Percentages are basis points (100 bps = 1%).
 */

import { DEFAULT_FEE_SCHEDULES, type FeeSchedule } from './fees.ts';

export interface RatingTier {
  /** Minimum rolling average (inclusive) to be in this tier. */
  minRating: number;
  stars: 1 | 2 | 3 | 4 | 5;
  laborAdjustmentBps: number;
}

export interface WalletBonusTier {
  minTopupMinor: number;
  /** Exclusive upper bound; null = unbounded. */
  maxTopupMinor: number | null;
  bonusBps: number;
}

export interface EscalationTimeline {
  /** Hours after submission by which the technician is expected to respond. */
  respondByHours: number;
  /** Repeating notifications run from this hour... */
  remindFromHours: number;
  /** ...through this hour... */
  remindUntilHours: number;
  /** ...every N hours. */
  remindEveryHours: number;
  /** Auto-escalate to admin (email + WhatsApp to technician). */
  escalateAtHours: number;
  /** Final automatic action. */
  finalActionAtHours: number;
}

export interface PlatformSettings {
  currency: string;

  // Section 5 — pricing
  markupCapBps: number;
  receiptThresholdMinor: number;
  laborCommissionBps: number;
  markupCommissionBps: number;
  /** Optional customer-side service fee on top of the invoice (0 by default; spec doesn't require one). */
  customerServiceFeeBps: number;

  // Section 6b — labor-only
  laborOnlyRejectionCap: number;
  laborOnlyRejectionWindowDays: number;
  laborOnlyRejectionPenalty: number; // rating points subtracted from the rolling average
  laborOnlyStanceCooldownDays: number;

  // Section 6c — price challenges
  priceChallengeStandard: EscalationTimeline;
  priceChallengeFastTrack: EscalationTimeline;
  /** Uniform global rule at the final hour. */
  priceChallengeFinalAction: 'auto_approve_customer_evidence' | 'auto_cancel_redirect_labor_only';

  // Section 7 / 7a — ratings & performance multiplier
  ratingHalfLifeDays: number;
  multiplierCycleDays: number;
  multiplierTiers: RatingTier[];
  /** Flag for admin review if a single recalculation moves this many tiers or more. */
  multiplierAnomalyTierJump: number;
  /** ...or if the swing is driven by fewer than this many new reviews. */
  multiplierAnomalyMinNewReviews: number;
  completionBadgeMinJobs: number;

  // Section 10 — seller registry
  sellerAutoVerifyAfterCleanApprovals: number;

  // Section 11 — gateways
  gatewayPriority: string[];
  /** Per-provider fee schedules used for bonus economics and margin reporting (Section 15). */
  gatewayFeeSchedules: Record<string, FeeSchedule>;
  /** Fallback average job value for economics when there isn't enough real data yet. */
  economicsAvgJobMinor: number;

  // Section 15 — wallet & withdrawals
  walletBonusWindowDays: number;
  walletBonusTiers: WalletBonusTier[];
  withdrawalStandardFeeMinor: number;
  withdrawalInstantFeeBps: number;
  withdrawalInstantFeeMinMinor: number;
  withdrawalInstantFeeMaxMinor: number;
  customerWithdrawalsEnabled: boolean;

  // Section 16 — boosts
  boostMinRating: number;
  boostMaxRatePerHourMinor: number;
  boostPricingMode: 'flat' | 'variable';
  boostTieBreak: 'highest_bid_then_rating' | 'even_rotation';
  pushAlertFeeMinor: number;
  pushAlertMaxPerDay: number;
  pushAlertRadiusKm: number;

  // Section 12 — ads
  adsEnabled: boolean;
  sponsoredMaxPerOrganic: number;
  /** Price per day for each placement (admin "slot pricing"). */
  adSlotPricePerDayMinor: Record<'deals_featured' | 'deals_brand' | 'sponsored_search', number>;
  adMaxCampaignDays: number;

  // Section 17 — construction
  consultancyFeeBands: Record<string, { minMinor: number; maxMinor: number }>;
  consultancyRefundOnNoShow: boolean;
  consultancyCommissionBps: number;

  // Section 18 — incomplete transactions
  incompleteTimeoutDays: number;
  strikeWindowDays: number;
  tier1StrikeCount: number;
  tier1RestrictionDays: number;
  tier2ConsecutiveMonths: number;
  appealWindowDays: number;
  restrictedFunctions: { customer: string[]; technician: string[] };

  // Phase toggles (Section 21)
  features: {
    advertising: boolean;
    performanceMultiplier: boolean;
    boosts: boolean;
    walletBonus: boolean;
    construction: boolean;
    supplies: boolean;
  };
}

const NAIRA = 100; // kobo per naira

export const DEFAULT_SETTINGS: PlatformSettings = {
  currency: 'NGN',

  markupCapBps: 2000,
  receiptThresholdMinor: 50_000 * NAIRA,
  laborCommissionBps: 1800,
  markupCommissionBps: 2000,
  customerServiceFeeBps: 0,

  laborOnlyRejectionCap: 3,
  laborOnlyRejectionWindowDays: 90,
  laborOnlyRejectionPenalty: 0.1,
  laborOnlyStanceCooldownDays: 30,

  priceChallengeStandard: {
    respondByHours: 6,
    remindFromHours: 6,
    remindUntilHours: 30,
    remindEveryHours: 4,
    escalateAtHours: 48,
    finalActionAtHours: 72,
  },
  priceChallengeFastTrack: {
    respondByHours: 2,
    remindFromHours: 2,
    remindUntilHours: 8,
    remindEveryHours: 1,
    escalateAtHours: 8,
    finalActionAtHours: 24,
  },
  priceChallengeFinalAction: 'auto_approve_customer_evidence',

  ratingHalfLifeDays: 90,
  multiplierCycleDays: 14,
  multiplierTiers: [
    { minRating: 4.5, stars: 5, laborAdjustmentBps: 1000 },
    { minRating: 3.5, stars: 4, laborAdjustmentBps: 500 },
    { minRating: 2.5, stars: 3, laborAdjustmentBps: 0 },
    { minRating: 1.5, stars: 2, laborAdjustmentBps: -500 },
    { minRating: 0, stars: 1, laborAdjustmentBps: -1000 },
  ],
  multiplierAnomalyTierJump: 2,
  multiplierAnomalyMinNewReviews: 2,
  completionBadgeMinJobs: 5,

  sellerAutoVerifyAfterCleanApprovals: 5,

  gatewayPriority: ['paystack', 'flutterwave', 'stripe'],
  gatewayFeeSchedules: DEFAULT_FEE_SCHEDULES,
  economicsAvgJobMinor: 25_000 * NAIRA,

  walletBonusWindowDays: 90,
  walletBonusTiers: [
    { minTopupMinor: 0, maxTopupMinor: 50_000 * NAIRA, bonusBps: 0 },
    { minTopupMinor: 50_000 * NAIRA, maxTopupMinor: 100_000 * NAIRA, bonusBps: 10 },
    { minTopupMinor: 100_000 * NAIRA, maxTopupMinor: 500_000 * NAIRA + 1, bonusBps: 20 },
    { minTopupMinor: 500_000 * NAIRA + 1, maxTopupMinor: null, bonusBps: 30 },
  ],
  withdrawalStandardFeeMinor: 0,
  withdrawalInstantFeeBps: 100,
  withdrawalInstantFeeMinMinor: 100 * NAIRA,
  withdrawalInstantFeeMaxMinor: 2_000 * NAIRA,
  customerWithdrawalsEnabled: false,

  boostMinRating: 3,
  boostMaxRatePerHourMinor: 5_000 * NAIRA,
  boostPricingMode: 'flat',
  boostTieBreak: 'highest_bid_then_rating',
  pushAlertFeeMinor: 10_000 * NAIRA,
  pushAlertMaxPerDay: 2,
  pushAlertRadiusKm: 15,

  adsEnabled: false,
  sponsoredMaxPerOrganic: 10,
  adSlotPricePerDayMinor: { deals_featured: 5_000 * NAIRA, deals_brand: 3_000 * NAIRA, sponsored_search: 10_000 * NAIRA },
  adMaxCampaignDays: 90,

  consultancyFeeBands: {},
  consultancyRefundOnNoShow: true,
  consultancyCommissionBps: 0,

  incompleteTimeoutDays: 14,
  strikeWindowDays: 182,
  tier1StrikeCount: 3,
  tier1RestrictionDays: 30,
  tier2ConsecutiveMonths: 3,
  appealWindowDays: 180,
  restrictedFunctions: {
    customer: ['create_booking'],
    technician: ['accept_job', 'purchase_boost', 'purchase_push_alert'],
  },

  features: {
    advertising: false,
    performanceMultiplier: false,
    boosts: false,
    walletBonus: false,
    construction: false,
    supplies: false,
  },
};

export type SettingKey = keyof PlatformSettings;

/** Merge stored overrides (one row per key) over the defaults. Unknown keys are ignored. */
export function resolveSettings(rows: { key: string; value: unknown }[]): PlatformSettings {
  const out = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) out[row.key] = row.value;
  }
  return out as unknown as PlatformSettings;
}
