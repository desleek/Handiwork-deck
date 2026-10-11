import { one, query, tx } from '../db/pool.ts';
import { attributeFault, tier1Triggered, tier2Triggered } from '../domain/penalties.ts';
import { recalcMultiplier } from '../domain/ratings.ts';
import { alertMessage, canSendAlertToday } from '../domain/boosts.ts';
import { haversineKm } from '../domain/discovery.ts';
import { logger } from '../lib/logger.ts';
import { getJob, logJobEvent, transition } from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { getProvider } from '../services/payments/router.ts';
import { refreshTechnicianRating } from '../services/ratings.ts';
import { getSettings } from '../services/settings.ts';

/**
 * Section 18: find jobs stalled past the timeout, attribute fault to the last-prompted party,
 * record strikes, and apply Tier 1 / Tier 2 penalties.
 */
export async function scanIncompleteTransactions() {
  const s = await getSettings();
  const stalled = await query<any>(
    `SELECT id, status, action_required_from, action_required_since, customer_id, technician_id FROM jobs
      WHERE status NOT IN ('completed', 'cancelled', 'declined', 'incomplete')
        AND action_required_since < now() - make_interval(days => $1)
      LIMIT 500`,
    [s.incompleteTimeoutDays],
  );
  for (const row of stalled) {
    const outcome = attributeFault(
      { status: row.status, actionRequiredFrom: row.action_required_from, actionRequiredSince: row.action_required_since },
      new Date(),
      s.incompleteTimeoutDays,
    );
    if (outcome.kind === 'not_stalled') continue;
    await tx(async (db) => {
      const job = await getJob(row.id, db, true);
      if (outcome.kind === 'admin_review') {
        await query(`INSERT INTO fault_reviews (job_id) VALUES ($1) ON CONFLICT (job_id) DO NOTHING`, [job.id], db);
        await logJobEvent(db, job.id, null, 'incomplete.admin_review', {});
        return;
      }
      const userId = outcome.party === 'customer' ? job.customer_id : job.technician_id;
      await transition(db, job, 'incomplete', null, { event: { faultParty: outcome.party } });
      await query(
        `INSERT INTO incomplete_strikes (user_id, job_id, party, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [userId, job.id, outcome.party, job.action_required_reason],
        db,
      );
      await applyPenaltyTiers(db, userId, outcome.party);
    });
  }
  return { scanned: stalled.length };
}

export async function applyPenaltyTiers(db: any, userId: string, party: 'customer' | 'technician') {
  const s = await getSettings();
  const strikes = await query<{ created_at: Date }>(
    `SELECT created_at FROM incomplete_strikes WHERE user_id = $1 AND NOT voided AND created_at > now() - make_interval(days => $2)`,
    [userId, s.strikeWindowDays],
    db,
  );
  if (!tier1Triggered(strikes.map((x) => x.created_at), new Date(), s.strikeWindowDays, s.tier1StrikeCount)) return;
  const active = await one(
    `SELECT 1 FROM account_restrictions WHERE user_id = $1 AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > now())`,
    [userId],
    db,
  );
  if (active) return;

  const tier1History = await query<{ created_at: Date }>(
    `SELECT created_at FROM account_restrictions WHERE user_id = $1 AND tier = 1 ORDER BY created_at`,
    [userId],
    db,
  );
  const dates = [...tier1History.map((r) => r.created_at), new Date()];
  if (tier2Triggered(dates, s.tier2ConsecutiveMonths)) {
    await query(`INSERT INTO account_restrictions (user_id, tier, restricted_functions) VALUES ($1, 2, '{*}')`, [userId], db);
    await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userId], db);
    await notify({ userId, type: 'account.suspended', title: 'Account suspended', body: `Your account has been suspended after repeated incomplete transactions. You can appeal within ${s.appealWindowDays} days.`, channels: ['push', 'email'] });
    return;
  }
  const fns = s.restrictedFunctions[party];
  await query(
    `INSERT INTO account_restrictions (user_id, tier, restricted_functions, ends_at) VALUES ($1, 1, $2, now() + make_interval(days => $3))`,
    [userId, fns, s.tier1RestrictionDays],
    db,
  );
  await query(`UPDATE users SET status = 'restricted' WHERE id = $1 AND status = 'active'`, [userId], db);
  await notify({ userId, type: 'account.restricted', title: 'Account temporarily restricted', body: `After ${s.tier1StrikeCount} incomplete transactions, some actions are paused for ${s.tier1RestrictionDays} days. Jobs in progress are not affected.` });
}

export async function expireRestrictions() {
  await query(
    `UPDATE users u SET status = 'active' WHERE u.status = 'restricted'
       AND NOT EXISTS (SELECT 1 FROM account_restrictions r WHERE r.user_id = u.id AND r.lifted_at IS NULL AND (r.ends_at IS NULL OR r.ends_at > now()))`,
  );
}

/** Section 7a: bi-weekly multiplier recalculation; only future quotes are affected. */
export async function recalcMultipliers(opts: { force?: boolean } = {}) {
  const s = await getSettings();
  if (!s.features.performanceMultiplier) return { skipped: 'feature disabled' };
  // `force` (admin "recalculate now") ignores the cycle; the nightly job only picks up technicians due this cycle.
  const due = await query<{ user_id: string; performance_multiplier_bps: number; multiplier_updated_at: Date | null }>(
    `SELECT user_id, performance_multiplier_bps, multiplier_updated_at FROM technician_profiles
      WHERE $2 OR multiplier_updated_at IS NULL OR multiplier_updated_at < now() - make_interval(days => $1)`,
    [s.multiplierCycleDays, !!opts.force],
  );
  for (const t of due) {
    await tx(async (db) => {
      const rating = await refreshTechnicianRating(db, t.user_id);
      const newReviews = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM technician_ratings WHERE technician_id = $1 AND created_at > COALESCE($2, '-infinity'::timestamptz)`,
        [t.user_id, t.multiplier_updated_at],
        db,
      );
      const r = recalcMultiplier({
        rating,
        previousBps: t.performance_multiplier_bps,
        newReviewsSinceLastCycle: newReviews!.n,
        tiers: s.multiplierTiers,
        anomalyTierJump: s.multiplierAnomalyTierJump,
        anomalyMinNewReviews: s.multiplierAnomalyMinNewReviews,
      });
      await query(
        `INSERT INTO multiplier_history (technician_id, rating_avg, from_bps, to_bps, flagged_anomaly, review_status) VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.user_id, rating, r.fromBps, r.toBps, r.flaggedAnomaly, r.flaggedAnomaly ? 'pending' : null],
        db,
      );
      // Anomalous swings are held at the previous value until an admin confirms or overrides.
      const apply = r.flaggedAnomaly ? r.fromBps : r.toBps;
      await query(
        `UPDATE technician_profiles SET performance_multiplier_bps = $2, multiplier_updated_at = now() WHERE user_id = $1`,
        [t.user_id, apply],
        db,
      );
    });
  }
  return { recalculated: due.length };
}

/** Activate scheduled boosts, end expired ones (paid boosts always run to their end time). */
export async function boostLifecycle() {
  await query(`UPDATE boosts SET status = 'active' WHERE status = 'scheduled' AND starts_at <= now()`);
  await query(`UPDATE boosts SET status = 'ended' WHERE status IN ('scheduled', 'active') AND ends_at <= now()`);
  // Checkouts abandoned for 30+ minutes release the slot (and stop counting toward daily alert limits).
  await query(
    `UPDATE boosts SET status = 'cancelled', cancelled_reason = 'payment_not_completed'
      WHERE status = 'pending_payment' AND created_at < now() - interval '30 minutes'`,
  );
  await query(`UPDATE push_alert_sends SET status = 'failed' WHERE status = 'pending_payment' AND created_at < now() - interval '30 minutes'`);
}

/** Section 16b: one fixed-template push to nearby customers interested in the category. */
export async function sendPushAlert(alertId: string) {
  const s = await getSettings();
  const a = await one<any>(
    `SELECT a.*, u.full_name, c.name AS category_name, t.rating_avg, t.last_lat, t.last_lng, t.coverage_lat, t.coverage_lng
       FROM push_alert_sends a JOIN users u ON u.id = a.technician_id
       JOIN technician_profiles t ON t.user_id = a.technician_id
       JOIN service_categories c ON c.id = a.category_id
      WHERE a.id = $1`,
    [alertId],
  );
  if (!a || a.status !== 'pending_payment') return;
  const sentToday = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM push_alert_sends WHERE technician_id = $1 AND status = 'sent' AND sent_at > now() - interval '24 hours'`,
    [a.technician_id],
  );
  if (!canSendAlertToday(sentToday!.n, s.pushAlertMaxPerDay)) {
    // Shouldn't happen (checked at purchase), but never over-send: refund instead.
    logger.warn({ alertId }, 'alert limit hit at send time; refunding');
    const p = await one<any>(`SELECT * FROM payments WHERE id = $1`, [a.payment_id]);
    if (p && p.provider !== 'wallet') await getProvider(p.provider).refund(p.provider_ref, p.amount_minor);
    await query(`UPDATE push_alert_sends SET status = 'failed' WHERE id = $1`, [alertId]);
    return;
  }
  const lat = a.last_lat ?? a.coverage_lat;
  const lng = a.last_lng ?? a.coverage_lng;
  const recipients = await query<{ user_id: string; lat: number | null; lng: number | null }>(
    `SELECT ci.user_id, j.lat, j.lng FROM category_interest ci
       JOIN users u ON u.id = ci.user_id AND u.role = 'customer' AND u.status = 'active'
       LEFT JOIN notification_prefs np ON np.user_id = ci.user_id
       LEFT JOIN LATERAL (SELECT lat, lng FROM jobs WHERE customer_id = ci.user_id ORDER BY created_at DESC LIMIT 1) j ON true
      WHERE ci.category_id = $1 AND COALESCE(np.promotional_alerts, true)
      LIMIT 5000`,
    [a.category_id],
  );
  let sent = 0;
  for (const r of recipients) {
    const d = lat != null && r.lat != null ? haversineKm(lat, lng, r.lat, r.lng!) : null;
    if (d !== null && d > s.pushAlertRadiusKm) continue;
    const msg = alertMessage({ name: a.full_name, category: a.category_name, rating: Number(a.rating_avg ?? 0), distanceKm: d ?? 0 });
    await notify({ userId: r.user_id, type: 'promo.technician_available', ...msg, transactional: false, data: { technicianId: a.technician_id } });
    sent++;
  }
  await query(`UPDATE push_alert_sends SET status = 'sent', sent_at = now(), recipients_count = $2 WHERE id = $1`, [alertId, sent]);
}

/** Standard (next-business-day) withdrawals are batched; instant ones go out immediately at request time. */
export async function processStandardWithdrawals() {
  const pending = await query<any>(
    `SELECT w.*, b.provider_recipient_code FROM withdrawals w JOIN bank_accounts b ON b.id = w.bank_account_id
      WHERE w.status = 'pending' AND w.speed = 'standard' LIMIT 200`,
  );
  const s = await getSettings();
  for (const w of pending) {
    // Bank accounts store "<provider>|<recipient code>" — pay out through the provider that tokenised it.
    const [providerName, recipientCode] = String(w.provider_recipient_code).split('|');
    try {
      const provider = getProvider(providerName);
      const r = await provider.transfer!({ reference: w.id, amountMinor: w.amount_minor - w.fee_minor, currency: s.currency, recipientCode, reason: 'Handiwork-Deck payout', speed: 'standard' });
      await query(`UPDATE withdrawals SET status = $2, provider = $3, provider_ref = $4 WHERE id = $1`, [w.id, r.status === 'succeeded' ? 'paid' : 'processing', provider.name, r.providerRef]);
    } catch (err) {
      logger.error({ err, withdrawalId: w.id }, 'standard withdrawal failed');
    }
  }
}
