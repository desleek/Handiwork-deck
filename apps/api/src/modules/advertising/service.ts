import { type Queryable, one, pool, query } from '../../db/pool';
import { getSetting } from '../../services/settings';

/**
 * Section 12 advertising module: data access and billing. Nothing in the core
 * app imports from src/modules/advertising — the module reads core tables
 * (sellers, categories, files) but core never depends on it, so switching it
 * off (setting `advertising.enabled`) or removing it cannot affect booking,
 * payment, chat or rating flows.
 */

export type Placement = 'featured_seller' | 'brand_card' | 'sponsored_search';
export type PricingModel = 'flat_daily' | 'cpm' | 'cpc';

export async function adsEnabled(db: Queryable = pool) {
  return (await getSetting('advertising', db)).enabled;
}

/** Slot price for a placement in a currency, from the admin pricing table. */
export async function slotPrice(placement: Placement, currency: string) {
  const { pricing } = await getSetting('advertising');
  const p = pricing[placement];
  return { model: (p?.model ?? 'flat_daily') as PricingModel, rateMinor: p?.rateMinor[currency] ?? 0 };
}

/** Live campaigns: approved, in their flight dates, under budget. */
export const LIVE = `a.status = 'active'
  AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at > now())
  AND (a.budget_minor = 0 OR a.spent_minor < a.budget_minor)`;

/**
 * Billing per pricing model, recomputed on each event for the campaign-day:
 *  - flat_daily: the day rate, charged for each day the slot actually served
 *  - cpm: rate per 1000 impressions
 *  - cpc: rate per click
 */
export async function recordAdEvent(campaignIds: string[], kind: 'impression' | 'click') {
  if (!campaignIds.length) return;
  const imp = kind === 'impression' ? 1 : 0;
  const clk = kind === 'click' ? 1 : 0;
  await query(
    `INSERT INTO ad_daily_stats (campaign_id, day, impressions, clicks)
     SELECT id, current_date, $2, $3 FROM unnest($1::uuid[]) AS id
     ON CONFLICT (campaign_id, day) DO UPDATE
       SET impressions = ad_daily_stats.impressions + EXCLUDED.impressions, clicks = ad_daily_stats.clicks + EXCLUDED.clicks`,
    [campaignIds, imp, clk],
  );
  await query(
    `UPDATE ad_daily_stats s SET revenue_minor = CASE a.pricing_model
         WHEN 'cpm' THEN (s.impressions * a.rate_minor) / 1000
         WHEN 'cpc' THEN s.clicks * a.rate_minor
         ELSE a.rate_minor END
       FROM ad_campaigns a
      WHERE a.id = s.campaign_id AND s.campaign_id = ANY($1::uuid[]) AND s.day = current_date`,
    [campaignIds],
  );
  await query(
    `UPDATE ad_campaigns a SET impressions = a.impressions + $2, clicks = a.clicks + $3,
            spent_minor = (SELECT coalesce(sum(revenue_minor), 0) FROM ad_daily_stats s WHERE s.campaign_id = a.id)
      WHERE a.id = ANY($1::uuid[])`,
    [campaignIds, imp, clk],
  );
}

const CARD_FIELDS = `a.id, a.placement, a.title, a.body, a.click_url, a.seller_id,
  (SELECT url FROM files f WHERE f.id = a.creative_file_id) AS image_url`;

/** Featured seller cards: live featured_seller campaigns for sellers that are verified in the registry. */
export async function featuredSellers(opts: { categoryId?: number; limit: number }) {
  return query(
    `SELECT ${CARD_FIELDS}, s.name AS seller_name, s.city AS seller_city, s.category_ids AS seller_category_ids
       FROM ad_campaigns a JOIN spare_parts_sellers s ON s.id = a.seller_id
      WHERE a.placement = 'featured_seller' AND ${LIVE} AND s.status = 'verified'
        AND ($1::int IS NULL OR cardinality(a.target_category_ids) = 0 OR $1 = ANY(a.target_category_ids) OR $1 = ANY(s.category_ids))
      ORDER BY random() LIMIT $2`,
    [opts.categoryId ?? null, opts.limit],
  );
}

export async function brandCards(opts: { categoryId?: number; segment?: string; limit: number }) {
  return query(
    `SELECT ${CARD_FIELDS}, u.company_name AS advertiser_name
       FROM ad_campaigns a LEFT JOIN users u ON u.id = a.advertiser_id
      WHERE a.placement = 'brand_card' AND ${LIVE}
        AND ($1::int IS NULL OR cardinality(a.target_category_ids) = 0 OR $1 = ANY(a.target_category_ids))
        AND (a.target_segment IS NULL OR $2::service_segment IS NULL OR a.target_segment = $2)
      ORDER BY random() LIMIT $3`,
    [opts.categoryId ?? null, opts.segment ?? null, opts.limit],
  );
}

/** Organic results: the verified seller registry (never paid placement). */
export async function organicSellers(q: string, categoryId?: number, limit = 50) {
  return query(
    `SELECT id, name, city, address, category_ids FROM spare_parts_sellers
      WHERE status = 'verified'
        AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR city ILIKE '%' || $1 || '%')
        AND ($2::int IS NULL OR $2 = ANY(category_ids))
      ORDER BY name LIMIT $3`,
    [q, categoryId ?? null, limit],
  );
}

export async function sponsoredForSearch(q: string, categoryId: number | undefined, limit: number) {
  if (limit <= 0) return [];
  return query(
    `SELECT ${CARD_FIELDS}, coalesce(s.name, u.company_name) AS sponsor_name
       FROM ad_campaigns a LEFT JOIN spare_parts_sellers s ON s.id = a.seller_id LEFT JOIN users u ON u.id = a.advertiser_id
      WHERE a.placement = 'sponsored_search' AND ${LIVE}
        AND (a.seller_id IS NULL OR s.status = 'verified')
        AND ((($1 <> '') AND EXISTS (SELECT 1 FROM unnest(a.search_keywords) k WHERE $1 ILIKE '%' || k || '%' OR k ILIKE '%' || $1 || '%'))
             OR ($2::int IS NOT NULL AND $2 = ANY(a.target_category_ids)))
      ORDER BY random() LIMIT $3`,
    [q, categoryId ?? null, limit],
  );
}

/**
 * Interleaves sponsored results into organic ones: at most one sponsored slot
 * per `organicPerSponsored` organic results, each clearly labeled, and placed
 * at the top of its block of organic results.
 */
export function interleave<O, S>(organic: O[], sponsored: S[], organicPerSponsored: number) {
  const slots = Math.min(sponsored.length, Math.floor(organic.length / organicPerSponsored));
  const out: ({ sponsored: false; label: null; item: O } | { sponsored: true; label: 'Sponsored'; item: S })[] = [];
  for (let block = 0; block * organicPerSponsored < organic.length; block++) {
    if (block < slots) out.push({ sponsored: true, label: 'Sponsored', item: sponsored[block]! });
    for (const o of organic.slice(block * organicPerSponsored, (block + 1) * organicPerSponsored)) out.push({ sponsored: false, label: null, item: o });
  }
  return out;
}

export async function campaignStats(campaignId: string, days = 30) {
  return query(
    `SELECT day, impressions, clicks, revenue_minor FROM ad_daily_stats
      WHERE campaign_id = $1 AND day > current_date - $2::int ORDER BY day`,
    [campaignId, days],
  );
}

export async function getCampaign(id: string) {
  return one('SELECT * FROM ad_campaigns WHERE id = $1', [id]);
}
