import { one, query, type Db } from '../db/pool.ts';
import { nextCampaignStatus, type Placement } from '../domain/ads.ts';
import { logger } from '../lib/logger.ts';
import { getSettings } from './settings.ts';

/**
 * Ads module service (Section 12). Every read used by customer-facing screens is wrapped so that a
 * failure in this module degrades to "no ads" — it can never break discovery or the Deals tab.
 */
export async function adsLive(): Promise<boolean> {
  const s = await getSettings();
  return s.features.advertising && s.adsEnabled;
}

export async function liveAds(placements: Placement[], categoryId: string | null, limit = 10) {
  try {
    if (!(await adsLive())) return [];
    return await query(
      `SELECT c.id, c.placement, cr.title, cr.body, cr.image_url, cr.click_url, ps.name AS seller_name
         FROM ad_campaigns c
         JOIN LATERAL (SELECT * FROM ad_creatives WHERE campaign_id = c.id ORDER BY created_at DESC LIMIT 1) cr ON true
         LEFT JOIN parts_sellers ps ON ps.id = c.seller_id AND ps.verification_status IN ('provisional', 'verified')
        WHERE c.placement = ANY($1) AND c.status = 'active'
          AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.ends_at IS NULL OR c.ends_at > now())
          AND ($2::uuid IS NULL OR cardinality(c.target_category_ids) = 0 OR $2 = ANY(c.target_category_ids))
        ORDER BY random() LIMIT $3`,
      [placements, categoryId, limit],
    );
  } catch (err) {
    logger.warn({ err }, 'ads module unavailable; serving no ads');
    return [];
  }
}

/** Impression / click, de-duplicated per user per campaign per day. Never throws. */
export async function recordAdEvent(campaignId: string, userId: string, type: 'impression' | 'click') {
  try {
    await query(
      `INSERT INTO ad_events (campaign_id, user_id, type) SELECT $1, $2, $3
        WHERE EXISTS (SELECT 1 FROM ad_campaigns WHERE id = $1 AND status = 'active')
       ON CONFLICT DO NOTHING`,
      [campaignId, userId, type],
    );
  } catch (err) {
    logger.warn({ err }, 'ad event not recorded');
  }
}

/** Move campaigns between approved / active / ended as payment and time windows allow. */
export async function refreshCampaignStatuses(db?: Db) {
  const rows = await query<any>(
    `SELECT id, status, payment_status, starts_at, ends_at FROM ad_campaigns WHERE status IN ('approved', 'active')`,
    [],
    db,
  );
  const now = new Date();
  let changed = 0;
  for (const r of rows) {
    const next = nextCampaignStatus({ status: r.status, paymentStatus: r.payment_status, startsAt: r.starts_at, endsAt: r.ends_at }, now);
    if (next !== r.status) {
      await query(`UPDATE ad_campaigns SET status = $2, updated_at = now() WHERE id = $1`, [r.id, next], db);
      changed++;
    }
  }
  return { changed };
}

/** Payment for an approved campaign settled (gateway, wallet, or recorded offline by an admin). */
export async function markCampaignPaid(db: Db, campaignId: string, paymentId: string | null, amountMinor: number) {
  const c = await one<any>(`SELECT * FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [campaignId], db);
  if (!c) return;
  await query(
    `UPDATE ad_campaigns SET payment_status = 'paid', paid_minor = paid_minor + $2, updated_at = now() WHERE id = $1`,
    [campaignId, amountMinor],
    db,
  );
  if (paymentId) {
    await query(
      `INSERT INTO payment_splits (payment_id, recipient, component, amount_minor) VALUES ($1, 'platform', 'ad', $2)`,
      [paymentId, amountMinor],
      db,
    );
  }
  await refreshCampaignStatuses(db);
}

export async function campaignStats(campaignIds: string[]) {
  if (campaignIds.length === 0) return new Map<string, { impressions: number; clicks: number }>();
  const rows = await query<{ campaign_id: string; impressions: number; clicks: number }>(
    `SELECT campaign_id, count(*) FILTER (WHERE type = 'impression')::int AS impressions, count(*) FILTER (WHERE type = 'click')::int AS clicks
       FROM ad_events WHERE campaign_id = ANY($1) GROUP BY 1`,
    [campaignIds],
  );
  return new Map(rows.map((r) => [r.campaign_id, { impressions: r.impressions, clicks: r.clicks }]));
}
