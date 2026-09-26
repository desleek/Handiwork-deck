/**
 * Section 7a: performance-based labor rate adjustment. The technician's
 * weighted-recent rating maps to a star tier, and the tier to a percentage
 * applied to the labor line of future quotes only (never parts or markup).
 * Recalculated on a fixed cycle (default every 2 weeks).
 */
export interface RateTier {
  stars: 1 | 2 | 3 | 4 | 5;
  /** Lowest rolling rating that lands in this tier. */
  minRating: number;
  adjustmentBps: number;
}

/** Nearest-star rounding: 4.5+ is a 5★ tier, 3.5–4.49 is 4★, and so on. Admin-configurable. */
export const DEFAULT_RATE_TIERS: RateTier[] = [
  { stars: 5, minRating: 4.5, adjustmentBps: 1000 },
  { stars: 4, minRating: 3.5, adjustmentBps: 500 },
  { stars: 3, minRating: 2.5, adjustmentBps: 0 },
  { stars: 2, minRating: 1.5, adjustmentBps: -500 },
  { stars: 1, minRating: 0, adjustmentBps: -1000 },
];

export const DEFAULT_RATE_CYCLE_DAYS = 14;

export function rateTierFor(rating: number | null, tiers: RateTier[] = DEFAULT_RATE_TIERS): RateTier | null {
  if (rating === null) return null; // unrated: no adjustment yet
  const sorted = [...tiers].sort((a, b) => b.minRating - a.minRating);
  return sorted.find((t) => rating >= t.minRating) ?? sorted[sorted.length - 1]!;
}

export interface PerformanceMultiplier {
  /** 1 + adjustment, e.g. 1.05 for +5%. */
  multiplier: number;
  adjustmentBps: number;
  /** null while the technician has no ratings. */
  tierStars: RateTier['stars'] | null;
  reasons: string[];
}

export function multiplierFor(rating: number | null, adjustmentBps: number, tierStars: RateTier['stars'] | null): PerformanceMultiplier {
  const pct = adjustmentBps / 100;
  const reasons =
    tierStars === null
      ? ['No ratings yet — standard labor rate']
      : [`Rolling rating ${rating?.toFixed(2)}★ → ${tierStars}★ tier: ${pct > 0 ? '+' : ''}${pct}% on labor`];
  return { multiplier: Math.round((1 + adjustmentBps / 10_000) * 10_000) / 10_000, adjustmentBps, tierStars, reasons };
}

/** Labor with the performance adjustment applied (labor only — never parts or markup). */
export function adjustLabor(laborMinor: number, adjustmentBps: number): number {
  return Math.round(laborMinor * (1 + adjustmentBps / 10_000));
}

export interface NextTierGuidance {
  current: { stars: RateTier['stars'] | null; adjustmentBps: number };
  next: RateTier | null;
  /** Rolling rating needed to reach the next tier. */
  ratingNeeded: number | null;
  tiers: RateTier[];
}

export function nextTierGuidance(rating: number | null, tiers: RateTier[] = DEFAULT_RATE_TIERS): NextTierGuidance {
  const current = rateTierFor(rating, tiers);
  const ascending = [...tiers].sort((a, b) => a.minRating - b.minRating);
  const next = current ? (ascending.find((t) => t.minRating > current.minRating) ?? null) : (ascending.find((t) => t.adjustmentBps > 0) ?? null);
  return {
    current: { stars: current?.stars ?? null, adjustmentBps: current?.adjustmentBps ?? 0 },
    next,
    ratingNeeded: next?.minRating ?? null,
    tiers: [...tiers].sort((a, b) => b.minRating - a.minRating),
  };
}

/**
 * Anomalous swing: the tier dropped by one or more, but without the single most
 * recent rating the technician would have kept their tier (e.g. one bad review).
 * Such changes are held for admin review instead of applied.
 */
export function isAnomalousSwing(opts: {
  previousStars: RateTier['stars'] | null;
  newStars: RateTier['stars'] | null;
  ratingWithoutLatest: number | null;
  tiers?: RateTier[];
}): boolean {
  if (opts.previousStars === null || opts.newStars === null || opts.newStars >= opts.previousStars) return false;
  const without = rateTierFor(opts.ratingWithoutLatest, opts.tiers);
  return !!without && without.stars >= opts.previousStars;
}
