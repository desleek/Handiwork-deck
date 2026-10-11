/**
 * Validation for the structured admin settings. Simple scalar settings are type-checked against
 * their default; these schemas guard the tables whose shape matters (tiers, timelines, fees),
 * so a typo in the admin panel can't silently break pricing or escalations.
 */
import { z } from 'zod';

const bps = z.number().int();
const minor = z.number().int().nonnegative();

const timeline = z
  .object({
    respondByHours: z.number().positive(),
    remindFromHours: z.number().nonnegative(),
    remindUntilHours: z.number().nonnegative(),
    remindEveryHours: z.number().positive(),
    escalateAtHours: z.number().positive(),
    finalActionAtHours: z.number().positive(),
  })
  .refine((t) => t.remindFromHours <= t.remindUntilHours, 'Reminders must start before they stop')
  .refine((t) => t.respondByHours <= t.escalateAtHours, 'Escalation must come after the response deadline')
  .refine((t) => t.escalateAtHours < t.finalActionAtHours, 'The final action must come after escalation');

const feeSchedule = z.object({
  localBps: bps.min(0).max(1000),
  flatMinor: minor,
  flatWaivedBelowMinor: minor,
  capMinor: minor,
  virtualAccount: z.object({ bps: bps.min(0).max(1000), capMinor: minor }).optional(),
  transferBands: z
    .array(z.object({ maxMinor: minor.nullable(), feeMinor: minor }))
    .min(1)
    .refine((b) => b[b.length - 1].maxMinor === null, 'The last transfer band must be open-ended (maxMinor: null)'),
});

export const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  multiplierTiers: z
    .array(z.object({ minRating: z.number().min(0).max(5), stars: z.number().int().min(1).max(5), laborAdjustmentBps: bps.min(-5000).max(5000) }))
    .min(2)
    .refine((t) => t.some((x) => x.minRating === 0), 'One tier must start at 0 so every rating maps to a tier')
    .refine((t) => t.some((x) => x.laborAdjustmentBps === 0), 'Keep a neutral (0%) tier for new technicians')
    .refine((t) => new Set(t.map((x) => x.minRating)).size === t.length, 'Tier thresholds must be distinct'),
  walletBonusTiers: z
    .array(z.object({ minTopupMinor: minor, maxTopupMinor: minor.nullable(), bonusBps: bps.min(0).max(500) }))
    .min(1)
    .refine((tiers) => {
      const s = [...tiers].sort((a, b) => a.minTopupMinor - b.minTopupMinor);
      return s.every((t, i) => (t.maxTopupMinor === null ? i === s.length - 1 : t.maxTopupMinor > t.minTopupMinor && (i === s.length - 1 || s[i + 1].minTopupMinor === t.maxTopupMinor)));
    }, 'Tiers must be contiguous (each max equals the next min) with only the last open-ended'),
  priceChallengeStandard: timeline,
  priceChallengeFastTrack: timeline,
  gatewayFeeSchedules: z.record(z.string(), feeSchedule),
  adSlotPricePerDayMinor: z.object({ deals_featured: minor, deals_brand: minor, sponsored_search: minor }),
  restrictedFunctions: z.object({ customer: z.array(z.string()), technician: z.array(z.string()) }),
  features: z.object({
    advertising: z.boolean(),
    performanceMultiplier: z.boolean(),
    boosts: z.boolean(),
    walletBonus: z.boolean(),
    construction: z.boolean(),
    supplies: z.boolean(),
  }),
  markupCapBps: bps.min(0).max(10_000),
  laborCommissionBps: bps.min(0).max(5_000),
  markupCommissionBps: bps.min(0).max(10_000),
  boostMinRating: z.number().min(0).max(5),
  pushAlertMaxPerDay: z.number().int().min(0).max(10),
  multiplierCycleDays: z.number().int().min(1).max(90),
};
