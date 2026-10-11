import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.ts';
import { clickThroughRate, priceCampaign } from '../domain/ads.ts';
import { badRequest, conflict, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { campaignStats } from '../services/ads.ts';
import { startPayment } from '../services/payments/escrow.ts';
import { getSettings } from '../services/settings.ts';

/**
 * Advertiser API (Section 12). The spec starts advertising fully admin-managed; this is the
 * self-serve path the data model was designed to support. Advertiser accounts are created by an
 * admin, submissions go to admin review, and payment is only taken once a campaign is approved.
 */
export const advertiser = Router();
advertiser.use(authenticate, requireUser('advertiser'));

const uuid = z.string().uuid();

advertiser.get('/campaigns', async (req, res) => {
  const rows = await query<any>(
    `SELECT c.*, (SELECT json_agg(cr.* ORDER BY cr.created_at DESC) FROM ad_creatives cr WHERE cr.campaign_id = c.id) AS creatives
       FROM ad_campaigns c WHERE c.advertiser_id = $1 ORDER BY c.created_at DESC`,
    [req.user!.id],
  );
  const stats = await campaignStats(rows.map((r) => r.id));
  res.json(rows.map((r) => {
    const st = stats.get(r.id) ?? { impressions: 0, clicks: 0 };
    return { ...r, ...st, ctrPct: clickThroughRate(st.impressions, st.clicks) };
  }));
});

const Submission = z.object({
  name: z.string().trim().min(2).max(100),
  placement: z.enum(['deals_featured', 'deals_brand', 'sponsored_search']),
  targetCategoryIds: z.array(uuid).max(20).default([]),
  startsAt: z.coerce.date(),
  days: z.number().int().positive(),
  creative: z.object({
    title: z.string().trim().min(2).max(80),
    body: z.string().trim().max(200).optional(),
    imageUrl: z.string().url(),
    clickUrl: z.string().url().optional(),
  }),
});

advertiser.post('/campaigns', async (req, res) => {
  const b = parse(Submission, req.body);
  const s = await getSettings();
  const priced = priceCampaign(b.placement, b.days, s.adSlotPricePerDayMinor, s.adMaxCampaignDays);
  if ('error' in priced) throw badRequest(priced.error, `Campaigns run for 1–${s.adMaxCampaignDays} days`);
  if (b.startsAt.getTime() < Date.now() - 3_600_000) throw badRequest('START_IN_PAST', 'Choose a start date in the future');
  const profile = await one<{ seller_id: string | null }>('SELECT seller_id FROM advertiser_profiles WHERE user_id = $1', [req.user!.id]);
  const endsAt = new Date(b.startsAt.getTime() + b.days * 86_400_000);
  const c = await tx(async (db) => {
    const camp = await one(
      `INSERT INTO ad_campaigns (advertiser_id, seller_id, name, placement, target_category_ids, slot_price_minor, days, price_minor,
          starts_at, ends_at, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_review', now()) RETURNING *`,
      [req.user!.id, profile?.seller_id ?? null, b.name, b.placement, b.targetCategoryIds, s.adSlotPricePerDayMinor[b.placement], b.days, priced.priceMinor, b.startsAt, endsAt],
      db,
    );
    await query(`INSERT INTO ad_creatives (campaign_id, title, body, image_url, click_url) VALUES ($1,$2,$3,$4,$5)`, [
      camp.id, b.creative.title, b.creative.body ?? null, b.creative.imageUrl, b.creative.clickUrl ?? null,
    ], db);
    return camp;
  });
  res.status(201).json(c);
});

/** Pay for an approved campaign (card, transfer, USSD or wallet) through the shared payment layer. */
advertiser.post('/campaigns/:id/pay', async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['card', 'bank_transfer', 'ussd', 'wallet']) }), req.body);
  const c = await one<any>('SELECT * FROM ad_campaigns WHERE id = $1 AND advertiser_id = $2', [parse(uuid, req.params.id), req.user!.id]);
  if (!c) throw notFound('Campaign');
  if (c.status !== 'approved') throw conflict('NOT_APPROVED', c.status === 'pending_review' ? 'This campaign is still being reviewed' : `Campaign is ${c.status}`);
  if (c.payment_status !== 'unpaid') throw conflict('ALREADY_PAID', 'This campaign is already paid');
  const s = await getSettings();
  const payment = await startPayment({
    payer: req.user!,
    purpose: 'ad_campaign',
    amountMinor: c.price_minor,
    currency: s.currency,
    channel: b.channel,
    description: `Ad campaign: ${c.name}`,
    metadata: { campaignId: c.id },
  });
  res.status(201).json(payment);
});

advertiser.post('/campaigns/:id/pause', async (req, res) => {
  const b = parse(z.object({ paused: z.boolean() }), req.body);
  const r = await one(
    `UPDATE ad_campaigns SET status = $3, updated_at = now()
      WHERE id = $1 AND advertiser_id = $2 AND status IN ('active', 'paused') RETURNING id, status`,
    [parse(uuid, req.params.id), req.user!.id, b.paused ? 'paused' : 'approved'],
  );
  if (!r) throw notFound('Running campaign');
  res.json(r);
});
