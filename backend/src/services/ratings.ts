import { one, query, type Db } from '../db/pool.ts';
import { earnsCompletionBadge, rollingAverage } from '../domain/ratings.ts';
import { getSettings } from './settings.ts';

/**
 * Recompute a technician's weighted-recent rolling average (display + multiplier + boost gate),
 * net of any labor-only rejection penalties inside the rejection window.
 */
export async function refreshTechnicianRating(db: Db, technicianId: string) {
  const s = await getSettings();
  const rows = await query<{ overall: number; created_at: Date }>(
    `SELECT overall, created_at FROM technician_ratings WHERE technician_id = $1 AND moderation_status <> 'rejected'`,
    [technicianId],
    db,
  );
  const penalties = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM labor_only_requests
      WHERE technician_id = $1 AND penalty_applied AND responded_at > now() - make_interval(days => $2)`,
    [technicianId, s.laborOnlyRejectionWindowDays],
    db,
  );
  const avg = rollingAverage(
    rows.map((r) => ({ overall: Number(r.overall), createdAt: r.created_at })),
    new Date(),
    s.ratingHalfLifeDays,
    (penalties?.n ?? 0) * s.laborOnlyRejectionPenalty,
  );
  await query(
    `UPDATE technician_profiles SET rating_avg = $2, rating_count = $3, updated_at = now() WHERE user_id = $1`,
    [technicianId, avg, rows.length],
    db,
  );
  return avg;
}

/** Customer completion badge (Section 7): consistent completion and full on-platform payment. */
export async function refreshCompletionBadge(db: Db, customerId: string) {
  const s = await getSettings();
  const r = await one<{ jobs: number; strikes: number }>(
    `SELECT
       (SELECT count(*)::int FROM jobs j WHERE j.customer_id = $1 AND j.status = 'completed'
          AND EXISTS (SELECT 1 FROM payments p WHERE p.job_id = j.id AND p.status = 'captured')) AS jobs,
       (SELECT count(*)::int FROM incomplete_strikes s WHERE s.user_id = $1 AND NOT s.voided
          AND s.created_at > now() - make_interval(days => $2)) AS strikes`,
    [customerId, s.strikeWindowDays],
    db,
  );
  const badge = earnsCompletionBadge(r!.jobs, r!.strikes, s.completionBadgeMinJobs);
  await query('UPDATE users SET completion_badge = $2 WHERE id = $1', [customerId, badge], db);
}

/** Completed jobs this customer still has to review — blocks new bookings (Section 7). */
export async function pendingReviewJobIds(customerId: string, db?: Db): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT j.id FROM jobs j
      WHERE j.customer_id = $1 AND j.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM technician_ratings r WHERE r.job_id = j.id)`,
    [customerId],
    db,
  );
  return rows.map((r) => r.id);
}
