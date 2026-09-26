import { hasCompletionBadge, multiplierFor, type PerformanceMultiplier, type RateTier, weightedRecentAverage } from '@handiwork/shared';
import { type Queryable, one, pool, query } from '../db/pool';
import { getSetting } from './settings';

/** Weighted-recent average of a technician's reviews, optionally excluding the latest one. */
export async function rollingRating(techId: string, opts: { excludeLatest?: boolean } = {}, db: Queryable = pool): Promise<number | null> {
  const { halfLifeDays } = await getSetting('rating', db);
  const rows = await query<{ overall: number; created_at: Date }>('SELECT overall, created_at FROM reviews WHERE reviewee_id = $1 ORDER BY created_at DESC', [techId], db);
  const ratings = (opts.excludeLatest ? rows.slice(1) : rows).map((r) => ({ value: Number(r.overall), at: new Date(r.created_at) }));
  const avg = weightedRecentAverage(ratings, halfLifeDays);
  if (avg === null) return null;
  const pen = await one<{ p: number }>('SELECT coalesce(sum(points), 0)::float8 AS p FROM rating_penalties WHERE technician_id = $1 AND now() BETWEEN starts_at AND expires_at', [techId], db);
  return Math.max(1, Math.round((avg - (pen?.p ?? 0)) * 100) / 100);
}

/**
 * Refreshes the public rating: the weighted-recent average of reviews minus any
 * active penalties. This is also the rating the Section 7a cycle uses.
 */
export async function recomputeTechnicianRating(techId: string, db: Queryable = pool): Promise<number | null> {
  const rating = await rollingRating(techId, {}, db);
  const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM reviews WHERE reviewee_id = $1', [techId], db);
  await db.query('UPDATE technician_profiles SET rating_avg = $2, rating_count = $3 WHERE user_id = $1', [techId, rating ?? 0, count?.n ?? 0]);
  return rating;
}

/** The labor rate adjustment in force for new quotes (admin override wins). */
export async function effectiveRateBps(techId: string, db: Queryable = pool): Promise<number> {
  const r = await one<{ bps: number }>('SELECT COALESCE(rate_override_bps, rate_adjustment_bps) AS bps FROM technician_profiles WHERE user_id = $1', [techId], db);
  return r?.bps ?? 0;
}

export async function performanceFor(techIds: string[], db: Queryable = pool): Promise<Map<string, PerformanceMultiplier>> {
  if (!techIds.length) return new Map();
  const rows = await query<{ user_id: string; rating_avg: number; rating_count: number; bps: number; stars: RateTier['stars'] | null }>(
    `SELECT user_id, rating_avg::float8 AS rating_avg, rating_count, COALESCE(rate_override_bps, rate_adjustment_bps) AS bps, rate_tier_stars AS stars
       FROM technician_profiles WHERE user_id = ANY($1)`,
    [techIds],
    db,
  );
  return new Map(rows.map((r) => [r.user_id, multiplierFor(r.rating_count ? Number(r.rating_avg) : null, r.bps, r.stars)]));
}

/**
 * What technicians see about a customer before accepting: agreement-compliance
 * rating and the platform completion badge.
 */
export async function customerTrust(customerId: string, db: Queryable = pool) {
  const rule = await getSetting('completion_badge', db);
  const s = await one(
    `SELECT u.customer_rating_avg::float8 AS rating_avg, u.customer_rating_count AS rating_count,
            (SELECT count(*) FROM jobs j WHERE j.customer_id = u.id AND j.status = 'paid')::int AS paid_jobs,
            -- Jobs where a technician was hired and the customer didn't walk away before paying (technician cancellations excluded).
            (SELECT count(*) FROM jobs j WHERE j.customer_id = u.id AND j.technician_id IS NOT NULL
               AND (j.status IN ('paid', 'completed', 'disputed')
                    OR (j.status = 'cancelled' AND EXISTS (
                      SELECT 1 FROM job_status_history h WHERE h.job_id = j.id AND h.to_status = 'cancelled' AND h.actor_id = u.id))))::int AS engaged_jobs,
            (SELECT count(DISTINCT p.job_id) FROM payments p WHERE p.payer_id = u.id AND p.purpose = 'job' AND p.status IN ('refunded', 'partially_refunded'))::int
              + (SELECT count(*) FROM jobs j WHERE j.customer_id = u.id AND j.status = 'disputed')::int AS refunded_or_disputed
       FROM users u WHERE u.id = $1`,
    [customerId],
    db,
  );
  return {
    ratingAvg: s.rating_count ? s.rating_avg : null,
    ratingCount: s.rating_count,
    paidJobs: s.paid_jobs,
    completionBadge: hasCompletionBadge({ paidJobs: s.paid_jobs, engagedJobs: s.engaged_jobs, refundedOrDisputed: s.refunded_or_disputed }, rule),
  };
}
