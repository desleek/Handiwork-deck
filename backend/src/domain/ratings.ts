/**
 * Ratings (Section 7) and the performance-based labor multiplier (Section 7a).
 * The same weighted-recent rolling average is used for: public display, the multiplier,
 * and boost eligibility (Section 16).
 */
import type { RatingTier } from './settings.ts';

export const TECHNICIAN_RATING_FIELDS = [
  'competence',
  'punctuality',
  'professionalism',
  'courtesy',
  'delivery_timeline',
  'pricing_fairness',
  'quality_of_work',
] as const;
export type TechnicianRatingField = (typeof TECHNICIAN_RATING_FIELDS)[number];

export const CUSTOMER_RATING_FIELDS = [
  'on_site_as_scheduled',
  'granted_access',
  'paid_through_platform',
  'respectful_conduct',
] as const;

export function overallScore(scores: Record<string, unknown>, fields: readonly string[]): number {
  const vals = fields.map((f) => scores[f] as number);
  if (vals.some((v) => typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5)) {
    throw new Error('Each rating category must be an integer from 1 to 5');
  }
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

export interface TimedRating {
  overall: number;
  createdAt: Date;
}

/**
 * Exponentially time-weighted average: a review `halfLifeDays` old counts half as much as one from today.
 * Returns null when there are no ratings. `penalty` (e.g. labor-only rejection penalties) is subtracted
 * and the result clamped to [1, 5].
 */
export function rollingAverage(
  ratings: TimedRating[],
  now: Date,
  halfLifeDays: number,
  penalty = 0,
): number | null {
  if (ratings.length === 0) return null;
  const lambda = Math.LN2 / (halfLifeDays * 86_400_000);
  let num = 0;
  let den = 0;
  for (const r of ratings) {
    const age = Math.max(0, now.getTime() - r.createdAt.getTime());
    const w = Math.exp(-lambda * age);
    num += w * r.overall;
    den += w;
  }
  const avg = num / den - penalty;
  return Math.round(Math.min(5, Math.max(1, avg)) * 100) / 100;
}

export function tierFor(rating: number, tiers: RatingTier[]): RatingTier {
  const sorted = [...tiers].sort((a, b) => b.minRating - a.minRating);
  return sorted.find((t) => rating >= t.minRating) ?? sorted[sorted.length - 1];
}

export interface MultiplierContext {
  current: RatingTier;
  /** Next tier up, and the rolling average needed to reach it (null at the top tier). */
  next: { tier: RatingTier; ratingNeeded: number } | null;
  /** Tier below, and the rating at which the technician would drop to it. */
  below: { tier: RatingTier; dropsBelow: number } | null;
}

/** What the technician dashboard shows: current multiplier, what drives it, next-tier thresholds. */
export function multiplierContext(rating: number | null, tiers: RatingTier[]): MultiplierContext {
  const sorted = [...tiers].sort((a, b) => a.minRating - b.minRating); // ascending
  // New technicians with no ratings sit in the neutral (0%) tier.
  const current = rating === null ? sorted.find((t) => t.laborAdjustmentBps === 0) ?? sorted[0] : tierFor(rating, tiers);
  const idx = sorted.indexOf(current);
  const nextTier = sorted[idx + 1];
  const belowTier = sorted[idx - 1];
  return {
    current,
    next: nextTier ? { tier: nextTier, ratingNeeded: nextTier.minRating } : null,
    below: belowTier ? { tier: belowTier, dropsBelow: current.minRating } : null,
  };
}

export interface MultiplierRecalc {
  fromBps: number;
  toBps: number;
  tierJump: number;
  flaggedAnomaly: boolean;
}

/**
 * Bi-weekly recalculation (cron). Only future quotes use the new value — quotes freeze
 * `applied_multiplier_bps` at submission. Large swings driven by few reviews are flagged for admin review.
 */
export function recalcMultiplier(params: {
  rating: number | null;
  previousBps: number;
  newReviewsSinceLastCycle: number;
  tiers: RatingTier[];
  anomalyTierJump: number;
  anomalyMinNewReviews: number;
}): MultiplierRecalc {
  const { rating, previousBps, tiers } = params;
  const target = multiplierContext(rating, tiers).current;
  const sortedBps = [...tiers].map((t) => t.laborAdjustmentBps).sort((a, b) => a - b);
  const fromIdx = sortedBps.indexOf(previousBps);
  const toIdx = sortedBps.indexOf(target.laborAdjustmentBps);
  const tierJump = fromIdx === -1 ? 0 : Math.abs(toIdx - fromIdx);
  const flaggedAnomaly =
    tierJump >= params.anomalyTierJump ||
    (tierJump >= 1 && params.newReviewsSinceLastCycle < params.anomalyMinNewReviews);
  return { fromBps: previousBps, toBps: target.laborAdjustmentBps, tierJump, flaggedAnomaly };
}

/**
 * Section 7: a customer may not create a new booking while any completed job lacks their review.
 */
export function bookingBlockedByPendingReviews(pendingReviewJobIds: string[]): boolean {
  return pendingReviewJobIds.length > 0;
}

/** Platform completion badge: enough completed, platform-paid jobs and no at-fault strikes in the window. */
export function earnsCompletionBadge(completedPaidJobs: number, activeStrikes: number, minJobs: number): boolean {
  return completedPaidJobs >= minJobs && activeStrikes === 0;
}
