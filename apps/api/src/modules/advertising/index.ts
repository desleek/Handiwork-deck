import { SERVICE_SEGMENTS } from '@handiwork/shared';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { one, query } from '../../db/pool';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { authenticate, currentUser, requireUser } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { getSetting } from '../../services/settings';
import {
  adsEnabled,
  brandCards,
  campaignStats,
  featuredSellers,
  interleave,
  organicSellers,
  type Placement,
  recordAdEvent,
  slotPrice,
  sponsoredForSearch,
} from './service';

/**
 * Section 12: the Marketplace / Deals module.
 *
 * - Lives entirely under /v1/marketplace, /v1/advertiser and /v1/admin/ads. It
 *   is never rendered inside booking, payment, chat or rating flows.
 * - Mounted by app.ts as a bolt-on; no core module imports it. With
 *   `advertising.enabled = false` every public/advertiser endpoint answers
 *   404 `module_disabled` (the app hides the Deals tab) and core is untouched.
 * - Advertisers start fully admin-managed; the self-serve endpoints exist for a
 *   future dashboard but stay off until `advertising.selfServeEnabled`.
 * - Distinct from Section 16 technician boosts, which rank a technician's own
 *   listing and are sold through the payments layer.
 */
export function advertisingModule(): Router {
  const router = Router();

  const whenEnabled = async (_req: Request, _res: Response, next: NextFunction) => {
    if (!(await adsEnabled())) return next(new HttpError(404, 'The Marketplace is switched off', 'module_disabled'));
    next();
  };
  /** Ad tracking is best-effort: a failure here never fails the request. */
  const track = (ids: string[], kind: 'impression' | 'click') =>
    recordAdEvent(ids, kind).catch((err) => logger.warn({ err }, 'ad tracking failed'));

  // ------------------------------------------------------------ public
  router.get('/marketplace/status', authenticate, requireUser(), async (_req, res) => {
    const s = await getSetting('advertising');
    res.json({ enabled: s.enabled, selfServe: s.selfServeEnabled });
  });

  const DealsQuery = z.object({
    categoryId: z.coerce.number().int().positive().optional(),
    segment: z.enum(SERVICE_SEGMENTS).optional(),
  });

  /** The Deals tab: featured verified sellers and relevant brand cards. */
  router.get('/marketplace/deals', authenticate, requireUser(), whenEnabled, async (req, res) => {
    const q = parse(DealsQuery, req.query);
    const [featured, brands, sellers] = await Promise.all([
      featuredSellers({ categoryId: q.categoryId, limit: 6 }),
      brandCards({ categoryId: q.categoryId, segment: q.segment, limit: 6 }),
      organicSellers('', q.categoryId, 20),
    ]);
    await track([...featured, ...brands].map((a) => a.id), 'impression');
    res.json({
      featuredSellers: featured.map((a) => ({ ...a, sponsored: true, label: 'Featured' })),
      brandCards: brands.map((a) => ({ ...a, sponsored: true, label: 'Sponsored' })),
      verifiedSellers: sellers,
    });
  });

  const SearchQuery = z.object({
    q: z.string().trim().max(80).default(''),
    categoryId: z.coerce.number().int().positive().optional(),
  });

  /** Seller search: organic verified-registry results with capped, labeled sponsored slots. */
  router.get('/marketplace/search', authenticate, requireUser(), whenEnabled, async (req, res) => {
    const q = parse(SearchQuery, req.query);
    const { organicPerSponsored } = await getSetting('advertising');
    const organic = await organicSellers(q.q, q.categoryId, 50);
    const sponsored = await sponsoredForSearch(q.q, q.categoryId, Math.floor(organic.length / organicPerSponsored));
    const results = interleave(organic, sponsored, organicPerSponsored);
    await track(results.filter((r) => r.sponsored).map((r) => (r.item as { id: string }).id), 'impression');
    res.json({ results, organicCount: organic.length, organicPerSponsored });
  });

  router.post('/marketplace/ads/:id/click', authenticate, requireUser(), whenEnabled, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const ad = await one(`SELECT id, click_url FROM ad_campaigns WHERE id = $1 AND status = 'active'`, [id]);
    if (!ad) throw notFound('Campaign');
    await track([id], 'click');
    res.json({ clickUrl: ad.click_url });
  });

  // ------------------------------------------------------------ advertiser (read-only until self-serve)
  const advertiser = [authenticate, requireUser('advertiser'), whenEnabled];

  router.get('/advertiser/campaigns', ...advertiser, async (req, res) => {
    const campaigns = await query(
      `SELECT id, title, placement, status, pricing_model, rate_minor, budget_minor, spent_minor, currency, impressions, clicks,
              starts_at, ends_at, review_note, managed_by_admin, created_at
         FROM ad_campaigns
        WHERE advertiser_id = $1 OR seller_id IN (SELECT id FROM spare_parts_sellers WHERE user_id = $1)
        ORDER BY created_at DESC`,
      [currentUser(req).id],
    );
    res.json({ campaigns, selfServe: (await getSetting('advertising')).selfServeEnabled });
  });

  router.get('/advertiser/campaigns/:id/stats', ...advertiser, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const own = await one(
      `SELECT id FROM ad_campaigns WHERE id = $1 AND (advertiser_id = $2 OR seller_id IN (SELECT id FROM spare_parts_sellers WHERE user_id = $2))`,
      [id, currentUser(req).id],
    );
    if (!own) throw notFound('Campaign');
    res.json({ stats: await campaignStats(id) });
  });

  const selfServe = async (_req: Request, _res: Response, next: NextFunction) => {
    if (!(await getSetting('advertising')).selfServeEnabled) {
      return next(new HttpError(403, 'Campaigns are set up by our team for now — contact us to advertise', 'self_serve_disabled'));
    }
    next();
  };

  const CampaignBody = z.object({
    title: z.string().trim().min(3).max(80),
    body: z.string().max(280).optional(),
    placement: z.enum(['featured_seller', 'brand_card', 'sponsored_search']).default('brand_card'),
    sellerId: z.uuid().optional(),
    creativeFileId: z.uuid().optional(),
    clickUrl: z.url().optional(),
    targetCategoryIds: z.array(z.number().int().positive()).max(20).default([]),
    targetSegment: z.enum(SERVICE_SEGMENTS).optional(),
    searchKeywords: z.array(z.string().trim().min(2).max(40)).max(20).default([]),
    budgetMinor: z.number().int().min(0).default(0),
    currency: z.string().length(3).toUpperCase(),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
  });
  type CampaignInput = z.infer<typeof CampaignBody>;

  async function insertCampaign(b: CampaignInput, owner: { advertiserId: string | null; createdBy: string; managedByAdmin: boolean; status: string }) {
    if (b.placement === 'featured_seller') {
      if (!b.sellerId) throw badRequest('Featured seller cards need a seller from the verified registry');
      const seller = await one('SELECT status FROM spare_parts_sellers WHERE id = $1', [b.sellerId]);
      if (seller?.status !== 'verified') throw badRequest('Only verified registry sellers can be featured');
    }
    if (!owner.advertiserId && !b.sellerId) throw badRequest('A campaign needs an advertiser or a registry seller');
    const price = await slotPrice(b.placement as Placement, b.currency);
    return one(
      `INSERT INTO ad_campaigns (advertiser_id, seller_id, title, body, placement, creative_file_id, click_url, target_category_ids, target_segment,
                                 search_keywords, budget_minor, currency, starts_at, ends_at, pricing_model, rate_minor, managed_by_admin, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::ad_status) RETURNING *`,
      [
        owner.advertiserId,
        b.sellerId ?? null,
        b.title,
        b.body ?? null,
        b.placement,
        b.creativeFileId ?? null,
        b.clickUrl ?? null,
        b.targetCategoryIds,
        b.targetSegment ?? null,
        b.searchKeywords.map((k) => k.toLowerCase()),
        b.budgetMinor,
        b.currency,
        b.startsAt ?? null,
        b.endsAt ?? null,
        price.model,
        price.rateMinor,
        owner.managedByAdmin,
        owner.createdBy,
        owner.status,
      ],
    );
  }

  router.post('/advertiser/campaigns', ...advertiser, selfServe, async (req, res) => {
    const b = parse(CampaignBody, req.body);
    const me = currentUser(req).id;
    if (b.sellerId) {
      const mine = await one('SELECT 1 FROM spare_parts_sellers WHERE id = $1 AND user_id = $2', [b.sellerId, me]);
      if (!mine) throw badRequest('That seller is not linked to your account');
    }
    const campaign = await insertCampaign(b, { advertiserId: me, createdBy: me, managedByAdmin: false, status: 'pending_review' });
    res.status(201).json({ campaign });
  });

  const ADVERTISER_TRANSITIONS: Record<string, string[]> = {
    draft: ['pending_review'],
    rejected: ['pending_review'],
    active: ['paused', 'ended'],
    paused: ['active', 'ended'],
  };
  router.post('/advertiser/campaigns/:id/status', ...advertiser, selfServe, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const { status } = parse(z.object({ status: z.enum(['pending_review', 'paused', 'active', 'ended']) }), req.body);
    const ad = await one('SELECT * FROM ad_campaigns WHERE id = $1 AND advertiser_id = $2', [id, currentUser(req).id]);
    if (!ad) throw notFound('Campaign');
    if (!ADVERTISER_TRANSITIONS[ad.status]?.includes(status)) throw conflict(`Cannot move campaign from ${ad.status} to ${status}`);
    res.json({ campaign: await one('UPDATE ad_campaigns SET status = $2 WHERE id = $1 RETURNING *', [id, status]) });
  });

  // ------------------------------------------------------------ admin (works while the module is off, to prepare campaigns)
  const admin = [authenticate, requireUser('admin')];

  router.get('/admin/ads/campaigns', ...admin, async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(['draft', 'pending_review', 'active', 'paused', 'rejected', 'ended']).optional(),
        placement: z.enum(['featured_seller', 'brand_card', 'sponsored_search']).optional(),
      }),
      req.query,
    );
    const campaigns = await query(
      `SELECT a.*, u.company_name AS advertiser_name, s.name AS seller_name, s.status AS seller_status
         FROM ad_campaigns a LEFT JOIN users u ON u.id = a.advertiser_id LEFT JOIN spare_parts_sellers s ON s.id = a.seller_id
        WHERE ($1::ad_status IS NULL OR a.status = $1) AND ($2::ad_placement IS NULL OR a.placement = $2)
        ORDER BY (a.status = 'pending_review') DESC, a.created_at DESC LIMIT 200`,
      [q.status ?? null, q.placement ?? null],
    );
    const s = await getSetting('advertising');
    res.json({ campaigns, enabled: s.enabled, selfServe: s.selfServeEnabled, pricing: s.pricing });
  });

  /** Manual upload: admin creates a campaign for an advertiser account or directly for a registry seller. */
  router.post('/admin/ads/campaigns', ...admin, async (req, res) => {
    const b = parse(CampaignBody.extend({ advertiserId: z.uuid().optional(), activate: z.boolean().default(true) }), req.body);
    if (b.advertiserId) {
      const adv = await one(`SELECT 1 FROM users WHERE id = $1 AND role = 'advertiser'`, [b.advertiserId]);
      if (!adv) throw badRequest('advertiserId must be an advertiser account');
    }
    const campaign = await insertCampaign(b, {
      advertiserId: b.advertiserId ?? null,
      createdBy: currentUser(req).id,
      managedByAdmin: true,
      status: b.activate ? 'active' : 'draft',
    });
    res.status(201).json({ campaign });
  });

  const EditBody = z.object({
    title: z.string().trim().min(3).max(80).optional(),
    body: z.string().max(280).nullable().optional(),
    clickUrl: z.url().nullable().optional(),
    targetCategoryIds: z.array(z.number().int().positive()).max(20).optional(),
    searchKeywords: z.array(z.string().trim().min(2).max(40)).max(20).optional(),
    budgetMinor: z.number().int().min(0).optional(),
    rateMinor: z.number().int().min(0).optional(),
    pricingModel: z.enum(['flat_daily', 'cpm', 'cpc']).optional(),
    startsAt: z.iso.datetime().nullable().optional(),
    endsAt: z.iso.datetime().nullable().optional(),
  });
  router.patch('/admin/ads/campaigns/:id', ...admin, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const b = parse(EditBody, req.body);
    const cols: Record<string, unknown> = {
      title: b.title,
      body: b.body,
      click_url: b.clickUrl,
      target_category_ids: b.targetCategoryIds,
      search_keywords: b.searchKeywords?.map((k) => k.toLowerCase()),
      budget_minor: b.budgetMinor,
      rate_minor: b.rateMinor,
      pricing_model: b.pricingModel,
      starts_at: b.startsAt,
      ends_at: b.endsAt,
    };
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!entries.length) throw badRequest('Nothing to change');
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const campaign = await one(`UPDATE ad_campaigns SET ${sets} WHERE id = $1 RETURNING *`, [id, ...entries.map(([, v]) => v)]);
    if (!campaign) throw notFound('Campaign');
    res.json({ campaign });
  });

  router.post('/admin/ads/campaigns/:id/review', ...admin, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const { decision, note } = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }), req.body);
    const campaign = await one(
      `UPDATE ad_campaigns SET status = $2, review_note = $3 WHERE id = $1 AND status = 'pending_review' RETURNING *`,
      [id, decision === 'approve' ? 'active' : 'rejected', note ?? null],
    );
    if (!campaign) throw conflict('Campaign is not awaiting review');
    res.json({ campaign });
  });

  router.post('/admin/ads/campaigns/:id/status', ...admin, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const { status } = parse(z.object({ status: z.enum(['active', 'paused', 'ended', 'draft']) }), req.body);
    const campaign = await one(`UPDATE ad_campaigns SET status = $2::ad_status WHERE id = $1 AND status <> 'rejected' RETURNING *`, [id, status]);
    if (!campaign) throw notFound('Campaign');
    res.json({ campaign });
  });

  /** Ad revenue analytics: totals by currency and placement, a daily series, and top campaigns. */
  router.get('/admin/ads/analytics', ...admin, async (req, res) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const window = `s.day > current_date - $1::int`;
    const [byPlacement, daily, top] = await Promise.all([
      query(
        `SELECT a.currency, a.placement, sum(s.impressions)::bigint AS impressions, sum(s.clicks)::bigint AS clicks, sum(s.revenue_minor)::bigint AS revenue_minor
           FROM ad_daily_stats s JOIN ad_campaigns a ON a.id = s.campaign_id WHERE ${window}
          GROUP BY a.currency, a.placement ORDER BY a.currency, a.placement`,
        [days],
      ),
      query(
        `SELECT s.day, a.currency, sum(s.impressions)::bigint AS impressions, sum(s.clicks)::bigint AS clicks, sum(s.revenue_minor)::bigint AS revenue_minor
           FROM ad_daily_stats s JOIN ad_campaigns a ON a.id = s.campaign_id WHERE ${window}
          GROUP BY s.day, a.currency ORDER BY s.day`,
        [days],
      ),
      query(
        `SELECT a.id, a.title, a.placement, a.currency, sum(s.impressions)::bigint AS impressions, sum(s.clicks)::bigint AS clicks,
                sum(s.revenue_minor)::bigint AS revenue_minor
           FROM ad_daily_stats s JOIN ad_campaigns a ON a.id = s.campaign_id WHERE ${window}
          GROUP BY a.id ORDER BY sum(s.revenue_minor) DESC LIMIT 10`,
        [days],
      ),
    ]);
    res.json({ days, byPlacement, daily, top });
  });

  /** Advertiser accounts and verified sellers, for the admin campaign form. */
  router.get('/admin/ads/owners', ...admin, async (_req, res) => {
    const [advertisers, sellers] = await Promise.all([
      query(`SELECT id, full_name, company_name FROM users WHERE role = 'advertiser' AND is_active ORDER BY company_name NULLS LAST, full_name LIMIT 500`),
      query(`SELECT id, name, city FROM spare_parts_sellers WHERE status = 'verified' ORDER BY name LIMIT 500`),
    ]);
    res.json({ advertisers, sellers });
  });

  return router;
}
