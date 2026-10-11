import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.ts';
import { interleaveSponsored, rankCandidates, type Candidate } from '../domain/discovery.ts';
import { applyMultiplier } from '../domain/pricing.ts';
import { multiplierContext } from '../domain/ratings.ts';
import { notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { getSettings } from '../services/settings.ts';

export const catalog = Router();

/** Public taxonomy for the discovery grid. Only active, approved categories. */
catalog.get('/categories', async (_req, res) => {
  const rows = await query(
    `SELECT id, supercategory, name, slug, icon, is_custom FROM service_categories
      WHERE is_active AND approval_status = 'approved' ORDER BY supercategory, sort_order, name`,
  );
  const s = await getSettings();
  res.json({
    household_office: rows.filter((r) => r.supercategory === 'household_office'),
    construction: s.features.construction ? rows.filter((r) => r.supercategory === 'construction') : [],
  });
});

const DiscoverQuery = z.object({
  categoryId: z.string().uuid().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(100).default(25),
  onlineOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

/**
 * Icon-first discovery grid + map (Sections 3, 9, 14, 16).
 * Response items are typed: `technician` (with optional "promoted" label) or `sponsored` (ads module),
 * so the client can never present a sponsored listing as a technician match.
 */
catalog.get('/technicians', authenticate, requireUser(), async (req, res) => {
  const q = parse(DiscoverQuery, req.query);
  const s = await getSettings();
  const hasLoc = q.lat !== undefined && q.lng !== undefined;

  const rows = await query<any>(
    `WITH base AS (
       SELECT u.id, u.full_name, u.avatar_url, t.rating_avg, t.rating_count, t.is_online,
              t.performance_multiplier_bps, t.coverage_radius_km,
              CASE WHEN t.is_online THEN t.last_lat END AS live_lat,
              CASE WHEN t.is_online THEN t.last_lng END AS live_lng,
              COALESCE(t.last_lat, t.coverage_lat) AS ref_lat, COALESCE(t.last_lng, t.coverage_lng) AS ref_lng,
              tc.category_id, tc.starting_price_minor, tc.labor_only_stance,
              c.name AS category_name, c.icon AS category_icon,
              (SELECT url FROM portfolio_images p WHERE p.technician_id = u.id AND p.moderation_status = 'approved' ORDER BY position LIMIT 1) AS photo_url,
              (SELECT b.rate_per_hour_minor FROM boosts b
                 WHERE b.technician_id = u.id AND b.category_id = tc.category_id
                   AND b.status IN ('scheduled', 'active') AND b.starts_at <= now() AND b.ends_at > now()
                 ORDER BY b.rate_per_hour_minor DESC LIMIT 1) AS boost_rate_minor
         FROM technician_profiles t
         JOIN users u ON u.id = t.user_id AND u.status IN ('active', 'restricted')
         JOIN technician_categories tc ON tc.technician_id = t.user_id
         JOIN service_categories c ON c.id = tc.category_id AND c.is_active
        WHERE t.verification_status = 'verified'
          AND ($1::uuid IS NULL OR tc.category_id = $1)
          AND (NOT $2 OR t.is_online)
     )
     SELECT DISTINCT ON (id) *,
       CASE WHEN $3::float8 IS NULL OR ref_lat IS NULL THEN NULL ELSE
         6371 * 2 * asin(sqrt(power(sin(radians(ref_lat - $3) / 2), 2) +
           cos(radians($3)) * cos(radians(ref_lat)) * power(sin(radians(ref_lng - $4) / 2), 2)))
       END AS distance_km
     FROM base
     ORDER BY id, boost_rate_minor DESC NULLS LAST, starting_price_minor`,
    [q.categoryId ?? null, q.onlineOnly, hasLoc ? q.lat : null, hasLoc ? q.lng : null],
  );

  const inRange = rows.filter(
    (r) => r.distance_km === null || (r.distance_km <= q.radiusKm && r.distance_km <= Number(r.coverage_radius_km) + q.radiusKm),
  );
  const candidates: (Candidate & { row: any })[] = inRange.map((r) => ({
    id: r.id,
    ratingAvg: r.rating_avg,
    ratingCount: r.rating_count,
    distanceKm: r.distance_km,
    isOnline: r.is_online,
    // Boost placement is scoped to the category being browsed.
    boostRateMinor: q.categoryId ? r.boost_rate_minor : null,
    row: r,
  }));
  const ranked = rankCandidates(candidates, s.boostTieBreak, Math.floor(Date.now() / 3_600_000)).slice(0, q.limit);

  let ads: any[] = [];
  if (s.features.advertising && s.adsEnabled) {
    ads = await query(
      `SELECT c.id, cr.title, cr.body, cr.image_url, cr.click_url, ps.name AS seller_name
         FROM ad_campaigns c JOIN ad_creatives cr ON cr.campaign_id = c.id
         LEFT JOIN parts_sellers ps ON ps.id = c.seller_id
        WHERE c.placement = 'sponsored_search' AND c.status = 'active'
          AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.ends_at IS NULL OR c.ends_at > now())
          AND ($1::uuid IS NULL OR cardinality(c.target_category_ids) = 0 OR $1 = ANY(c.target_category_ids))
        LIMIT 5`,
      [q.categoryId ?? null],
    );
  }

  const multiplierOn = s.features.performanceMultiplier;
  const items = interleaveSponsored(ranked, ads, s.sponsoredMaxPerOrganic).map((entry) => {
    if (entry.type === 'sponsored') return { type: 'sponsored' as const, label: 'Sponsored', ad: entry.ad };
    const r = entry.listing.item.row;
    return {
      type: 'technician' as const,
      label: entry.listing.label === 'promoted' ? 'Promoted' : null,
      id: r.id,
      name: r.full_name,
      avatarUrl: r.avatar_url,
      photoUrl: r.photo_url,
      category: { id: r.category_id, name: r.category_name, icon: r.category_icon },
      ratingAvg: r.rating_avg,
      ratingCount: r.rating_count,
      startingPriceMinor: applyMultiplier(r.starting_price_minor, multiplierOn ? r.performance_multiplier_bps : 0),
      laborOnlyStance: r.labor_only_stance,
      isOnline: r.is_online,
      distanceKm: r.distance_km === null ? null : Math.round(r.distance_km * 10) / 10,
      // Live position only while the technician is toggled online (Section 9).
      liveLocation: r.is_online && r.live_lat !== null ? { lat: r.live_lat, lng: r.live_lng } : null,
    };
  });

  if (q.categoryId && req.user!.role === 'customer') {
    await query(
      `INSERT INTO category_interest (user_id, category_id) VALUES ($1, $2)
       ON CONFLICT (user_id, category_id) DO UPDATE SET last_seen_at = now()`,
      [req.user!.id, q.categoryId],
    );
  }
  res.json({ items });
});

/** Full public profile (Section 3). */
catalog.get('/technicians/:id', authenticate, requireUser(), async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const s = await getSettings();
  const t = await one<any>(
    `SELECT u.id, u.full_name, u.avatar_url, t.bio, t.rating_avg, t.rating_count, t.is_online,
            t.performance_multiplier_bps, t.coverage_radius_km, t.verification_status
       FROM technician_profiles t JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND u.status IN ('active', 'restricted') AND t.verification_status = 'verified'`,
    [id],
  );
  if (!t) throw notFound('Technician');
  const multiplierBps = s.features.performanceMultiplier ? t.performance_multiplier_bps : 0;

  const [categories, portfolio, certifications, reviews, scoreSummary] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.icon, tc.starting_price_minor, tc.labor_only_stance
         FROM technician_categories tc JOIN service_categories c ON c.id = tc.category_id
        WHERE tc.technician_id = $1 AND c.is_active ORDER BY c.name`,
      [id],
    ),
    query(`SELECT id, url, caption, position FROM portfolio_images WHERE technician_id = $1 AND moderation_status = 'approved' ORDER BY position`, [id]),
    query(`SELECT id, title, issuer FROM certifications WHERE technician_id = $1 AND status = 'verified'`, [id]),
    query(
      `SELECT r.id, r.overall, r.review_text, r.created_at, c.name AS category,
              r.competence, r.punctuality, r.professionalism, r.courtesy, r.delivery_timeline, r.pricing_fairness, r.quality_of_work,
              split_part(u.full_name, ' ', 1) AS customer_first_name
         FROM technician_ratings r JOIN service_categories c ON c.id = r.category_id JOIN users u ON u.id = r.customer_id
        WHERE r.technician_id = $1 AND r.moderation_status = 'approved'
        ORDER BY r.created_at DESC LIMIT 50`,
      [id],
    ),
    one(
      `SELECT round(avg(competence),1) AS competence, round(avg(punctuality),1) AS punctuality,
              round(avg(professionalism),1) AS professionalism, round(avg(courtesy),1) AS courtesy,
              round(avg(delivery_timeline),1) AS delivery_timeline, round(avg(pricing_fairness),1) AS pricing_fairness,
              round(avg(quality_of_work),1) AS quality_of_work
         FROM technician_ratings WHERE technician_id = $1 AND moderation_status = 'approved'`,
      [id],
    ),
  ]);

  const ctx = multiplierContext(t.rating_avg, s.multiplierTiers);
  res.json({
    id: t.id,
    name: t.full_name,
    avatarUrl: t.avatar_url,
    bio: t.bio,
    ratingAvg: t.rating_avg,
    ratingCount: t.rating_count,
    isOnline: t.is_online,
    categories: categories.map((c: any) => ({
      ...c,
      startingPriceMinor: applyMultiplier(c.starting_price_minor, multiplierBps),
      // Public, always visible (Section 6b)
      laborOnly: c.labor_only_stance === 'accept' ? 'Accepts labor-only jobs' : 'Does not take labor-only jobs',
    })),
    portfolio,
    certifications,
    categoryScores: scoreSummary,
    reviews,
    // Performance multiplier context (Section 3): why the labor rate is what it is.
    rateContext: s.features.performanceMultiplier
      ? { multiplierBps, explanation: `Labor rates ${multiplierBps >= 0 ? '+' : ''}${multiplierBps / 100}% based on a ${ctx.current.stars}★ rolling rating` }
      : null,
  });
});

/** Verified spare-parts sellers, for the price-challenge evidence picker (Section 10). */
catalog.get('/sellers', authenticate, requireUser(), async (req, res) => {
  const q = parse(z.object({ search: z.string().trim().max(80).default('') }), req.query);
  res.json(
    await query(
      `SELECT id, name, address, verification_status FROM parts_sellers
        WHERE verification_status IN ('provisional', 'verified') AND merged_into IS NULL
          AND ($1 = '' OR name ILIKE '%' || $1 || '%')
        ORDER BY verification_status = 'verified' DESC, name LIMIT 30`,
      [q.search],
    ),
  );
});

/** Marketplace / Deals tab — isolated ads module. Returns an empty state when disabled. */
catalog.get('/deals', authenticate, requireUser(), async (_req, res) => {
  const s = await getSettings();
  if (!(s.features.advertising && s.adsEnabled)) return res.json({ enabled: false, featuredSellers: [], ads: [] });
  const [featuredSellers, ads] = await Promise.all([
    query(`SELECT id, name, address FROM parts_sellers WHERE verification_status = 'verified' ORDER BY clean_approvals DESC LIMIT 10`),
    query(
      `SELECT c.id, c.placement, cr.title, cr.body, cr.image_url, cr.click_url FROM ad_campaigns c
         JOIN ad_creatives cr ON cr.campaign_id = c.id
        WHERE c.status = 'active' AND c.placement IN ('deals_featured', 'deals_brand')
          AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.ends_at IS NULL OR c.ends_at > now())`,
    ),
  ]);
  res.json({ enabled: true, featuredSellers, ads });
});
