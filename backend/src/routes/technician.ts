import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.ts';
import { checkBoostEligibility, canSendAlertToday, priceProfileBoost } from '../domain/boosts.ts';
import { canSwitchStance } from '../domain/laborOnly.ts';
import { multiplierContext } from '../domain/ratings.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { startPayment } from '../services/payments/escrow.ts';
import { activeRestrictions } from '../services/restrictions.ts';
import { getSettings } from '../services/settings.ts';
import { isRestricted } from '../domain/penalties.ts';

export const technician = Router();
technician.use(authenticate, requireUser('technician'));

const money = z.number().int().nonnegative();

technician.get('/profile', async (req, res) => {
  const id = req.user!.id;
  const [profile, categories, portfolio, certifications, availability] = await Promise.all([
    one('SELECT * FROM technician_profiles WHERE user_id = $1', [id]),
    query(
      `SELECT tc.*, c.name, c.icon, c.supercategory FROM technician_categories tc
         JOIN service_categories c ON c.id = tc.category_id WHERE tc.technician_id = $1`,
      [id],
    ),
    query('SELECT * FROM portfolio_images WHERE technician_id = $1 ORDER BY position', [id]),
    query('SELECT * FROM certifications WHERE technician_id = $1 ORDER BY created_at', [id]),
    query('SELECT * FROM availability_slots WHERE technician_id = $1 ORDER BY weekday, start_time', [id]),
  ]);
  res.json({ profile, categories, portfolio, certifications, availability });
});

/** Onboarding: bio, ID document, coverage area. */
technician.put('/profile', async (req, res) => {
  const b = parse(
    z.object({
      bio: z.string().max(2000).optional(),
      idDocumentUrl: z.string().url().optional(),
      coverage: z.object({ lat: z.number(), lng: z.number(), radiusKm: z.number().min(1).max(100) }).optional(),
    }),
    req.body,
  );
  const p = await one(
    `UPDATE technician_profiles SET
       bio = COALESCE($2, bio),
       id_document_url = COALESCE($3, id_document_url),
       verification_status = CASE WHEN $3 IS NOT NULL AND verification_status = 'rejected' THEN 'pending' ELSE verification_status END,
       coverage_lat = COALESCE($4, coverage_lat), coverage_lng = COALESCE($5, coverage_lng),
       coverage_radius_km = COALESCE($6, coverage_radius_km), updated_at = now()
     WHERE user_id = $1 RETURNING *`,
    [req.user!.id, b.bio ?? null, b.idDocumentUrl ?? null, b.coverage?.lat ?? null, b.coverage?.lng ?? null, b.coverage?.radiusKm ?? null],
  );
  res.json(p);
});

/**
 * Add a service category with the mandatory per-category labor-only declaration (Section 4):
 * "accept" or "decline_from_inception".
 */
technician.post('/categories', async (req, res) => {
  const b = parse(
    z.object({
      categoryId: z.string().uuid(),
      startingPriceMinor: money,
      laborOnlyStance: z.enum(['accept', 'decline_from_inception']),
    }),
    req.body,
  );
  const cat = await one<{ supercategory: string }>(`SELECT supercategory FROM service_categories WHERE id = $1 AND is_active AND approval_status = 'approved'`, [b.categoryId]);
  if (!cat) throw notFound('Category');
  await tx(async (db) => {
    await query(
      `INSERT INTO technician_categories (technician_id, category_id, starting_price_minor, labor_only_stance)
       VALUES ($1, $2, $3, $4)`,
      [req.user!.id, b.categoryId, b.startingPriceMinor, b.laborOnlyStance],
      db,
    );
    await query(
      `INSERT INTO labor_only_stance_history (technician_id, category_id, from_stance, to_stance) VALUES ($1, $2, NULL, $3)`,
      [req.user!.id, b.categoryId, b.laborOnlyStance],
      db,
    );
  });
  res.status(201).json({ ok: true });
});

technician.patch('/categories/:categoryId', async (req, res) => {
  const categoryId = parse(z.string().uuid(), req.params.categoryId);
  const b = parse(
    z.object({ startingPriceMinor: money.optional(), laborOnlyStance: z.enum(['accept', 'decline_from_inception']).optional() }),
    req.body,
  );
  const s = await getSettings();
  const result = await tx(async (db) => {
    const cur = await one<any>(
      'SELECT * FROM technician_categories WHERE technician_id = $1 AND category_id = $2 FOR UPDATE',
      [req.user!.id, categoryId],
      db,
    );
    if (!cur) throw notFound('Category');
    if (b.laborOnlyStance && b.laborOnlyStance !== cur.labor_only_stance) {
      // Cooldown between switches; past rejection counts are never erased (Section 6b).
      const check = canSwitchStance(cur.stance_changed_at, new Date(), s.laborOnlyStanceCooldownDays);
      if (!check.allowed) {
        throw conflict('STANCE_COOLDOWN', `You can change this setting again on ${check.nextAllowedAt.toDateString()}`, {
          nextAllowedAt: check.nextAllowedAt,
        });
      }
      await query(
        `INSERT INTO labor_only_stance_history (technician_id, category_id, from_stance, to_stance) VALUES ($1,$2,$3,$4)`,
        [req.user!.id, categoryId, cur.labor_only_stance, b.laborOnlyStance],
        db,
      );
    }
    // Changing the standard rate only affects future quotes; submitted/approved quotes are frozen.
    return one(
      `UPDATE technician_categories SET
         starting_price_minor = COALESCE($3, starting_price_minor),
         labor_only_stance = COALESCE($4, labor_only_stance),
         stance_changed_at = CASE WHEN $4 IS NOT NULL AND $4::labor_only_stance <> labor_only_stance THEN now() ELSE stance_changed_at END
       WHERE technician_id = $1 AND category_id = $2 RETURNING *`,
      [req.user!.id, categoryId, b.startingPriceMinor ?? null, b.laborOnlyStance ?? null],
      db,
    );
  });
  res.json(result);
});

/** Portfolio: max 5 images (also enforced by a DB constraint on position 1–5). */
technician.post('/portfolio', async (req, res) => {
  const b = parse(z.object({ url: z.string().url(), caption: z.string().max(200).optional() }), req.body);
  const used = await query<{ position: number }>('SELECT position FROM portfolio_images WHERE technician_id = $1', [req.user!.id]);
  const free = [1, 2, 3, 4, 5].find((p) => !used.some((u) => u.position === p));
  if (!free) throw conflict('PORTFOLIO_FULL', 'You can show up to 5 portfolio images. Remove one first.');
  const img = await one(
    `INSERT INTO portfolio_images (technician_id, url, caption, position) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user!.id, b.url, b.caption ?? null, free],
  );
  res.status(201).json(img);
});

technician.delete('/portfolio/:id', async (req, res) => {
  await query('DELETE FROM portfolio_images WHERE id = $1 AND technician_id = $2', [parse(z.string().uuid(), req.params.id), req.user!.id]);
  res.status(204).end();
});

technician.post('/certifications', async (req, res) => {
  const b = parse(z.object({ title: z.string().min(2).max(200), issuer: z.string().max(200).optional(), fileUrl: z.string().url() }), req.body);
  res.status(201).json(
    await one(
      'INSERT INTO certifications (technician_id, title, issuer, file_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user!.id, b.title, b.issuer ?? null, b.fileUrl],
    ),
  );
});

technician.put('/availability', async (req, res) => {
  const slots = parse(
    z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).max(50),
    req.body,
  );
  await tx(async (db) => {
    await query('DELETE FROM availability_slots WHERE technician_id = $1', [req.user!.id], db);
    for (const s of slots) {
      if (s.end <= s.start) throw badRequest('INVALID_SLOT', 'End time must be after start time');
      await query('INSERT INTO availability_slots (technician_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [
        req.user!.id, s.weekday, s.start, s.end,
      ], db);
    }
  });
  res.status(204).end();
});

/**
 * Online toggle (Section 9). Location is only collected while online; going offline clears the
 * live position so customers stop seeing it.
 */
technician.post('/online', async (req, res) => {
  const b = parse(z.object({ online: z.boolean(), lat: z.number().optional(), lng: z.number().optional() }), req.body);
  const p = await one<{ verification_status: string }>('SELECT verification_status FROM technician_profiles WHERE user_id = $1', [req.user!.id]);
  if (b.online && p?.verification_status !== 'verified') throw forbidden('NOT_VERIFIED', 'Your account must be verified before going online');
  await query(
    `UPDATE technician_profiles SET is_online = $2,
       last_lat = CASE WHEN $2 THEN $3::float8 ELSE NULL END, last_lng = CASE WHEN $2 THEN $4::float8 ELSE NULL END,
       last_location_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
     WHERE user_id = $1`,
    [req.user!.id, b.online, b.lat ?? null, b.lng ?? null],
  );
  res.status(204).end();
});

technician.post('/location', async (req, res) => {
  const b = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), heading: z.number().optional() }), req.body);
  const r = await query(
    `UPDATE technician_profiles SET last_lat = $2, last_lng = $3, last_location_at = now() WHERE user_id = $1 AND is_online RETURNING 1`,
    [req.user!.id, b.lat, b.lng],
  );
  if (r.length === 0) throw conflict('OFFLINE', 'Go online to share your location');
  res.status(204).end();
});

/** Earnings dashboard (Section 4): balance, earnings, current multiplier, what drives it, next tier. */
technician.get('/earnings', async (req, res) => {
  const id = req.user!.id;
  const s = await getSettings();
  const [profile, wallet, totals, recent, multHistory] = await Promise.all([
    one<any>('SELECT rating_avg, rating_count, performance_multiplier_bps, multiplier_updated_at FROM technician_profiles WHERE user_id = $1', [id]),
    one<{ balance_minor: number }>('SELECT balance_minor FROM wallets WHERE user_id = $1', [id]),
    one(
      `SELECT COALESCE(sum(amount_minor) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS last_30_days_minor,
              COALESCE(sum(amount_minor), 0) AS lifetime_minor
         FROM wallet_ledger WHERE user_id = $1 AND type = 'earning'`,
      [id],
    ),
    query(`SELECT * FROM wallet_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]),
    query(`SELECT from_bps, to_bps, rating_avg, computed_at FROM multiplier_history WHERE technician_id = $1 ORDER BY computed_at DESC LIMIT 6`, [id]),
  ]);
  const ctx = multiplierContext(profile.rating_avg, s.multiplierTiers);
  const nextRecalc = profile.multiplier_updated_at
    ? new Date(new Date(profile.multiplier_updated_at).getTime() + s.multiplierCycleDays * 86_400_000)
    : null;
  res.json({
    balanceMinor: wallet?.balance_minor ?? 0,
    ...totals,
    recent,
    performance: {
      enabled: s.features.performanceMultiplier,
      ratingAvg: profile.rating_avg,
      ratingCount: profile.rating_count,
      currentMultiplierBps: s.features.performanceMultiplier ? profile.performance_multiplier_bps : 0,
      tier: ctx.current,
      nextTier: ctx.next,
      tierBelow: ctx.below,
      drivers: 'Your rolling average across all 7 review categories, weighted towards recent jobs',
      appliesTo: 'Labor only — never parts or markup. Already-submitted quotes keep their original rate.',
      nextRecalculationAt: nextRecalc,
      history: multHistory,
    },
    boostEligibility: {
      minRating: s.boostMinRating,
      eligible: (profile.rating_avg ?? 0) >= s.boostMinRating,
    },
  });
});

// ---------------------------------------------------------------------------
// Section 16 — visibility boosts & push alerts (behind the `boosts` feature flag)
// ---------------------------------------------------------------------------

async function eligibilityOrThrow(userId: string) {
  const s = await getSettings();
  const p = await one<any>('SELECT rating_avg, boost_privileges_suspended, verification_status FROM technician_profiles WHERE user_id = $1', [userId]);
  const restricted = isRestricted(await activeRestrictions(userId), 'purchase_boost', new Date());
  const denial = checkBoostEligibility({
    featureEnabled: s.features.boosts,
    ratingAvg: p.rating_avg,
    minRating: s.boostMinRating,
    privilegesSuspended: p.boost_privileges_suspended,
    restricted,
    verified: p.verification_status === 'verified',
  });
  if (denial) throw forbidden(denial, `Not eligible to purchase a boost (${denial})`);
  return { s, rating: Number(p.rating_avg) };
}

technician.post('/boosts', async (req, res) => {
  const b = parse(
    z.object({
      categoryId: z.string().uuid(),
      hours: z.number().int().min(1).max(168),
      startsAt: z.coerce.date().optional(),
      ratePerHourMinor: money.optional(),
      channel: z.enum(['wallet', 'card', 'bank_transfer', 'ussd']), // never on credit
    }),
    req.body,
  );
  const { s, rating } = await eligibilityOrThrow(req.user!.id); // server-side gate at the moment of purchase
  const offers = await one('SELECT 1 FROM technician_categories WHERE technician_id = $1 AND category_id = $2', [req.user!.id, b.categoryId]);
  if (!offers) throw badRequest('CATEGORY_NOT_OFFERED', 'You can only boost a category you offer');
  const rate = b.ratePerHourMinor ?? s.boostMaxRatePerHourMinor;
  const priced = priceProfileBoost({ ratePerHourMinor: rate, hours: b.hours, capMinor: s.boostMaxRatePerHourMinor, mode: s.boostPricingMode });
  if ('error' in priced) throw badRequest(priced.error, 'Invalid boost rate');
  const startsAt = b.startsAt && b.startsAt > new Date() ? b.startsAt : new Date();
  const endsAt = new Date(startsAt.getTime() + b.hours * 3_600_000);
  const boost = await one<{ id: string }>(
    `INSERT INTO boosts (technician_id, category_id, rate_per_hour_minor, hours, total_minor, starts_at, ends_at, rating_at_purchase)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.user!.id, b.categoryId, rate, b.hours, priced.totalMinor, startsAt, endsAt, rating],
  );
  const payment = await startPayment({
    payer: req.user!,
    purpose: 'boost',
    amountMinor: priced.totalMinor,
    currency: s.currency,
    channel: b.channel,
    description: `Profile boost — ${b.hours}h`,
    boostId: boost!.id,
  });
  res.status(201).json({ boostId: boost!.id, totalMinor: priced.totalMinor, startsAt, endsAt, payment });
});

technician.post('/push-alerts', async (req, res) => {
  const b = parse(z.object({ categoryId: z.string().uuid(), channel: z.enum(['wallet', 'card', 'bank_transfer', 'ussd']) }), req.body);
  const { s, rating } = await eligibilityOrThrow(req.user!.id);
  const p = await one<{ is_online: boolean }>('SELECT is_online FROM technician_profiles WHERE user_id = $1', [req.user!.id]);
  if (!p?.is_online) throw conflict('OFFLINE', 'Go online before announcing that you are available');
  const sent = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM push_alert_sends WHERE technician_id = $1 AND status IN ('sent', 'pending_payment')
       AND created_at > now() - interval '24 hours'`,
    [req.user!.id],
  );
  if (!canSendAlertToday(sent!.n, s.pushAlertMaxPerDay)) {
    throw conflict('DAILY_ALERT_LIMIT', `You can send up to ${s.pushAlertMaxPerDay} availability alerts per day`);
  }
  const alertId = randomUUID();
  await query(
    `INSERT INTO push_alert_sends (id, technician_id, category_id, fee_minor, rating_at_purchase) VALUES ($1,$2,$3,$4,$5)`,
    [alertId, req.user!.id, b.categoryId, s.pushAlertFeeMinor, rating],
  );
  const payment = await startPayment({
    payer: req.user!,
    purpose: 'push_alert',
    amountMinor: s.pushAlertFeeMinor,
    currency: s.currency,
    channel: b.channel,
    description: 'Availability alert',
    metadata: { alertId },
  });
  await query('UPDATE push_alert_sends SET payment_id = $2 WHERE id = $1', [alertId, payment.paymentId]);
  res.status(201).json({ alertId, feeMinor: s.pushAlertFeeMinor, payment });
});

technician.get('/boosts', async (req, res) => {
  res.json({
    boosts: await query('SELECT * FROM boosts WHERE technician_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user!.id]),
    alerts: await query('SELECT * FROM push_alert_sends WHERE technician_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user!.id]),
  });
});
