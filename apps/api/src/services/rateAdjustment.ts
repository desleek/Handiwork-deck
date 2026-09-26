import { isAnomalousSwing, rateTierFor, type RateTier } from '@handiwork/shared';
import { one, pool, query, tx } from '../db/pool';
import { logger } from '../lib/logger';
import { jobs } from '../queues/index';
import { recomputeTechnicianRating, rollingRating } from './ratings';
import { getSetting } from './settings';

/**
 * Section 7a cycle: recomputes one technician's labor rate adjustment from their
 * rolling rating. Applies to future quotes only (quotes snapshot the rate).
 * A tier drop caused by a single review is held for admin review.
 */
export async function recalcRateAdjustment(techId: string): Promise<'applied' | 'unchanged' | 'held' | 'skipped'> {
  const cfg = await getSetting('rate_adjustment');
  const tiers = cfg.tiers as RateTier[];
  const profile = await one('SELECT rate_adjustment_bps, rate_tier_stars, rate_held_for_review FROM technician_profiles WHERE user_id = $1', [techId]);
  if (!profile || profile.rate_held_for_review) return 'skipped';

  const rating = await recomputeTechnicianRating(techId);
  const tier = rateTierFor(rating, tiers);
  const newStars = tier?.stars ?? null;
  const newBps = tier?.adjustmentBps ?? 0;
  const prevStars = profile.rate_tier_stars as RateTier['stars'] | null;
  const prevBps = profile.rate_adjustment_bps as number;

  if (newStars === prevStars && newBps === prevBps) {
    await query('UPDATE technician_profiles SET rate_calculated_at = now(), rate_rating_used = $2 WHERE user_id = $1', [techId, rating]);
    return 'unchanged';
  }

  const ratingWithoutLatest = await rollingRating(techId, { excludeLatest: true });
  const anomalous = cfg.holdAnomalousSwings && isAnomalousSwing({ previousStars: prevStars, newStars, ratingWithoutLatest, tiers });

  return tx(async (db) => {
    if (anomalous) {
      const flag = await one(
        `INSERT INTO technician_flags (technician_id, kind, details) VALUES ($1, 'rate_swing', $2) RETURNING id`,
        [techId, JSON.stringify({ previousStars: prevStars, newStars, rating, ratingWithoutLatest, reason: 'Tier drop caused by a single review' })],
        db,
      );
      await db.query(
        `INSERT INTO technician_rate_adjustments (technician_id, rating_used, rating_without_latest, previous_stars, new_stars, previous_bps, new_bps, status, flag_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'held', $8)`,
        [techId, rating, ratingWithoutLatest, prevStars, newStars, prevBps, newBps, flag.id],
      );
      await db.query('UPDATE technician_profiles SET rate_held_for_review = true, rate_calculated_at = now(), rate_rating_used = $2 WHERE user_id = $1', [techId, rating]);
      return 'held' as const;
    }
    await db.query(
      `INSERT INTO technician_rate_adjustments (technician_id, rating_used, rating_without_latest, previous_stars, new_stars, previous_bps, new_bps, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied')`,
      [techId, rating, ratingWithoutLatest, prevStars, newStars, prevBps, newBps],
    );
    await db.query(
      'UPDATE technician_profiles SET rate_adjustment_bps = $2, rate_tier_stars = $3, rate_rating_used = $4, rate_calculated_at = now() WHERE user_id = $1',
      [techId, newBps, newStars, rating],
    );
    return 'applied' as const;
  }).then(async (outcome) => {
    if (outcome === 'applied') {
      const pct = newBps / 100;
      await jobs().notify(techId, {
        title: 'Labor rate updated',
        body: `Your labor rate adjustment is now ${pct > 0 ? '+' : ''}${pct}% (${newStars ?? '—'}★ tier) for new quotes.`,
        data: { type: 'rate.updated' },
      });
    }
    return outcome;
  });
}

/** Runs the cycle for every technician whose last calculation is older than the cycle length. */
export async function runRateCycle(): Promise<number> {
  const { cycleDays } = await getSetting('rate_adjustment');
  const due = await query<{ user_id: string }>(
    `SELECT user_id FROM technician_profiles
      WHERE NOT rate_held_for_review AND (rate_calculated_at IS NULL OR rate_calculated_at < now() - make_interval(days => $1))`,
    [cycleDays],
  );
  for (const t of due) {
    try {
      await recalcRateAdjustment(t.user_id);
    } catch (err) {
      logger.error({ err, technicianId: t.user_id }, 'rate adjustment failed');
    }
  }
  return due.length;
}

export async function nextRecalculationAt(techId: string): Promise<Date | null> {
  const { cycleDays } = await getSetting('rate_adjustment');
  const r = await one<{ at: Date | null }>('SELECT rate_calculated_at AS at FROM technician_profiles WHERE user_id = $1', [techId], pool);
  return r?.at ? new Date(new Date(r.at).getTime() + cycleDays * 86_400_000) : null;
}
