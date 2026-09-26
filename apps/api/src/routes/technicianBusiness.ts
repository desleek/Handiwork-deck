import { multiplierFor, nextTierGuidance, type RateTier } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, HttpError } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { nextStandardBatch, payoutFee } from '../services/payouts';
import { nextRecalculationAt } from '../services/rateAdjustment';
import { getSetting, markupCapFor } from '../services/settings';
import { postToWallet } from '../services/wallet';

/** Section 4: earnings dashboard, promotions (Section 16 eligibility), payouts. */
export const technicianBusinessRouter = Router();
technicianBusinessRouter.use('/technicians/me', authenticate, requireUser('technician'));

/**
 * Section 7a performance: rolling rating, current star tier and labor adjustment,
 * the thresholds for every tier, and when it will next be recalculated.
 */
async function performanceSummary(techId: string) {
  const cfg = await getSetting('rate_adjustment');
  const p = await one(
    `SELECT rating_avg::float8 AS rating_avg, rating_count, rate_adjustment_bps, rate_tier_stars, rate_rating_used::float8 AS rate_rating_used,
            rate_calculated_at, rate_override_bps, rate_held_for_review
       FROM technician_profiles WHERE user_id = $1`,
    [techId],
  );
  const s = await one('SELECT completed_jobs, technician_cancellations, disputes FROM technician_performance_stats WHERE technician_id = $1', [techId]);
  const rating = p.rating_count ? Number(p.rating_avg) : null;
  const bps = p.rate_override_bps ?? p.rate_adjustment_bps;
  const guidance = nextTierGuidance(rating, cfg.tiers as RateTier[]);
  return {
    current: multiplierFor(p.rate_rating_used ?? rating, bps, p.rate_tier_stars),
    rollingRating: rating,
    ratingCount: p.rating_count,
    /** The tier the current rolling rating would give at the next recalculation. */
    projected: guidance.current,
    next: guidance.next,
    ratingNeeded: guidance.ratingNeeded,
    tiers: guidance.tiers,
    lastCalculatedAt: p.rate_calculated_at,
    nextRecalculationAt: await nextRecalculationAt(techId),
    cycleDays: cfg.cycleDays,
    adminOverride: p.rate_override_bps !== null,
    heldForReview: p.rate_held_for_review,
    stats: { completedJobs: s.completed_jobs, technicianCancellations: s.technician_cancellations, disputes: s.disputes },
  };
}

/**
 * Earnings dashboard: what they've earned (labor, parts reimbursed, markup, commission),
 * what's pending, wallet balance, and the performance multiplier — current value,
 * what drives it, and what would reach the next tier.
 */
technicianBusinessRouter.get('/technicians/me/earnings', async (req, res) => {
  const techId = currentUser(req).id;
  const [byCurrency, pending, wallet, payouts, promotions] = await Promise.all([
    query(
      `SELECT p.currency,
              count(*)::int AS jobs_paid,
              sum(p.amount_minor)::bigint AS gross_minor,
              sum(p.platform_fee_minor)::bigint AS commission_minor,
              sum(p.amount_minor - p.platform_fee_minor)::bigint AS net_minor,
              sum(q.labor_minor)::bigint AS labor_minor,
              sum(q.parts_base_minor)::bigint AS parts_reimbursed_minor,
              sum(q.markup_minor)::bigint AS markup_minor,
              sum(CASE WHEN p.updated_at >= date_trunc('month', now()) THEN p.amount_minor - p.platform_fee_minor ELSE 0 END)::bigint AS net_this_month_minor
         FROM payments p JOIN quotes q ON q.job_id = p.job_id AND q.status = 'accepted'
        WHERE p.payee_id = $1 AND p.purpose = 'job' AND p.status IN ('succeeded', 'partially_refunded')
        GROUP BY p.currency ORDER BY p.currency`,
      [techId],
    ),
    query(
      `SELECT currency, count(*)::int AS jobs, sum(budget_minor)::bigint AS amount_minor
         FROM jobs WHERE technician_id = $1 AND status IN ('assigned', 'en_route', 'in_progress', 'completed') GROUP BY currency`,
      [techId],
    ),
    query('SELECT currency, balance_minor FROM wallets WHERE user_id = $1 ORDER BY currency', [techId]),
    query('SELECT id, currency, amount_minor, fee_minor, net_minor, speed, status, scheduled_for, created_at, failure_reason FROM payouts WHERE technician_id = $1 ORDER BY created_at DESC LIMIT 10', [techId]),
    activePromotions(techId),
  ]);
  res.json({
    earnings: byCurrency,
    pending,
    wallet,
    payouts,
    promotions,
    performance: await performanceSummary(techId),
  });
});

// ---------------------------------------------------------------- promotions
async function activePromotions(techId: string) {
  const [boosts, alerts] = await Promise.all([
    query(
      `SELECT b.id, b.category_id, c.name AS category_name, b.priority, b.starts_at, b.ends_at, b.source
         FROM technician_boosts b LEFT JOIN service_categories c ON c.id = b.category_id
        WHERE b.technician_id = $1 AND b.ends_at > now() ORDER BY b.ends_at`,
      [techId],
    ),
    query('SELECT id, radius_factor::float8 AS radius_factor, starts_at, ends_at FROM technician_alert_subscriptions WHERE technician_id = $1 AND ends_at > now() ORDER BY ends_at', [techId]),
  ]);
  return { boosts, alerts };
}

/**
 * Section 16 eligibility (admin-configurable). Per Section 7a the same rolling
 * rating that sets the labor rate gates boosts.
 */
async function promotionEligibility(techId: string) {
  const { eligibility } = await getSetting('promotions');
  const p = await one(
    `SELECT tp.verification_status, u.is_active, tp.rating_avg::float8 AS rating_avg, tp.rating_count,
            (SELECT count(*) FROM jobs j WHERE j.technician_id = tp.user_id AND j.status = 'disputed')::int AS open_disputes,
            (SELECT count(*) FROM technician_flags f WHERE f.technician_id = tp.user_id AND f.status = 'open')::int AS open_flags
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.user_id = $1`,
    [techId],
  );
  const reasons: string[] = [];
  if (eligibility.requireVerified && p.verification_status !== 'verified') reasons.push('Your account must be verified');
  if (!p.is_active) reasons.push('Your account is suspended');
  if (p.rating_count > 0 && p.rating_avg < eligibility.minRatingAvg) reasons.push(`Your rolling rating must be at least ${eligibility.minRatingAvg}★`);
  if (p.open_disputes > eligibility.maxOpenDisputes) reasons.push('Resolve your open disputes first');
  if (eligibility.noOpenFlags && p.open_flags > 0) reasons.push('Your account has an open review flag');
  return { eligible: reasons.length === 0, reasons };
}

technicianBusinessRouter.get('/technicians/me/promotions', async (req, res) => {
  const techId = currentUser(req).id;
  const { currency } = parse(z.object({ currency: z.string().length(3).toUpperCase().default('NGN') }), req.query);
  const { products } = await getSetting('promotions');
  res.json({
    currency,
    products: Object.entries(products)
      .filter(([, p]) => p.price[currency] !== undefined)
      .map(([key, p]) => ({ key, kind: p.kind, label: p.label, days: p.days, priceMinor: p.price[currency], radiusFactor: p.radiusFactor ?? null })),
    eligibility: await promotionEligibility(techId),
    active: await activePromotions(techId),
  });
});

const PurchaseBody = z.object({
  product: z.string().min(1).max(40),
  currency: z.string().length(3).toUpperCase().default('NGN'),
  /** Boosts can target one of the technician's categories; omit for all of them. */
  categoryId: z.number().int().positive().optional(),
});

/** Buy a visibility boost or priority job alerts, paid from the wallet. Buying again extends the period. */
technicianBusinessRouter.post('/technicians/me/promotions', async (req, res) => {
  const b = parse(PurchaseBody, req.body);
  const techId = currentUser(req).id;
  const { products } = await getSetting('promotions');
  const product = products[b.product];
  if (!product) throw badRequest('Unknown product');
  const price = product.price[b.currency];
  if (price === undefined) throw badRequest(`Not sold in ${b.currency}`);
  const eligibility = await promotionEligibility(techId);
  if (!eligibility.eligible) throw new HttpError(403, 'Not eligible for promotions right now', 'not_eligible', eligibility);
  if (b.categoryId && product.kind === 'boost') {
    const svc = await one('SELECT 1 FROM technician_services WHERE technician_id = $1 AND category_id = $2', [techId, b.categoryId]);
    if (!svc) throw badRequest('You can only boost a service you offer');
  }

  const purchase = await tx(async (db) => {
    const p = await one(
      `INSERT INTO promotion_purchases (technician_id, product, category_id, price_minor, currency) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [techId, b.product, product.kind === 'boost' ? (b.categoryId ?? null) : null, price, b.currency],
      db,
    );
    if (price > 0) {
      await postToWallet(db, { userId: techId, currency: b.currency, amountMinor: -price, kind: 'promotion', promotionId: p.id, memo: product.label });
    }
    if (product.kind === 'boost') {
      const boost = await one(
        `INSERT INTO technician_boosts (technician_id, category_id, priority, starts_at, ends_at, source)
         SELECT $1, $2, $3, s, s + make_interval(days => $4), 'purchase'
           FROM (SELECT greatest(now(), coalesce(max(ends_at), now())) AS s FROM technician_boosts
                  WHERE technician_id = $1 AND source = 'purchase' AND category_id IS NOT DISTINCT FROM $2) x
         RETURNING id, starts_at, ends_at`,
        [techId, b.categoryId ?? null, product.priority ?? 10, product.days],
        db,
      );
      await db.query('UPDATE promotion_purchases SET boost_id = $2 WHERE id = $1', [p.id, boost.id]);
      return { id: p.id, kind: 'boost', startsAt: boost.starts_at, endsAt: boost.ends_at };
    }
    const sub = await one(
      `INSERT INTO technician_alert_subscriptions (technician_id, radius_factor, starts_at, ends_at)
       SELECT $1, $2, s, s + make_interval(days => $3)
         FROM (SELECT greatest(now(), coalesce(max(ends_at), now())) AS s FROM technician_alert_subscriptions WHERE technician_id = $1) x
       RETURNING id, starts_at, ends_at`,
      [techId, product.radiusFactor ?? 2, product.days],
      db,
    );
    await db.query('UPDATE promotion_purchases SET alert_subscription_id = $2 WHERE id = $1', [p.id, sub.id]);
    return { id: p.id, kind: 'alerts', startsAt: sub.starts_at, endsAt: sub.ends_at };
  });
  res.status(201).json({ purchase });
});

// ---------------------------------------------------------------- payouts
const PayoutBody = z.object({
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3).toUpperCase(),
  speed: z.enum(['standard', 'instant']),
});

/** Quote the fee before requesting. */
technicianBusinessRouter.get('/technicians/me/payouts/quote', async (req, res) => {
  const q = parse(PayoutBody.extend({ amountMinor: z.coerce.number().int().positive() }), req.query);
  const fee = await payoutFee(q.amountMinor, q.currency, q.speed);
  res.json({ ...q, feeMinor: fee, netMinor: q.amountMinor - fee, scheduledFor: q.speed === 'instant' ? new Date() : await nextStandardBatch() });
});

technicianBusinessRouter.get('/technicians/me/payouts', async (req, res) => {
  const payouts = await query('SELECT * FROM payouts WHERE technician_id = $1 ORDER BY created_at DESC LIMIT 100', [currentUser(req).id]);
  res.json({ payouts });
});

/**
 * Withdraw from the wallet. Standard: free, sent in the next daily batch.
 * Instant: sent now, for a fee. The wallet is debited immediately.
 */
technicianBusinessRouter.post('/technicians/me/payouts', async (req, res) => {
  const b = parse(PayoutBody, req.body);
  const techId = currentUser(req).id;
  const profile = await one('SELECT payout_provider, payout_currency FROM technician_profiles WHERE user_id = $1', [techId]);
  if (!profile.payout_provider) throw conflict('Set up payouts first');
  if (profile.payout_currency && profile.payout_currency !== b.currency) throw badRequest(`Your payout account is in ${profile.payout_currency}`);
  const cfg = await getSetting('payouts');
  const min = cfg.minPayoutMinor[b.currency] ?? 0;
  if (b.amountMinor < min) throw badRequest(`Minimum payout is ${min} (minor units)`);
  const fee = await payoutFee(b.amountMinor, b.currency, b.speed);
  if (fee >= b.amountMinor) throw badRequest('Amount is too small to cover the instant payout fee');
  const scheduledFor = b.speed === 'instant' ? new Date() : await nextStandardBatch();

  const payout = await tx(async (db) => {
    const p = await one(
      `INSERT INTO payouts (technician_id, currency, amount_minor, fee_minor, net_minor, speed, scheduled_for, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [techId, b.currency, b.amountMinor, fee, b.amountMinor - fee, b.speed, scheduledFor, profile.payout_provider],
      db,
    );
    await postToWallet(db, { userId: techId, currency: b.currency, amountMinor: -(b.amountMinor - fee), kind: 'withdrawal', payoutId: p.id, memo: `${b.speed} payout` });
    if (fee > 0) await postToWallet(db, { userId: techId, currency: b.currency, amountMinor: -fee, kind: 'fee', payoutId: p.id, memo: 'Instant payout fee' });
    return p;
  });
  await scheduler().schedulePayout(payout.id, Math.max(0, scheduledFor.getTime() - Date.now()));
  res.status(201).json({ payout });
});
