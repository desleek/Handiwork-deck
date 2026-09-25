import { SERVICE_SEGMENTS } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';

/** Sponsored placements for spare-parts sellers and brands. */
export const adsRouter = Router();
const advertiserOnly = [authenticate, requireUser('advertiser')];

const AdBody = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().max(280).optional(),
  creativeFileId: z.uuid().optional(),
  clickUrl: z.url().optional(),
  targetCategoryIds: z.array(z.number().int().positive()).max(20).default([]),
  targetSegment: z.enum(SERVICE_SEGMENTS).optional(),
  budgetMinor: z.number().int().min(0),
  currency: z.string().length(3).toUpperCase(),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
});

adsRouter.post('/ads', ...advertiserOnly, async (req, res) => {
  const b = parse(AdBody, req.body);
  const ad = await one(
    `INSERT INTO ad_campaigns (advertiser_id, title, body, creative_file_id, click_url, target_category_ids, target_segment,
                               budget_minor, currency, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [currentUser(req).id, b.title, b.body ?? null, b.creativeFileId ?? null, b.clickUrl ?? null, b.targetCategoryIds, b.targetSegment ?? null, b.budgetMinor, b.currency, b.startsAt ?? null, b.endsAt ?? null],
  );
  res.status(201).json({ ad });
});

adsRouter.get('/ads/mine', ...advertiserOnly, async (req, res) => {
  const ads = await query('SELECT * FROM ad_campaigns WHERE advertiser_id = $1 ORDER BY created_at DESC', [currentUser(req).id]);
  res.json({ ads });
});

/** Advertiser-controlled transitions; approval/rejection is an admin action. */
const ADVERTISER_TRANSITIONS: Record<string, string[]> = {
  draft: ['pending_review'],
  rejected: ['pending_review'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
};

adsRouter.post('/ads/:id/status', ...advertiserOnly, async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { status } = parse(z.object({ status: z.enum(['pending_review', 'paused', 'active', 'ended']) }), req.body);
  const ad = await one('SELECT * FROM ad_campaigns WHERE id = $1 AND advertiser_id = $2', [id, currentUser(req).id]);
  if (!ad) throw notFound('Campaign');
  if (!ADVERTISER_TRANSITIONS[ad.status]?.includes(status)) throw conflict(`Cannot move campaign from ${ad.status} to ${status}`);
  const updated = await one('UPDATE ad_campaigns SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
  res.json({ ad: updated });
});

const PlacementQuery = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  segment: z.enum(SERVICE_SEGMENTS).optional(),
  limit: z.coerce.number().int().min(1).max(5).default(3),
});

/** Ads to show in the app (e.g. on a category page or job detail). Counts an impression each. */
adsRouter.get('/ads/placements', authenticate, requireUser(), async (req, res) => {
  const q = parse(PlacementQuery, req.query);
  const ads = await query(
    `UPDATE ad_campaigns SET impressions = impressions + 1
      WHERE id IN (
        SELECT a.id FROM ad_campaigns a
         WHERE a.status = 'active'
           AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at > now())
           AND (a.budget_minor = 0 OR a.spent_minor < a.budget_minor)
           AND (cardinality(a.target_category_ids) = 0 OR $1::int = ANY(a.target_category_ids))
           AND (a.target_segment IS NULL OR $2::service_segment IS NULL OR a.target_segment = $2)
         ORDER BY random() LIMIT $3)
      RETURNING id, title, body, click_url, (SELECT url FROM files f WHERE f.id = creative_file_id) AS image_url`,
    [q.categoryId ?? null, q.segment ?? null, q.limit],
  );
  res.json({ ads });
});

adsRouter.post('/ads/:id/click', authenticate, requireUser(), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const ad = await one(`UPDATE ad_campaigns SET clicks = clicks + 1 WHERE id = $1 AND status = 'active' RETURNING click_url`, [id]);
  if (!ad) throw notFound('Campaign');
  res.json({ clickUrl: ad.click_url });
});
