import { adjustLabor, SERVICE_SEGMENTS } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool';
import { authenticate, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { performanceFor } from '../services/ratings';

export const discoverRouter = Router();

/** A technician's live position is shown only if their last heartbeat is this recent. */
export const LIVE_POSITION_TTL_MIN = 15;
/** Most boosted cards shown above organic results. */
export const MAX_BOOSTED = 4;

const DiscoverQuery = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  segment: z.enum(SERVICE_SEGMENTS).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(500).default(25),
  q: z.string().trim().max(80).optional(),
  instantBookOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

interface Row {
  id: string;
  rate_bps: number;
  full_name: string;
  headline: string | null;
  avatar_url: string | null;
  rating_avg: number;
  rating_count: number;
  instant_book_enabled: boolean;
  available_now: boolean;
  labor_only_policy: string;
  live_lat: number | null;
  live_lng: number | null;
  distance_km: number | null;
  category_id: number;
  category_name: string;
  category_icon: string | null;
  starting_price_minor: number | null;
  currency: string | null;
  boost_priority: number | null;
}

/**
 * The customer's primary browsing surface: technician cards (photo, category
 * icon, rating, starting price) for the icon-first grid and the map. Boosted
 * technicians come first in their own clearly-labelled list; organic results
 * rank by performance multiplier, rating and proximity.
 */
discoverRouter.get('/discover', authenticate, requireUser(), async (req, res) => {
  const q = parse(DiscoverQuery, req.query);
  const hasPoint = q.lat !== undefined && q.lng !== undefined;

  const rows = await query<Row>(
    `WITH candidates AS (
       SELECT u.id, u.full_name, tp.headline, tp.rating_avg::float8 AS rating_avg, tp.rating_count,
              tp.instant_book_enabled, technician_available_at(tp.user_id, now()) AS available_now,
              (SELECT url FROM files f WHERE f.id = tp.avatar_file_id) AS avatar_url,
              COALESCE(tp.rate_override_bps, tp.rate_adjustment_bps) AS rate_bps,
              CASE WHEN tp.live_at > now() - make_interval(mins => $8) THEN tp.live_lat END AS live_lat,
              CASE WHEN tp.live_at > now() - make_interval(mins => $8) THEN tp.live_lng END AS live_lng,
              tp.base_lat, tp.base_lng
         FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
        WHERE u.is_active AND tp.is_available AND tp.verification_status = 'verified'
          AND ($6::text IS NULL OR u.full_name ILIKE '%' || $6 || '%' OR tp.headline ILIKE '%' || $6 || '%')
          AND (NOT $7 OR tp.instant_book_enabled)
     ),
     located AS (
       SELECT c.*, COALESCE(c.live_lat, c.base_lat) AS pos_lat, COALESCE(c.live_lng, c.base_lng) AS pos_lng FROM candidates c
     ),
     scored AS (
       SELECT l.*,
              CASE WHEN $3::float8 IS NULL OR l.pos_lat IS NULL THEN NULL ELSE
                2 * 6371 * asin(sqrt(power(sin(radians(l.pos_lat - $3) / 2), 2) +
                  cos(radians($3)) * cos(radians(l.pos_lat)) * power(sin(radians(l.pos_lng - $4) / 2), 2)))
              END AS distance_km,
              svc.category_id, svc.category_name, svc.category_icon, svc.base_rate_minor AS starting_price_minor, svc.currency, svc.labor_only_policy,
              (SELECT max(b.priority) FROM technician_boosts b
                WHERE b.technician_id = l.id AND now() BETWEEN b.starts_at AND b.ends_at
                  AND (b.category_id IS NULL OR b.category_id = svc.category_id)) AS boost_priority
         FROM located l
         JOIN LATERAL (
           SELECT c.id AS category_id, c.name AS category_name, c.icon AS category_icon, ts.base_rate_minor, ts.currency, ts.labor_only_policy
             FROM technician_services ts JOIN service_categories c ON c.id = ts.category_id
            WHERE ts.technician_id = l.id AND c.is_active
              AND ($1::int IS NULL OR c.id = $1) AND ($2::service_segment IS NULL OR c.segment = $2)
            ORDER BY (ts.base_rate_minor IS NULL), ts.base_rate_minor, c.sort_order
            LIMIT 1
         ) svc ON true
     )
     SELECT id, full_name, headline, avatar_url, rating_avg, rating_count, rate_bps, instant_book_enabled, available_now, labor_only_policy,
            round(live_lat::numeric, 3)::float8 AS live_lat, round(live_lng::numeric, 3)::float8 AS live_lng,
            distance_km, category_id, category_name, category_icon, starting_price_minor, currency, boost_priority
       FROM scored
      -- With a search point, only technicians with a known position inside the radius.
      WHERE ($3::float8 IS NULL OR distance_km <= $5)
      LIMIT 500`,
    [q.categoryId ?? null, q.segment ?? null, hasPoint ? q.lat : null, hasPoint ? q.lng : null, q.radiusKm, q.q ?? null, q.instantBookOnly ?? false, LIVE_POSITION_TTL_MIN],
  );

  const perf = await performanceFor(rows.map((r) => r.id));
  const cards = rows.map((r) => {
    const p = perf.get(r.id)!;
    return {
      id: r.id,
      fullName: r.full_name,
      headline: r.headline,
      photoUrl: r.avatar_url,
      category: { id: r.category_id, name: r.category_name, icon: r.category_icon },
      rating: { avg: Number(r.rating_avg), count: r.rating_count },
      // Section 7a: the standard rate shown includes the technician's performance adjustment.
      startingPrice:
        r.starting_price_minor != null && r.currency ? { amountMinor: adjustLabor(Number(r.starting_price_minor), r.rate_bps), currency: r.currency } : null,
      distanceKm: r.distance_km == null ? null : Math.round(r.distance_km * 10) / 10,
      livePosition: r.live_lat != null && r.live_lng != null ? { lat: r.live_lat, lng: r.live_lng } : null,
      instantBook: r.instant_book_enabled,
      availableNow: r.available_now,
      /** Labor-only declaration for the card's category. */
      laborOnly: r.labor_only_policy,
      performance: p,
      boosted: r.boost_priority != null,
      _boostPriority: r.boost_priority ?? -1,
      _score: organicScore(p.multiplier, Number(r.rating_avg), r.rating_count, r.distance_km),
    };
  });

  const boosted = cards
    .filter((c) => c.boosted)
    .sort((a, b) => b._boostPriority - a._boostPriority || b._score - a._score)
    .slice(0, MAX_BOOSTED);
  const boostedIds = new Set(boosted.map((c) => c.id));
  const organic = cards
    .filter((c) => !boostedIds.has(c.id))
    .sort((a, b) => b._score - a._score)
    .slice(0, q.limit);

  const strip = ({ _boostPriority, _score, ...c }: (typeof cards)[number]) => c;
  res.json({ boosted: boosted.map(strip), organic: organic.map(strip) });
});

/**
 * Organic ranking: performance multiplier (Section 7a) × rolling rating (unrated
 * technicians count as 4★ so newcomers aren't buried) ÷ a gentle distance decay.
 */
export function organicScore(multiplier: number, ratingAvg: number, ratingCount: number, distanceKm: number | null): number {
  const rating = ratingCount > 0 ? ratingAvg : 4;
  const proximity = distanceKm == null ? 1 : 1 / (1 + distanceKm / 10);
  return multiplier * (rating / 5) * proximity;
}
