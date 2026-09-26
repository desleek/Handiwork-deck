/**
 * The performance multiplier summarises a technician's track record into one
 * number used for ranking in discovery (and, later, fees/pricing). It is shown
 * to customers with its reasons so the ranking is explainable.
 */
export interface PerformanceStats {
  ratingAvg: number;
  ratingCount: number;
  completedJobs: number;
  /** Jobs the technician cancelled after being assigned. */
  technicianCancellations: number;
  disputes: number;
}

export type PerformanceTier = 'new' | 'elite' | 'trusted' | 'standard' | 'under_review';

export interface PerformanceMultiplier {
  multiplier: number;
  tier: PerformanceTier;
  reasons: string[];
}

export const MULTIPLIER_MIN = 0.75;
export const MULTIPLIER_MAX = 1.25;
/** Below this many completed jobs a technician is "new" and sits at 1.00×. */
export const NEW_TECHNICIAN_JOB_THRESHOLD = 3;

export function performanceMultiplier(s: PerformanceStats): PerformanceMultiplier {
  if (s.completedJobs < NEW_TECHNICIAN_JOB_THRESHOLD) {
    return { multiplier: 1, tier: 'new', reasons: ['New on HANDIWORK-DECK — building a track record'] };
  }
  let m = 1;
  const reasons: string[] = [];

  if (s.ratingCount > 0) {
    if (s.ratingAvg >= 4.8) (m += 0.15), reasons.push(`Top rated (${s.ratingAvg.toFixed(1)}★)`);
    else if (s.ratingAvg >= 4.5) (m += 0.1), reasons.push(`Highly rated (${s.ratingAvg.toFixed(1)}★)`);
    else if (s.ratingAvg < 3.5) (m -= 0.15), reasons.push(`Low rating (${s.ratingAvg.toFixed(1)}★)`);
    else if (s.ratingAvg < 4) (m -= 0.05), reasons.push(`Below-average rating (${s.ratingAvg.toFixed(1)}★)`);
  }

  const attempted = s.completedJobs + s.technicianCancellations;
  const completionRate = attempted ? s.completedJobs / attempted : 1;
  const pct = Math.round(completionRate * 100);
  if (completionRate >= 0.95) (m += 0.05), reasons.push(`${pct}% of accepted jobs completed`);
  else if (completionRate < 0.8) (m -= 0.1), reasons.push(`Only ${pct}% of accepted jobs completed`);

  const disputeRate = s.disputes / Math.max(s.completedJobs, 1);
  if (disputeRate > 0.1) (m -= 0.05), reasons.push('Frequent disputes');

  const multiplier = Math.round(Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, m)) * 100) / 100;
  const tier: PerformanceTier =
    multiplier >= 1.15 ? 'elite' : multiplier >= 1.05 ? 'trusted' : multiplier >= 0.95 ? 'standard' : 'under_review';
  return { multiplier, tier, reasons };
}

export const TIER_THRESHOLDS: { tier: Exclude<PerformanceTier, 'new' | 'under_review'>; multiplier: number }[] = [
  { tier: 'standard', multiplier: 0.95 },
  { tier: 'trusted', multiplier: 1.05 },
  { tier: 'elite', multiplier: 1.15 },
];

export interface NextTierGuidance {
  current: PerformanceMultiplier;
  nextTier: { tier: PerformanceTier; multiplier: number } | null;
  /** Concrete improvements, each with the multiplier it would reach on its own. */
  actions: { action: string; resultingMultiplier: number; reachesNextTier: boolean }[];
}

/**
 * "What would move me up?" for the earnings dashboard: simulates single
 * improvements against the same formula used for ranking.
 */
export function nextTierGuidance(s: PerformanceStats): NextTierGuidance {
  const current = performanceMultiplier(s);
  const next = TIER_THRESHOLDS.find((t) => t.multiplier > current.multiplier + 1e-9) ?? null;
  const candidates: { action: string; stats: PerformanceStats }[] = [];

  if (s.completedJobs < NEW_TECHNICIAN_JOB_THRESHOLD) {
    const n = NEW_TECHNICIAN_JOB_THRESHOLD - s.completedJobs;
    candidates.push({
      action: `Complete ${n} more job${n > 1 ? 's' : ''} to leave the "new" tier`,
      stats: { ...s, completedJobs: NEW_TECHNICIAN_JOB_THRESHOLD },
    });
  } else {
    for (const target of [4.5, 4.8]) {
      if (s.ratingCount === 0 || s.ratingAvg < target) {
        candidates.push({ action: `Raise your average rating to ${target.toFixed(1)}★`, stats: { ...s, ratingAvg: target, ratingCount: Math.max(s.ratingCount, 1) } });
      }
    }
    const attempted = s.completedJobs + s.technicianCancellations;
    if (attempted && s.completedJobs / attempted < 0.95) {
      // Completed jobs needed (with no further cancellations) to reach 95%.
      const needed = Math.ceil((0.95 * s.technicianCancellations) / 0.05) - s.completedJobs;
      candidates.push({
        action: `Complete ${Math.max(needed, 1)} more job${needed > 1 ? 's' : ''} without cancelling (95% completion)`,
        stats: { ...s, completedJobs: s.completedJobs + Math.max(needed, 1) },
      });
    }
    if (s.disputes / Math.max(s.completedJobs, 1) > 0.1) {
      candidates.push({ action: 'Keep disputes under 10% of completed jobs', stats: { ...s, disputes: Math.floor(s.completedJobs * 0.1) } });
    }
  }

  const actions = candidates
    .map((c) => {
      const m = performanceMultiplier(c.stats).multiplier;
      return { action: c.action, resultingMultiplier: m, reachesNextTier: !!next && m >= next.multiplier };
    })
    .filter((a) => a.resultingMultiplier > current.multiplier || s.completedJobs < NEW_TECHNICIAN_JOB_THRESHOLD);
  return { current, nextTier: next, actions };
}
